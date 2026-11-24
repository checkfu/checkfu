import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import { makeApiUpstream } from "./ApiUpstream.ts"
import type { ApiCallOutcome } from "./ApiUpstream.ts"
import { Connection } from "./Connection.ts"
import type { ConnectionShape } from "./Connection.ts"
import type { ConnectionProxy } from "./ConnectionProxy.ts"
import type { McpTarget } from "./McpTools.ts"
import { makeSecretCustody } from "./SecretCustody.ts"

export const ConnectionLive = Connection.make(
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
			const baseUrl = custody.target()
			const held = custody.read()
			// Only an API key is ever sent to an API.
			return baseUrl === null || held === null || held.type !== "api_key"
				? null
				: { baseUrl, key: { token: held.token, placement: held.placement } }
		})
		return Effect.succeed<ConnectionShape>({
			alarm: () => Effect.promise(() => custody.expire()),
			storeSecret: (secret, target) => Effect.promise(() => custody.store(secret, target)),
			replaceSecret: (secret) => Effect.promise(() => custody.replace(secret)),
			keepSecret: () => Effect.promise(() => custody.keep()),
			erase: () => Effect.promise(() => custody.erase()),
			forward: (request) => Effect.promise(async () => (await outbound()).forward(request)),
			// What the last refresh came to, until the API has recorded it on the credential: only the
			// API Worker reaches the domain, so it asks after each turn and on each read.
			refreshReport: () => Effect.sync(() => (custody.unreported() ? custody.report() : null)),
			acknowledgeRefresh: (refreshes) => Effect.sync(() => custody.reported(refreshes)),
			callApi: (baseUrl, request) =>
				Effect.promise((): Promise<ApiCallOutcome> => api.call(baseUrl, request)),
			forwardOpen: (request) =>
				Effect.promise(async () => {
					const { makeConnectionProxy } = await import("./ConnectionProxy.ts")
					return makeConnectionProxy(() => ({ url: request.url, auth: null })).forward(request)
				}),
			callOpenApi: (baseUrl, request) =>
				Effect.promise(() =>
					makeApiUpstream(() => ({ baseUrl, key: null })).call(baseUrl, request),
				),
		})
	}),
)
