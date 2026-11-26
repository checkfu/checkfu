import * as Domain from "@alchemy.run/domain"
import { MemoryStoreId } from "./MemoryStore.id.ts"
import { MemoryStoreNotFound } from "./MemoryStoreNotFound.rejection.ts"

export class MemoryStoreArchived extends Domain.Event("memory_store.archived") {}

export class ArchiveMemoryStore extends Domain.Command("ArchiveMemoryStore", {
	input: { memory_store_id: MemoryStoreId },
	events: [MemoryStoreArchived],
	rejects: [MemoryStoreNotFound],
}) {}
