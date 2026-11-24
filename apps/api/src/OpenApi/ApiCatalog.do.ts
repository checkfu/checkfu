import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import { documentChunks, makeApiCatalog } from "./ApiCatalogStore.ts"
import { ApiCatalog } from "./ApiCatalog.ts"
import type { ApiCatalogShape } from "./ApiCatalog.ts"

// A row holds 2 MB; a character is at most four bytes.
const CHUNK_LENGTH = 256 * 1024

export const ApiCatalogLive = ApiCatalog.make(
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
		return Effect.succeed<ApiCatalogShape>({
			alarm: () => Effect.promise(() => catalog.expire()),
			store: (document, config) => Effect.promise(() => catalog.store(document, config)),
			keep: () => Effect.promise(() => catalog.keep()),
			tools: () => Effect.promise(() => catalog.tools()),
			request: (name, args) => Effect.promise(() => catalog.request(name, args)),
		})
	}),
)
