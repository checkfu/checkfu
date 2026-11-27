import * as Domain from "@alchemy.run/domain"
import { DeleteMemory, MemoryDeleted, MemoryRemoved } from "./DeleteMemory.command.ts"
import { Memory } from "./Memory.aggregate.ts"
import { MemoryStore } from "./MemoryStore.aggregate.ts"
import { MemoryStoreArchivedError } from "./MemoryStoreArchived.rejection.ts"
import { MemoryStoreNotFound } from "./MemoryStoreNotFound.rejection.ts"
import { MemoryNotFound, MemoryPreconditionFailed } from "./WriteMemory.command.ts"

export class DeleteMemoryDecision extends Domain.Decision(DeleteMemory, {
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
				memory.state.status !== "present",
				memory.state.memory_store_id !== cmd.memory_store_id,
				store.state.memory_count < 1,
			].some((missing) => missing)
		) {
			return new MemoryNotFound({ memory_id: memory.id })
		}
		if (
			cmd.expected_content_sha256 !== null &&
			memory.state.content_sha256 !== cmd.expected_content_sha256
		) {
			return new MemoryPreconditionFailed({
				memory_id: memory.id,
				content_sha256: cmd.expected_content_sha256,
			})
		}
		return [
			memory.record(
				new MemoryDeleted({
					memory_store_id: store.id,
					path: memory.state.path,
					version: memory.state.version + 1,
					session_id: cmd.session_id,
				}),
			),
			store.record(new MemoryRemoved({ memory_count: store.state.memory_count - 1 })),
		]
	},
	transitions: {
		AnExpectedHashIsTheStoredHash: ({ before, command }) =>
			[
				command.expected_content_sha256 === null,
				before.memory.content_sha256 === command.expected_content_sha256,
			].some((ok) => ok),
		ADeleteRemovesOnePresentMemory: ({ before, after }) =>
			[
				before.store.status === "active",
				before.memory.status === "present",
				after.memory.status === "deleted",
				after.store.memory_count === before.store.memory_count - 1,
			].every((ok) => ok),
	},
}) {}
