import { MemorySnapshot } from "@checkfu/sdk/Schemas"
import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { Memory } from "./Memory.aggregate.ts"

export { MemorySnapshot }

export class MemoryView extends Domain.View("MemoryView", {
	version: 1,
	from: [Memory],
	key: Memory,
	state: Schema.NullOr(MemorySnapshot),
	initial: null,
	evolve: {
		"memory.written": (state, e, ctx) => ({
			id: ctx.key.id,
			type: "memory" as const,
			memory_store_id: e.memory_store_id,
			path: e.path,
			content: e.content,
			content_sha256: e.content_sha256,
			content_size_bytes: e.content_size_bytes,
			version: e.version,
			created_at: state === null ? ctx.at : state.created_at,
			updated_at: ctx.at,
		}),
		"memory.deleted": () => null,
	},
}) {}
