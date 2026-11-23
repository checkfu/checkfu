import { MemoryStoreSnapshot } from "@checkfu/sdk/Schemas"
import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { MemoryStore } from "./MemoryStore.aggregate.ts"

export { MemoryStoreSnapshot }

export class MemoryStoreView extends Domain.View("MemoryStoreView", {
	version: 1,
	from: [MemoryStore],
	key: MemoryStore,
	state: Schema.NullOr(MemoryStoreSnapshot),
	initial: null,
	evolve: {
		"memory_store.created": (state, e, ctx) =>
			state !== null
				? state
				: {
						id: ctx.key.id,
						type: "memory_store" as const,
						name: e.name,
						description: e.description,
						created_at: ctx.at,
						updated_at: ctx.at,
						archived_at: null,
					},
		"memory_store.updated": (state, e, ctx) =>
			state === null
				? null
				: { ...state, name: e.name, description: e.description, updated_at: ctx.at },
		"memory_store.archived": (state, _e, ctx) =>
			state === null || state.archived_at
				? state
				: { ...state, archived_at: ctx.at, updated_at: ctx.at },
		"memory_store.deleted": () => null,
	},
}) {}
