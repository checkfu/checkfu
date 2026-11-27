import { MAX_MCP_SERVERS, McpServerBinding, mcpHostAllowed } from "@checkfu/domain/Mcp/McpServers"
import type { AgentTool } from "@checkfu/domain/Mcp/McpServers"
import type { Extension } from "@earendil-works/pi-durable"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { CredentialAccess } from "../Api.ts"
import {
	MAX_TOOL_LIST_BYTES,
	cacheableTools,
	mcpExtension,
	mcpRegistry,
	withinCatalog,
} from "./PiMcp.ts"
import type { McpDispatch, McpRegistry } from "./PiMcp.ts"
import type { McpCaller, McpPeer } from "./PiMcpCaller.ts"
import {
	MAX_MCP_RESPONSE_BYTES,
	MCP_CALL_TIMEOUT_MS,
	MCP_CREDENTIAL_EMPTY,
	MCP_CREDENTIAL_ENDED,
	McpCallOutcome,
	McpListOutcome,
	McpToolDescriptors,
	mcpCallScope,
	withMcpDeadline,
} from "./PiMcpTypes.ts"
import type { McpFailure, McpToolDescriptor } from "./PiMcpTypes.ts"
import { MCP_TURN_KEY, McpTurn } from "./PiTurn.ts"

const MCP_DISCOVERY_RETRY_MS = 300_000
const MCP_SLOW_FAILURE_MS = 5000

const Brought = Schema.Struct({ turn: Schema.Finite, admittedAt: Schema.Finite, ...McpTurn.fields })
const broughtJson = Schema.fromJsonString(Brought)
const encodeBrought = Schema.encodeSync(broughtJson)
const decodeBrought = Schema.decodeOption(broughtJson)
const catalogKey = (server: string) => `mcp-catalog:${server}`
const CatalogEntry = Schema.Struct({
	binding: McpServerBinding,
	turn: Schema.Finite,
	checkedAt: Schema.Finite,
	catalog: Schema.Union([
		Schema.Struct({ status: Schema.Literal("listed"), tools: McpToolDescriptors }),
		Schema.Struct({
			status: Schema.Literal("unavailable"),
			reason: Schema.String,
			retryAt: Schema.NullOr(Schema.Finite),
		}),
	]),
})
const catalogJson = Schema.fromJsonString(CatalogEntry)
const encodeCatalog = Schema.encodeSync(catalogJson)
const decodeCatalog = Schema.decodeOption(catalogJson)
const sameBinding = (a: McpServerBinding, b: McpServerBinding) =>
	a.name === b.name &&
	a.url === b.url &&
	a.vault_id === b.vault_id &&
	a.credential_id === b.credential_id

export interface SessionKv {
	readonly get: (key: string) => string | undefined
	readonly put: (key: string, value: string) => void
}

const INTERRUPTED: McpFailure = {
	ok: false,
	message: "The turn was interrupted before this call finished.",
	interrupted: true,
}

export interface SessionVaults {
	readonly list: (
		vaultId: string,
		credentialId: string,
		url: string,
		limit: number,
		signal: AbortSignal | undefined,
	) => Promise<McpListOutcome>
	readonly call: (
		vaultId: string,
		credentialId: string,
		url: string,
		tool: McpToolDescriptor,
		args: Schema.JsonObject,
		signal: AbortSignal | undefined,
	) => Promise<McpCallOutcome>
}

export interface VaultMcpRemote {
	readonly mcpList: (
		credentialId: string,
		sessionKey: string,
		url: string,
		limit: number,
		callId: string,
	) => Promise<Schema.Json>
	readonly mcpCall: (
		credentialId: string,
		sessionKey: string,
		url: string,
		tool: McpToolDescriptor,
		args: Schema.JsonObject,
		callId: string,
	) => Promise<Schema.Json>
	readonly mcpCancel: (callId: string) => Promise<void>
}

const decodeList = Schema.decodeUnknownOption(McpListOutcome)
const decodeCall = Schema.decodeUnknownOption(McpCallOutcome)
const unreadable = (): McpFailure => ({
	ok: false,
	message: "The MCP server's answer could not be returned.",
})
const unreached = (): McpFailure => ({
	ok: false,
	message: "The MCP server's connection could not be reached.",
})

