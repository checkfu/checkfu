import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { MemoryStoreId } from "./MemoryStore.id.ts"
import { MemoryStoreArchivedError } from "./MemoryStoreArchived.rejection.ts"
import { MemoryStoreNotFound } from "./MemoryStoreNotFound.rejection.ts"
import { MemoryStoreDescription, MemoryStoreName } from "./MemoryTypes.ts"

export class MemoryStoreUpdated extends Domain.Event("memory_store.updated", {
	name: MemoryStoreName,
	description: MemoryStoreDescription,
}) {}

export class UpdateMemoryStore extends Domain.Command("UpdateMemoryStore", {
	input: {
		memory_store_id: MemoryStoreId,
		changes: Schema.Struct({
			name: Schema.optionalKey(MemoryStoreName),
			description: Schema.optionalKey(MemoryStoreDescription),
		}),
	},
	events: [MemoryStoreUpdated],
	rejects: [MemoryStoreNotFound, MemoryStoreArchivedError],
}) {}
