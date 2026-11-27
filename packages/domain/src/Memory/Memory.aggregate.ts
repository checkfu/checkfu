import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import { MemoryDeleted } from "./DeleteMemory.command.ts"
import { MemoryId } from "./Memory.id.ts"
import { NonNegativeInt } from "./MemoryTypes.ts"
import { MemoryWritten } from "./WriteMemory.command.ts"

export const MemoryState = Schema.Struct({
	status: Schema.Literals(["", "present", "deleted"]),
	memory_store_id: Schema.String,
	path: Schema.String,
	content_sha256: Schema.String,
	version: NonNegativeInt,
})
export type MemoryState = typeof MemoryState.Type

export const MEMORY_STATE_SCHEMA_VERSION = 1 as const

export const MemoryStateSnapshot = versionedSnapshot({
	current: MEMORY_STATE_SCHEMA_VERSION,
	schema: MemoryState,
})

export class Memory extends Domain.Aggregate("Memory", {
	id: MemoryId,
	state: MemoryStateSnapshot,
	initial: {
		status: "",
		memory_store_id: "",
		path: "",
		content_sha256: "",
		version: 0,
	},
	events: [MemoryWritten, MemoryDeleted],
	invariants: {
		StatusIsKnown: (s) =>
			[s.status === "", s.status === "present", s.status === "deleted"].some((ok) => ok),
		PlacedExactlyWhenWritten: (s) =>
			[
				[
					s.status === "",
					s.memory_store_id === "",
					s.path === "",
					s.content_sha256 === "",
					s.version === 0,
				].every((ok) => ok),
				[s.status !== "", s.memory_store_id !== "", s.path !== "", s.version >= 1].every(
					(ok) => ok,
				),
			].some((ok) => ok),
	},
	transitions: {
		AMemoryNeverLeavesItsPlace: ({ before, after }) =>
			[
				before.status === "",
				[after.memory_store_id === before.memory_store_id, after.path === before.path].every(
					(ok) => ok,
				),
			].some((ok) => ok),
		VersionGrowsByOneOrNotAtAll: ({ before, after }) =>
			[
				[after.version === before.version, after.status === before.status].every((ok) => ok),
				after.version === before.version + 1,
			].some((ok) => ok),
	},
	evolve: {
		"memory.written": (state, e) =>
			[
				e.version === state.version + 1,
				[
					state.status === "",
					[state.memory_store_id === e.memory_store_id, state.path === e.path].every((ok) => ok),
				].some((ok) => ok),
			].every((ok) => ok)
				? {
						status: "present" as const,
						memory_store_id: e.memory_store_id,
						path: e.path,
						content_sha256: e.content_sha256,
						version: e.version,
					}
				: state,
		"memory.deleted": (state, e) =>
			[state.status === "present", e.version === state.version + 1].every((ok) => ok)
				? { ...state, status: "deleted" as const, content_sha256: "", version: e.version }
				: state,
	},
}) {}