export const vaultsOver = (
	remote: (vaultId: string) => VaultMcpRemote,
	sessionKey: string,
	authorize: (
		vaultId: string,
		credentialId: string,
		signal: AbortSignal | undefined,
	) => Promise<CredentialAccess>,
): SessionVaults => {
	const asked = async <A>(
		vaultId: string,
		credentialId: string,
		signal: AbortSignal | undefined,
		decode: (answer: Schema.Json) => Option.Option<A>,
		ask: (vault: VaultMcpRemote, callId: string) => Promise<Schema.Json>,
	): Promise<A | McpFailure> => {
		const { promise: gaveUp, resolve } = Promise.withResolvers<McpFailure>()
		let cancel: (() => void) | undefined
		const giveUp = () => {
			cancel?.()
			resolve(INTERRUPTED)
		}
		const perform = async (): Promise<A | McpFailure> => {
			const access = await authorize(vaultId, credentialId, signal)
			if (signal?.aborted === true) {
				return INTERRUPTED
			}
			if (access !== "held") {
				return {
					ok: false,
					message: access === "empty" ? MCP_CREDENTIAL_EMPTY : MCP_CREDENTIAL_ENDED,
				}
			}
			const vault = remote(vaultId)
			const callId = crypto.randomUUID()
			cancel = () => {
				vault.mcpCancel(callId).catch(() => undefined)
			}
			return Option.getOrElse(decode(await ask(vault, callId)), unreadable)
		}
		if (signal?.aborted === true) {
			return INTERRUPTED
		}
		signal?.addEventListener("abort", giveUp, { once: true })
		try {
			return await Promise.race([perform().catch(unreached), gaveUp])
		} finally {
			signal?.removeEventListener("abort", giveUp)
		}
	}
	return {
		list: (vaultId, credentialId, url, limit, signal) =>
			asked(vaultId, credentialId, signal, decodeList, (vault, callId) =>
				vault.mcpList(credentialId, sessionKey, url, limit, callId),
			),
		call: (vaultId, credentialId, url, tool, args, signal) =>
			asked(vaultId, credentialId, signal, decodeCall, (vault, callId) =>
				vault.mcpCall(credentialId, sessionKey, url, tool, args, callId),
			),
	}
}

