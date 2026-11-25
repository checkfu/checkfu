import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { MemoryId } from "./Memory.id.ts"
import { MemoryStoreId } from "./MemoryStore.id.ts"
import { MemoryStoreArchivedError } from "./MemoryStoreArchived.rejection.ts"
import { MemoryStoreNotFound } from "./MemoryStoreNotFound.rejection.ts"
import { RecordedSha256, RecordedMemoryPath, NonNegativeInt, PositiveInt } from "./MemoryTypes.ts"
import { MemoryNotFound, MemoryPreconditionFailed } from "./WriteMemory.command.ts"

export class MemoryDeleted extends Domain.Event("memory.deleted", {
	memory_store_id: MemoryStoreId,
	path: RecordedMemoryPath,
	version: PositiveInt,
	session_id: Schema.NullOr(Schema.String),
}) {}

export class MemoryRemoved extends Domain.Event("memory_store.memory_removed", {
	memory_count: NonNegativeInt,
}) {}

export class DeleteMemory extends Domain.Command("DeleteMemory", {
	input: {
		memory_id: MemoryId,
		memory_store_id: MemoryStoreId,
		expected_content_sha256: Schema.NullOr(RecordedSha256),
		session_id: Schema.NullOr(Schema.String),
	},
	events: [MemoryDeleted, MemoryRemoved],
	rejects: [
		MemoryStoreNotFound,
		MemoryStoreArchivedError,
		MemoryNotFound,
		MemoryPreconditionFailed,
	],
}) {}
