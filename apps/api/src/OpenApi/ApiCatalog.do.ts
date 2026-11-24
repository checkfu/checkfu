import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import { documentChunks, makeApiCatalog } from "./ApiCatalogStore.ts"
import type { CatalogConfig, CatalogRequest, CatalogTools } from "./ApiCatalogStore.ts"

// A row holds 2 MB; a character is at most four bytes.
const CHUNK_LENGTH = 256 * 1024

/**
 * One object per API server of an agent version, named by the server's
 * catalog id: the only place the server's OpenAPI document is kept. Sessions
 * ask it for the API's tools and for the request a tool call comes to.
 */
export class ApiCatalog extends Cloudflare.DurableObject<ApiCatalog>()(
	"ApiCatalog",
	Effect.map(Cloudflare.DurableObjectState, (state) => {
		const { storage } = state.raw
		let created = false
		const chunks = () => {
			if (!created) {
				storage.sql.exec(
					"CREATE TABLE IF NOT EXISTS checkfu_api_document (seq INTEGER PRIMARY KEY, text TEXT NOT NULL)",
				)
				created = true
			}
		}
		const catalog = makeApiCatalog(
			{
				get: (key) => storage.kv.get<string>(key),
				put: (key, value) => {
					storage.kv.put(key, value)
				},
				document: () => {
					chunks()
					const rows = [
						...storage.sql.exec<{ text: string }>(
							"SELECT text FROM checkfu_api_document ORDER BY seq",
						),
					]
					return rows.length === 0 ? null : rows.map((row) => row.text).join("")
				},
				writeDocument: (text) => {
					chunks()
					storage.transactionSync(() => {
						storage.sql.exec("DELETE FROM checkfu_api_document")
						for (const [seq, chunk] of documentChunks(text, CHUNK_LENGTH).entries()) {
							storage.sql.exec(
								"INSERT INTO checkfu_api_document (seq, text) VALUES (?, ?)",
								seq,
								chunk,
							)
						}
					})
				},
				clear: async () => {
					created = false
					await storage.deleteAll()
				},
				setAlarm: (at) => storage.setAlarm(at),
				deleteAlarm: () => storage.deleteAlarm(),
			},
			() => Date.now(),
		)
		return Effect.succeed({
			alarm: () => Effect.promise(() => catalog.expire()),
			store: (document: string, config: CatalogConfig): Effect.Effect<boolean> =>
				Effect.promise(() => catalog.store(document, config)),
			keep: (): Effect.Effect<void> => Effect.promise(() => catalog.keep()),
			tools: (): Effect.Effect<CatalogTools> => Effect.promise(() => catalog.tools()),
			request: (name: string, args: Schema.JsonObject): Effect.Effect<CatalogRequest> =>
				Effect.promise(() => catalog.request(name, args)),
		})
	}),
) {}
