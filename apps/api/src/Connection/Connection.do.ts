import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import type { HttpRequestDescription } from "../OpenApi/OpenApiTypes.ts"
import { makeApiUpstream } from "./ApiUpstream.ts"
import type { ApiCallOutcome } from "./ApiUpstream.ts"
import type { ConnectionProxy } from "./ConnectionProxy.ts"
import type { ForwardOutcome, ForwardRequest, McpTarget } from "./McpTools.ts"
import { makeSecretCustody } from "./SecretCustody.ts"
import type { CustodyReport, HeldSecret, SecretReplacement } from "./SecretCustody.ts"

const UNAUTHENTICATED = "url:"

/** The connection a session uses for a server: the bound credential's, or the server's own. */
export const connectionName = (binding: {
	readonly url: string
	readonly credential_id: string | null
}): string => binding.credential_id ?? `${UNAUTHENTICATED}${binding.url}`

/**
 * One object per credential, named by the credential's id: the only place the
 * credential's secret exists, the only sender of requests to the MCP server or
 * API it was stored for, and the only one that refreshes its token. Sessions
 * keep their own MCP clients and send through it, so they never share protocol
 * state and never hold the secret. A server used without a credential has an
 * object too, named by its URL, so every request takes the same path.
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
		const target = (auth: McpTarget["auth"]) => (): McpTarget | null => {
			// Read when called: there is no object, and so no name, while the stack is planned.
			const name = state.raw.id.name ?? ""
			if (name.startsWith(UNAUTHENTICATED)) {
				return { url: name.slice(UNAUTHENTICATED.length), auth: null }
			}
			const url = custody.target()
			return url === null ? null : { url, auth }
		}
		// The proxy, and the OAuth refresh it uses, load with the first request, so isolates that
		// never send one skip them. A load that failed is forgotten, so the next request tries again
		// instead of failing for the isolate's whole life.
		let proxy: Promise<ConnectionProxy> | undefined
		const outbound = () => {
			if (proxy === undefined) {
				const loading = Promise.all([
					import("./ConnectionProxy.ts"),
					import("./OAuthRefresh.ts"),
				]).then(([{ makeConnectionProxy }, { makeOAuthRefresher }]) =>
					makeConnectionProxy(
						target(
							makeOAuthRefresher({
								read: custody.read,
								revision: custody.revision,
								write: custody.refreshed,
								exclusive: custody.exclusive,
								resource: custody.target,
								now: () => Date.now(),
								warn: (message) => {
									Effect.runSync(Effect.logWarning(message))
								},
							}),
						),
					),
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
		const api = makeApiUpstream(() => {
			const name = state.raw.id.name ?? ""
			if (name.startsWith(UNAUTHENTICATED)) {
				return { baseUrl: name.slice(UNAUTHENTICATED.length), key: null }
			}
			const baseUrl = custody.target()
			const held = custody.read()
			// Only an API key is ever sent to an API.
			return baseUrl === null || held === null || held.type !== "api_key"
				? null
				: { baseUrl, key: { token: held.token, placement: held.placement } }
		})
		return Effect.succeed({
			alarm: () => Effect.promise(() => custody.expire()),
			storeSecret: (secret: HeldSecret, target: string): Effect.Effect<boolean> =>
				Effect.promise(() => custody.store(secret, target)),
			replaceSecret: (secret: SecretReplacement): Effect.Effect<number | null> =>
				Effect.promise(() => custody.replace(secret)),
			keepSecret: (): Effect.Effect<void> => Effect.promise(() => custody.keep()),
			erase: (): Effect.Effect<void> => Effect.promise(() => custody.erase()),
			forward: (request: ForwardRequest): Effect.Effect<ForwardOutcome> =>
				Effect.promise(async () => (await outbound()).forward(request)),
			// What the last refresh came to, until the API has recorded it on the credential: the
			// harness Worker cannot reach the domain, so the API asks after each turn and on each read.
			refreshReport: (): Effect.Effect<CustodyReport | null> =>
				Effect.sync(() => (custody.unreported() ? custody.report() : null)),
			acknowledgeRefresh: (refreshes: number): Effect.Effect<void> =>
				Effect.sync(() => custody.reported(refreshes)),
			callApi: (baseUrl: string, request: HttpRequestDescription) =>
				Effect.promise((): Promise<ApiCallOutcome> => api.call(baseUrl, request)),
		})
	}),
) {}
