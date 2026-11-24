import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import { makeApiCatalog } from "./ApiCatalogStore.ts"
import { ApiCatalog } from "./ApiCatalog.ts"
import type { ApiCatalogShape } from "./ApiCatalog.ts"

export const ApiCatalogLive = ApiCatalog.make(
	Effect.map(Cloudflare.DurableObjectState, (state) => {
		const { storage } = state.raw
		const catalog = makeApiCatalog(
			{
				get: (key) => storage.kv.get<string>(key),
				// A key and its value hold up to 8 MB together; a document is at most 2 MiB of UTF-8.
				put: (key, value) => {
					storage.kv.put(key, value)
				},
				clear: () => storage.deleteAll(),
				setAlarm: (at) => storage.setAlarm(at),
				deleteAlarm: () => storage.deleteAlarm(),
			},
			() => Date.now(),
		)
		return Effect.succeed<ApiCatalogShape>({
			alarm: () => Effect.promise(() => catalog.expire()),
			store: (document, config) => Effect.promise(() => catalog.store(document, config)),
			keep: () => Effect.promise(() => catalog.keep()),
			tools: () => Effect.promise(() => catalog.tools()),
			request: (name, args) => Effect.promise(() => catalog.request(name, args)),
		})
	}),
)