export const makeSessionMcp = (options: {
	readonly kv: SessionKv
	readonly vaults: SessionVaults
	readonly admittedTurn: () => number
	readonly agentTools: () => ReadonlyArray<AgentTool>
	readonly fetch?: typeof fetch
	readonly now?: () => number
	readonly listTimeoutMs?: number
}) => {
	const { kv, now = Date.now } = options
	const pending = new Map<
		string,
		{
			readonly request: Promise<void>
			readonly admission: string
			readonly signal: AbortSignal | undefined
		}
	>()

	const brought = (): typeof Brought.Type | undefined =>
		Option.getOrUndefined(Option.flatMap(Option.fromNullishOr(kv.get(MCP_TURN_KEY)), decodeBrought))
	const current = (): McpTurn => brought() ?? { servers: [], networking: null }

	const refusal = (
		binding: McpServerBinding,
		turn: number,
		signal: AbortSignal | undefined,
	): string | undefined => {
		const selected = current()
		if (
			options.admittedTurn() !== turn ||
			!selected.servers.some((server) => sameBinding(server, binding))
		) {
			return "This turn is no longer the session's current one, so the request was not sent."
		}
		const { host } = new URL(binding.url)
		if (!mcpHostAllowed(selected.networking, host)) {
			return `The environment's network rules do not allow MCP server "${binding.name}" (${host}).`
		}
		return signal?.aborted === true
			? "The turn was interrupted before this request was sent."
			: undefined
	}

	let local: McpCaller | undefined
	const loaded = async (): Promise<McpCaller> => {
		const { makeMcpCaller } = await import("./PiMcpCaller.ts")
		local ??= makeMcpCaller({
			capacity: MAX_MCP_SERVERS,
			...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		})
		return local
	}
	const peerOf = (binding: McpServerBinding): McpPeer => ({
		url: binding.url,
		exit: (_url, scope) => {
			const refused = refusal(binding, scope.turn, scope.signal)
			return refused === undefined ? { token: null } : { refused }
		},
	})

	const catalogOf = (binding: McpServerBinding): typeof CatalogEntry.Type | undefined => {
		const text = kv.get(catalogKey(binding.name))
		if (text === undefined) {
			return undefined
		}
		const saved = Option.getOrUndefined(decodeCatalog(text))
		return saved !== undefined && sameBinding(binding, saved.binding) ? saved : undefined
	}

	const listed = async (
		binding: McpServerBinding,
		turn: number,
		signal: AbortSignal | undefined,
	): Promise<McpListOutcome> => {
		if (binding.credential_id === null) {
			const scope = mcpCallScope(turn, MAX_TOOL_LIST_BYTES, signal)
			return (await loaded()).list(binding.name, peerOf(binding), scope)
		}
		const { vault_id, credential_id, url } = binding
		return vault_id === null
			? { ok: false, message: MCP_CREDENTIAL_ENDED }
			: withMcpDeadline(
					(deadline) =>
						options.vaults.list(vault_id, credential_id, url, MAX_TOOL_LIST_BYTES, deadline),
					signal,
					options.listTimeoutMs,
				)
	}

	const list = async (
		binding: McpServerBinding,
		turn: number,
		admission: string,
		signal: AbortSignal | undefined,
	): Promise<void> => {
		const refused = refusal(binding, turn, signal)
		const started = now()
		const outcome =
			refused === undefined
				? await listed(binding, turn, signal)
				: { ok: false as const, message: refused }
		if (
			signal?.aborted === true ||
			options.admittedTurn() !== turn ||
			kv.get(MCP_TURN_KEY) !== admission
		) {
			return
		}
		const kept = cacheableTools(outcome)
		const finished = now()
		const slow = refused === undefined && finished - started >= MCP_SLOW_FAILURE_MS
		const catalog: (typeof CatalogEntry.Type)["catalog"] =
			"tools" in kept
				? { status: "listed", tools: kept.tools }
				: {
						status: "unavailable",
						reason: kept.unavailable,
						retryAt: kept.retry ? finished + (slow ? MCP_DISCOVERY_RETRY_MS : 0) : null,
					}
		kv.put(catalogKey(binding.name), encodeCatalog({ binding, turn, checkedAt: finished, catalog }))
	}

	const listOnce = async (
		binding: McpServerBinding,
		turn: typeof Brought.Type,
		admission: string,
		signal?: AbortSignal,
	): Promise<void> => {
		if (
			signal?.aborted === true ||
			options.admittedTurn() !== turn.turn ||
			kv.get(MCP_TURN_KEY) !== admission ||
			!needsListing(binding, turn)
		) {
			return
		}
		const previous = pending.get(binding.name)
		if (previous?.admission === admission && !previous.signal?.aborted) {
			const interrupted = Promise.withResolvers<void>()
			const leave = () => interrupted.resolve()
			signal?.addEventListener("abort", leave, { once: true })
			try {
				await Promise.race([previous.request, interrupted.promise])
			} finally {
				signal?.removeEventListener("abort", leave)
			}
			if (previous.signal?.aborted && !signal?.aborted) {
				await listOnce(binding, turn, admission, signal)
			}
			return
		}
		const request = list(binding, turn.turn, admission, signal)
		pending.set(binding.name, { request, admission, signal })
		try {
			await request
		} finally {
			if (pending.get(binding.name)?.request === request) {
				pending.delete(binding.name)
			}
		}
	}

	const needsListing = (binding: McpServerBinding, turn: typeof Brought.Type): boolean => {
		const entry = catalogOf(binding)
		if (entry === undefined) {
			return true
		}
		if (entry.turn === turn.turn) {
			return false
		}
		const retryAt = entry.catalog.status === "unavailable" ? entry.catalog.retryAt : null
		return turn.admittedAt >= (retryAt ?? entry.checkedAt + MCP_DISCOVERY_RETRY_MS)
	}

	const servers = () =>
		withinCatalog(
			current().servers.map((binding) => ({
				binding,
				tools: catalogOf(binding)?.catalog ?? {
					status: "unavailable" as const,
					reason: "it has not been reached yet",
				},
			})),
		)

	let registry: McpRegistry = mcpRegistry(servers(), options.agentTools())

	const dispatch: McpDispatch = async (binding, tool, args, signal) => {
		const turn = options.admittedTurn()
		const refused = refusal(binding, turn, signal)
		if (refused !== undefined) {
			return { ok: false, message: refused }
		}
		if (binding.credential_id === null) {
			const scope = mcpCallScope(turn, MAX_MCP_RESPONSE_BYTES, signal)
			return (await loaded()).call(binding.name, peerOf(binding), scope, tool, args)
		}
		const { vault_id, credential_id, url } = binding
		return vault_id === null
			? { ok: false, message: MCP_CREDENTIAL_ENDED }
			: withMcpDeadline(
					(deadline) => options.vaults.call(vault_id, credential_id, url, tool, args, deadline),
					signal,
					MCP_CALL_TIMEOUT_MS,
				)
	}

	return {
		extensions: (): ReadonlyArray<Extension> => {
			const kept = servers()
			registry = mcpRegistry(kept, options.agentTools())
			return kept.map(({ binding, tools }) => mcpExtension(binding, tools, registry, dispatch))
		},
		toolOf: (name: string) => registry.toolOf(name),
		publish: (turn: number, mcp: McpTurn): boolean => {
			const kept = brought()
			if (kept !== undefined && kept.turn > turn) {
				return false
			}
			const admittedAt = kept?.turn === turn ? kept.admittedAt : now()
			const text = encodeBrought({ turn, admittedAt, ...mcp })
			if (kv.get(MCP_TURN_KEY) !== text) {
				kv.put(MCP_TURN_KEY, text)
			}
			return true
		},
		undiscovered: (): boolean => {
			const kept = brought()
			return kept?.servers.some((binding) => needsListing(binding, kept)) ?? false
		},
		discover: async (turn: number, signal?: AbortSignal): Promise<void> => {
			const kept = brought()
			if (kept === undefined || kept.turn !== turn) {
				return
			}
			const admission = encodeBrought(kept)
			await Promise.all(kept.servers.map((binding) => listOnce(binding, kept, admission, signal)))
		},
	}
}

export type SessionMcp = ReturnType<typeof makeSessionMcp>
