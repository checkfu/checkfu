import type * as Schema from "effect/Schema"
import type { McpCaller } from "../Pi/PiMcpCaller.ts"
import {
	MAX_MCP_RESPONSE_BYTES,
	MCP_CREDENTIAL_EMPTY,
	MCP_CREDENTIAL_ENDED,
	mcpCallScope,
} from "../Pi/PiMcpTypes.ts"
import type {
	McpCallOutcome,
	McpCallScope,
	McpExit,
	McpListOutcome,
	McpToolDescriptor,
} from "../Pi/PiMcpTypes.ts"
import { scrubValue } from "./Scrub.ts"
import type { HeldSecret, PutMode, PutOutcome, SecretCustody } from "./SecretCustody.ts"

export const MAX_VAULT_MCP_CLIENTS = 128

export const VAULT_MCP_IDLE_MS = 15 * 60 * 1000

const MAX_EARLY_CANCELS = 256

export const makeVaultMcp = (
	custody: Pick<SecretCustody, "read" | "ended">,
	fetchFn?: typeof fetch,
) => {
	let caller: McpCaller | undefined
	const loaded = async (): Promise<McpCaller> => {
		const { makeMcpCaller } = await import("../Pi/PiMcpCaller.ts")
		caller ??= makeMcpCaller({
			capacity: MAX_VAULT_MCP_CLIENTS,
			idleMs: VAULT_MCP_IDLE_MS,
			...(fetchFn === undefined ? {} : { fetch: fetchFn }),
		})
		return caller
	}
	const running = new Map<string, AbortController>()
	const early = new Set<string>()

	const exitOf =
		(credentialId: string): McpExit =>
		(url) => {
			const held = custody.read(credentialId)
			if (held === null) {
				return {
					refused: custody.ended(credentialId) ? MCP_CREDENTIAL_ENDED : MCP_CREDENTIAL_EMPTY,
				}
			}
			return held.target === url
				? { token: held.secret.token }
				: { refused: "This connection is for a different MCP server." }
		}

	const answered = async (
		credentialId: string,
		sessionKey: string,
		url: string,
		limit: number,
		callId: string,
		ask: (
			client: McpCaller,
			key: string,
			peer: { readonly url: string; readonly exit: McpExit },
			scope: McpCallScope,
		) => Promise<McpListOutcome | McpCallOutcome>,
	): Promise<Schema.Json> => {
		const exit = exitOf(credentialId)
		const abort = new AbortController()
		if (early.delete(callId)) {
			abort.abort()
		}
		const scope = mcpCallScope(0, limit, abort.signal)
		running.set(callId, abort)
		let outcome: McpListOutcome | McpCallOutcome
		try {
			const refusal = exit(URL.canParse(url) ? new URL(url).href : url, scope)
			outcome =
				"refused" in refusal
					? { ok: false, message: refusal.refused }
					: await ask(await loaded(), `${sessionKey}\n${credentialId}`, { url, exit }, scope)
		} catch (error) {
			outcome = { ok: false, message: `The MCP server request failed: ${String(error)}` }
		} finally {
			running.delete(callId)
		}
		const held = custody.read(credentialId)
		return scrubValue([...scope.sent, ...(held === null ? [] : [held.secret.token])])(outcome)
	}

	return {
		list: (
			credentialId: string,
			sessionKey: string,
			url: string,
			limit: number,
			callId: string,
		): Promise<Schema.Json> =>
			answered(credentialId, sessionKey, url, limit, callId, (client, key, peer, scope) =>
				client.list(key, peer, scope),
			),
		call: (
			credentialId: string,
			sessionKey: string,
			url: string,
			tool: McpToolDescriptor,
			args: Schema.JsonObject,
			callId: string,
		): Promise<Schema.Json> =>
			answered(
				credentialId,
				sessionKey,
				url,
				MAX_MCP_RESPONSE_BYTES,
				callId,
				(client, key, peer, scope) => client.call(key, peer, scope, tool, args),
			),
		cancel: (callId: string): void => {
			const abort = running.get(callId)
			if (abort !== undefined) {
				abort.abort()
				return
			}
			early.add(callId)
			if (early.size > MAX_EARLY_CANCELS) {
				const [oldest] = early
				if (oldest !== undefined) {
					early.delete(oldest)
				}
			}
		},
		drop: async (credentialId?: string): Promise<void> => {
			await caller?.drop((key) => credentialId === undefined || key.endsWith(`\n${credentialId}`))
		},
	}
}

export type VaultMcp = ReturnType<typeof makeVaultMcp>

export const makeVaultConnection = (custody: SecretCustody, mcp: VaultMcp) => ({
	put: async (
		credentialId: string,
		secret: HeldSecret,
		target: string,
		mode: PutMode,
	): Promise<PutOutcome> => {
		const outcome = custody.put(credentialId, secret, target, mode)
		if (mode === "replace" && outcome.refused === null) {
			await mcp.drop(credentialId)
		}
		return outcome
	},
	erase: async (credentialId: string): Promise<void> => {
		custody.erase(credentialId)
		await mcp.drop(credentialId)
	},
	seal: async (): Promise<void> => {
		custody.seal()
		await mcp.drop()
	},
})
