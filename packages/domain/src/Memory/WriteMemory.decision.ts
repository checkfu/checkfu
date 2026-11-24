import * as Domain from "@alchemy.run/domain"
import { Memory } from "./Memory.aggregate.ts"
import { MemoryStore } from "./MemoryStore.aggregate.ts"
import { MemoryStoreArchivedError } from "./MemoryStoreArchived.rejection.ts"
import { MemoryStoreNotFound } from "./MemoryStoreNotFound.rejection.ts"
import { MAX_MEMORIES_PER_STORE } from "./MemoryTypes.ts"
import {
	MemoryAdded,
	MemoryAlreadyExists,
	MemoryLayoutChanged,
	MemoryNotFound,
	MemoryPlacedElsewhere,
	MemoryPreconditionFailed,
	MemoryStoreFull,
	MemoryWritten,
	WriteMemory,
} from "./WriteMemory.command.ts"

/**
 * A write reads the memory and its store together, so the store's count and
 * its limit hold however many sessions write at once.
 */
export class WriteMemoryDecision extends Domain.Decision(WriteMemory, {
	reads: { store: MemoryStore, memory: Memory },
	keyOf: (cmd) => ({ store: cmd.memory_store_id, memory: cmd.memory_id }),
	decide: ({ store, memory }, cmd) => {
		if ([store.state.status === "", store.state.status === "deleted"].some((gone) => gone)) {
			return new MemoryStoreNotFound({ memory_store_id: store.id })
		}
		if (store.state.status !== "active") {
			return new MemoryStoreArchivedError({ memory_store_id: store.id })
		}
		if (
			[
				memory.state.status !== "",
				[memory.state.memory_store_id !== cmd.memory_store_id, memory.state.path !== cmd.path].some(
					(differs) => differs,
				),
			].every((ok) => ok)
		) {
			return new MemoryPlacedElsewhere({ memory_id: memory.id })
		}
		const present = memory.state.status === "present"
		if (cmd.precondition.type === "absent" && present) {
			return new MemoryAlreadyExists({ memory_id: memory.id })
		}
		if (cmd.precondition.type === "present" && !present) {
			return new MemoryNotFound({ memory_id: memory.id })
		}
		if (cmd.precondition.type === "content_sha256") {
			if (!present) {
				return new MemoryNotFound({ memory_id: memory.id })
			}
			if (
				[
					memory.state.content_sha256 !== cmd.precondition.content_sha256,
					memory.state.content_sha256 !== cmd.content_sha256,
				].every((ok) => ok)
			) {
				return new MemoryPreconditionFailed({
					memory_id: memory.id,
					content_sha256: cmd.precondition.content_sha256,
				})
			}
		}
		if (present && memory.state.content_sha256 === cmd.content_sha256) {
			return []
		}
		if (!present && store.state.memory_count >= MAX_MEMORIES_PER_STORE) {
			return new MemoryStoreFull({
				memory_store_id: store.id,
				memory_count: store.state.memory_count,
			})
		}
		// A new path was checked against the store's other paths; it holds only if none changed since.
		if (!present && store.state.layout_version !== cmd.layout_version) {
			return new MemoryLayoutChanged({
				memory_store_id: store.id,
				layout_version: store.state.layout_version,
			})
		}
		const written = memory.record(
			new MemoryWritten({
				memory_store_id: store.id,
				path: cmd.path,
				content: cmd.content,
				content_sha256: cmd.content_sha256,
				content_size_bytes: cmd.content_size_bytes,
				version: memory.state.version + 1,
				operation: present ? "modified" : "created",
				session_id: cmd.session_id,
			}),
		)
		return present
			? [written]
			: [written, store.record(new MemoryAdded({ memory_count: store.state.memory_count + 1 }))]
	},
	transitions: {
		OnlyAnActiveStoreIsWritten: ({ before }) => before.store.status === "active",
		AWriteLeavesTheMemoryPresentWithItsContent: ({ after, command }) =>
			[
				after.memory.status === "present",
				after.memory.memory_store_id === command.memory_store_id,
				after.memory.path === command.path,
				after.memory.content_sha256 === command.content_sha256,
			].every((ok) => ok),
		ANewMemoryCountsOnceAndWithinTheLimit: ({ before, after }) =>
			[
				after.store.memory_count ===
					before.store.memory_count + (before.memory.status === "present" ? 0 : 1),
				after.store.memory_count <= MAX_MEMORIES_PER_STORE,
			].every((ok) => ok),
		ANewPathCommitsOnlyAtTheLayoutItWasCheckedAgainst: ({ before, command }) =>
			[
				before.memory.status === "present",
				before.store.layout_version === command.layout_version,
			].some((ok) => ok),
		AnAbsentPreconditionNeverOverwrites: ({ before, command }) =>
			[command.precondition.type !== "absent", before.memory.status !== "present"].some((ok) => ok),
	},
	reply: (states) => ({ version: states.memory.version }),
}) {}
