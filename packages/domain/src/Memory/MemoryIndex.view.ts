import { MemoryIndexEntry } from "@checkfu/sdk/Schemas"
import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { Memory } from "./Memory.aggregate.ts"
import { MemoryStore } from "./MemoryStore.aggregate.ts"
import { MemoryStoreId } from "./MemoryStore.id.ts"

export { MemoryIndexEntry }

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
	state: Schema.Struct({
		entries: Schema.Array(MemoryIndexEntry),
		layout_version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	}),
	initial: { entries: [], layout_version: 0 },
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
				layout_version: state.layout_version + (e.operation === "created" ? 1 : 0),
			}
		},
		"memory.deleted": (state, _e, ctx) => ({
			entries: state.entries.filter((entry) => entry.id !== ctx.source.id),
			layout_version: state.layout_version + 1,
		}),
	},
}) {}
