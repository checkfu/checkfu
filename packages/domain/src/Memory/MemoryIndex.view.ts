import { MemoryIndexEntry } from "@checkfu/sdk/Schemas"
import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { Memory } from "./Memory.aggregate.ts"
import { MemoryStore } from "./MemoryStore.aggregate.ts"
import { MemoryStoreId } from "./MemoryStore.id.ts"

export { MemoryIndexEntry }

/**
 * Every memory a store holds, without its content: what a listing shows, and
 * what a workspace compares its copy against. A store holds at most 1,000, so the index stays
 * well within the one row it is stored in.
 */
export class MemoryIndex extends Domain.View("MemoryIndex", {
	version: 1,
	from: [Memory],
	key: MemoryStore,
	keyOf: {
		"memory.written": ({ event }) =>
			MemoryStore.ref(MemoryStoreId.make(event.memory_store_id, { disableChecks: true })),
		"memory.deleted": ({ event }) =>
			MemoryStore.ref(MemoryStoreId.make(event.memory_store_id, { disableChecks: true })),
	},
	state: Schema.Struct({ entries: Schema.Array(MemoryIndexEntry) }),
	initial: { entries: [] },
	evolve: {
		"memory.written": (state, e, ctx) => {
			const existing = state.entries.find((entry) => entry.id === ctx.source.id)
			const written = {
				id: ctx.source.id,
				path: e.path,
				content_sha256: e.content_sha256,
				content_size_bytes: e.content_size_bytes,
				created_at: existing === undefined ? ctx.at : existing.created_at,
				updated_at: ctx.at,
			}
			return {
				entries:
					existing === undefined
						? [...state.entries, written]
						: state.entries.map((entry) => (entry.id === written.id ? written : entry)),
			}
		},
		"memory.deleted": (state, _e, ctx) => ({
			entries: state.entries.filter((entry) => entry.id !== ctx.source.id),
		}),
	},
}) {}
