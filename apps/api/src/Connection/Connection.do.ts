import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import type { ConnectionProxy } from "./ConnectionProxy.ts"
import type { ForwardOutcome, ForwardRequest, McpTarget } from "./McpTools.ts"
import { makeSecretCustody } from "./SecretCustody.ts"

const UNAUTHENTICATED = "url:"

/** The connection a session uses for a server: the bound credential's, or the server's own. */
export const connectionName = (binding: {
	readonly url: string
	readonly credential_id: string | null
}): string => binding.credential_id ?? `${UNAUTHENTICATED}${binding.url}`

/**
 * One object per credential, named by the credential's id: the only place the
 * credential's secret exists, and the only sender of requests to the MCP
 * server it was stored for. Sessions keep their own MCP clients and send
 * through it, so they never share protocol state and never hold the secret.
 * A server used without a credential has an object too, named by its URL, so
 * every MCP request takes the same path.
 */
export class Connection extends Cloudflare.DurableObject<Connection>()(
	"Connection",
	Effect.map(Cloudflare.DurableObjectState, (state) => {
		const { storage } = state.raw
		const custody = makeSecretCustody(
			{
				get: (key) => storage.kv.get<string>(key),
				put: (key, value) => {
					storage.kv.put(key, value)
				},
				clear: () => storage.deleteAll(),
				setAlarm: (at) => storage.setAlarm(at),
				deleteAlarm: () => storage.deleteAlarm(),
			},
			() => Date.now(),
		)
		const target = (): McpTarget | null => {
			// Read when called: there is no object, and so no name, while the stack is planned.
			const name = state.raw.id.name ?? ""
			if (name.startsWith(UNAUTHENTICATED)) {
				return { url: name.slice(UNAUTHENTICATED.length), token: null }
			}
			const url = custody.target()
			return url === null ? null : { url, token: custody.read }
		}
		// The proxy loads with the first request, so isolates that never send one skip it. A load
		// that failed is forgotten, so the next request tries again instead of failing for the
		// isolate's whole life.
		let proxy: Promise<ConnectionProxy> | undefined
		const outbound = () => {
			if (proxy === undefined) {
				const loading = import("./ConnectionProxy.ts").then(({ makeConnectionProxy }) =>
					makeConnectionProxy(target),
				)
				proxy = loading
				loading.catch(() => {
					if (proxy === loading) {
						proxy = undefined
					}
				})
			}
			return proxy
		}
		return Effect.succeed({
			alarm: () => Effect.promise(() => custody.expire()),
			storeSecret: (secret: string, mcpServerUrl: string): Effect.Effect<boolean> =>
				Effect.promise(() => custody.store(secret, mcpServerUrl)),
			replaceSecret: (secret: string): Effect.Effect<boolean> =>
				Effect.sync(() => custody.replace(secret)),
			keepSecret: (): Effect.Effect<void> => Effect.promise(() => custody.keep()),
			erase: (): Effect.Effect<void> => Effect.promise(() => custody.erase()),
			forward: (request: ForwardRequest): Effect.Effect<ForwardOutcome> =>
				Effect.promise(async () => (await outbound()).forward(request)),
		})
	}),
) {}
