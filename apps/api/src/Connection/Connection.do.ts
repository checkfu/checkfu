import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import type { McpToolDescriptor } from "../Pi/PiMcpTypes.ts"
import { makeSecretCustody } from "./SecretCustody.ts"
import type { HeldSecret, PutMode, PutOutcome } from "./SecretCustody.ts"
import { makeVaultConnection, makeVaultMcp } from "./VaultMcp.ts"

export class Connection extends Cloudflare.DurableObject<Connection>()(
	"Connection",
	Effect.map(Cloudflare.DurableObjectState, (state) => {
		const { storage } = state.raw
		let made: ReturnType<typeof makeSecretCustody> | undefined
		const custody = () =>
			(made ??= makeSecretCustody({
				exec: (query, ...bindings) => storage.sql.exec(query, ...bindings),
				transaction: (run) => storage.transactionSync(run),
			}))
		let mcpMade: ReturnType<typeof makeVaultMcp> | undefined
		const mcp = () => (mcpMade ??= makeVaultMcp(custody()))
		let connectionMade: ReturnType<typeof makeVaultConnection> | undefined
		const connection = () => (connectionMade ??= makeVaultConnection(custody(), mcp()))
		return Effect.succeed({
			putSecret: (
				credentialId: string,
				secret: HeldSecret,
				target: string,
				mode: PutMode,
			): Effect.Effect<PutOutcome> =>
				Effect.promise(() => connection().put(credentialId, secret, target, mode)),
			eraseSecret: (credentialId: string): Effect.Effect<void> =>
				Effect.promise(() => connection().erase(credentialId)),
			seal: (): Effect.Effect<void> => Effect.promise(() => connection().seal()),
			mcpList: (
				credentialId: string,
				sessionKey: string,
				url: string,
				limit: number,
				callId: string,
			): Effect.Effect<Schema.Json> =>
				Effect.promise(() => mcp().list(credentialId, sessionKey, url, limit, callId)),
			mcpCall: (
				credentialId: string,
				sessionKey: string,
				url: string,
				tool: McpToolDescriptor,
				args: Schema.JsonObject,
				callId: string,
			): Effect.Effect<Schema.Json> =>
				Effect.promise(() => mcp().call(credentialId, sessionKey, url, tool, args, callId)),
			mcpCancel: (callId: string): Effect.Effect<void> => Effect.sync(() => mcp().cancel(callId)),
		})
	}),
) {}
