import { MAX_MCP_SERVERS, mcpHostAllowed } from "@checkfu/domain/Mcp/McpServers"
import type { AgentTool, McpServerBinding } from "@checkfu/domain/Mcp/McpServers"
import type { Extension } from "@earendil-works/pi-durable"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
	MAX_TOOL_LIST_BYTES,
	cacheableTools,
	cachedTools,
	mcpExtension,
	mcpRegistry,
	withinCatalog,
} from "./PiMcp.ts"
import type { McpDispatch, McpRegistry, McpServerTools } from "./PiMcp.ts"
import type { McpCaller, McpPeer } from "./PiMcpCaller.ts"
import {
	MAX_MCP_RESPONSE_BYTES,
	MCP_CREDENTIAL_ENDED,
	McpCallOutcome,
	McpListOutcome,
	mcpCallScope,
} from "./PiMcpTypes.ts"
import type { McpFailure, McpToolDescriptor } from "./PiMcpTypes.ts"
import { MCP_TURN_KEY, McpTurn } from "./PiTurn.ts"

const Brought = Schema.Struct({ turn: Schema.Finite, ...McpTurn.fields })
const broughtJson = Schema.fromJsonString(Brought)
const encodeBrought = Schema.encodeSync(broughtJson)
const decodeBrought = Schema.decodeOption(broughtJson)
const toolsKey = (server: string) => `mcp-tools:${server}`
const unavailableKey = (server: string) => `mcp-unavailable:${server}`

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
): SessionVaults => {
	const asked = async <A>(
		vaultId: string,
		signal: AbortSignal | undefined,
		decode: (answer: Schema.Json) => Option.Option<A>,
		ask: (vault: VaultMcpRemote, callId: string) => Promise<Schema.Json>,
	): Promise<A | McpFailure> => {
		if (signal?.aborted === true) {
			return INTERRUPTED
		}
		const vault = remote(vaultId)
		const callId = crypto.randomUUID()
		const answered = ask(vault, callId).then(
			(answer): A | McpFailure => Option.getOrElse(decode(answer), unreadable),
			unreached,
		)
		if (signal === undefined) {
			return answered
		}
		const { promise: gaveUp, resolve } = Promise.withResolvers<McpFailure>()
		const giveUp = () => {
			vault.mcpCancel(callId).catch(() => undefined)
			resolve(INTERRUPTED)
		}
		signal.addEventListener("abort", giveUp, { once: true })
		try {
			return await Promise.race([answered, gaveUp])
		} finally {
			signal.removeEventListener("abort", giveUp)
		}
	}
	return {
		list: (vaultId, credentialId, url, limit, signal) =>
			asked(vaultId, signal, decodeList, (vault, callId) =>
				vault.mcpList(credentialId, sessionKey, url, limit, callId),
			),
		call: (vaultId, credentialId, url, tool, args, signal) =>
			asked(vaultId, signal, decodeCall, (vault, callId) =>
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
}) => {
	const { kv } = options
	const unreachable = new Map<string, string>()

	const brought = (): typeof Brought.Type | undefined =>
		Option.getOrUndefined(Option.flatMap(Option.fromNullishOr(kv.get(MCP_TURN_KEY)), decodeBrought))
	const current = (): McpTurn => brought() ?? { servers: [], networking: null }

	const refusal = (
		binding: McpServerBinding,
		turn: number,
		signal: AbortSignal | undefined,
	): string | undefined => {
		if (options.admittedTurn() !== turn) {
			return "This turn is no longer the session's current one, so the request was not sent."
		}
		const { host } = new URL(binding.url)
		if (!mcpHostAllowed(current().networking, host)) {
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

	const toolsOf = (server: string): McpServerTools | undefined => {
		const text = kv.get(toolsKey(server))
		if (text !== undefined) {
			return cachedTools(text)
		}
		const reason = kv.get(unavailableKey(server))
		return reason === undefined ? undefined : { status: "unavailable", reason }
	}

	const listed = async (
		binding: McpServerBinding,
		turn: number,
		signal: AbortSignal | undefined,
	): Promise<McpListOutcome> => {
		const refused = refusal(binding, turn, signal)
		if (refused !== undefined) {
			return { ok: false, message: refused }
		}
		if (binding.credential_id === null) {
			const scope = mcpCallScope(turn, MAX_TOOL_LIST_BYTES, signal)
			return (await loaded()).list(binding.name, peerOf(binding), scope)
		}
		return binding.vault_id === null
			? { ok: false, message: MCP_CREDENTIAL_ENDED }
			: options.vaults.list(
					binding.vault_id,
					binding.credential_id,
					binding.url,
					MAX_TOOL_LIST_BYTES,
					signal,
				)
	}

	const list = async (
		binding: McpServerBinding,
		turn: number,
		signal: AbortSignal | undefined,
	): Promise<void> => {
		const outcome = await listed(binding, turn, signal)
		if (signal?.aborted === true) {
			return
		}
		const kept = cacheableTools(outcome)
		if ("text" in kept) {
			unreachable.delete(binding.name)
			kv.put(toolsKey(binding.name), kept.text)
		} else if (kept.retry) {
			unreachable.set(binding.name, kept.unavailable)
		} else {
			kv.put(unavailableKey(binding.name), kept.unavailable)
		}
	}

	const servers = () =>
		withinCatalog(
			current().servers.map((binding) => ({
				binding,
				tools: toolsOf(binding.name) ?? {
					status: "unavailable" as const,
					reason: unreachable.get(binding.name) ?? "it has not been reached yet",
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
		return binding.vault_id === null
			? { ok: false, message: MCP_CREDENTIAL_ENDED }
			: options.vaults.call(
					binding.vault_id,
					binding.credential_id,
					binding.url,
					tool,
					args,
					signal,
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
			const text = encodeBrought({ turn, ...mcp })
			if (kv.get(MCP_TURN_KEY) !== text) {
				kv.put(MCP_TURN_KEY, text)
			}
			return true
		},
		undiscovered: (): boolean =>
			current().servers.some((binding) => toolsOf(binding.name) === undefined),
		discover: async (turn: number, signal?: AbortSignal): Promise<void> => {
			const kept = brought()
			if (kept === undefined || kept.turn !== turn) {
				return
			}
			const missing = kept.servers.filter((binding) => toolsOf(binding.name) === undefined)
			await Promise.all(missing.map((binding) => list(binding, turn, signal)))
		},
	}
}

export type SessionMcp = ReturnType<typeof makeSessionMcp>
