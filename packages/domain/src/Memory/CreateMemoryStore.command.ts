import * as Domain from "@alchemy.run/domain"
import { MemoryStoreId } from "./MemoryStore.id.ts"
import { MemoryStoreDescription, MemoryStoreName } from "./MemoryTypes.ts"

export class MemoryStoreCreated extends Domain.Event("memory_store.created", {
	name: MemoryStoreName,
	description: MemoryStoreDescription,
}) {}

export class MemoryStoreAlreadyExists extends Domain.Rejection(
	"MemoryStoreAlreadyExists",
	{ memory_store_id: MemoryStoreId },
	{ httpApiStatus: 409, description: "A memory store with this id already exists." },
) {}

export class CreateMemoryStore extends Domain.Command("CreateMemoryStore", {
	input: {
		memory_store_id: MemoryStoreId,
		name: MemoryStoreName,
		description: MemoryStoreDescription,
	},
	events: [MemoryStoreCreated],
	rejects: [MemoryStoreAlreadyExists],
}) {}
