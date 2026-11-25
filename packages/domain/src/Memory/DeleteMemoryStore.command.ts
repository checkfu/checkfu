import * as Domain from "@alchemy.run/domain"
import { MemoryStoreId } from "./MemoryStore.id.ts"
import { MemoryStoreNotFound } from "./MemoryStoreNotFound.rejection.ts"

export class MemoryStoreDeleted extends Domain.Event("memory_store.deleted") {}

export class DeleteMemoryStore extends Domain.Command("DeleteMemoryStore", {
	input: { memory_store_id: MemoryStoreId },
	events: [MemoryStoreDeleted],
	rejects: [MemoryStoreNotFound],
}) {}
