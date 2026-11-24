import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { MemoryId } from "./Memory.id.ts"
import { MemoryStoreId } from "./MemoryStore.id.ts"
import { MemoryStoreArchivedError } from "./MemoryStoreArchived.rejection.ts"
import { MemoryStoreNotFound } from "./MemoryStoreNotFound.rejection.ts"
import {
	RecordedSha256,
	MemoryContent,
	MemoryOperation,
	RecordedMemoryPath,
	MemorySize,
	NonNegativeInt,
	PositiveInt,
	WritePrecondition,
} from "./MemoryTypes.ts"

export class MemoryWritten extends Domain.Event("memory.written", {
	memory_store_id: MemoryStoreId,
	path: RecordedMemoryPath,
	content: MemoryContent,
	content_sha256: RecordedSha256,
	content_size_bytes: MemorySize,
	version: PositiveInt,
	operation: MemoryOperation,
	session_id: Schema.NullOr(Schema.String),
}) {}

export class MemoryAdded extends Domain.Event("memory_store.memory_added", {
	memory_count: PositiveInt,
}) {}

export class MemoryAlreadyExists extends Domain.Rejection(
	"MemoryAlreadyExists",
	{ memory_id: MemoryId },
	{ httpApiStatus: 409, description: "A memory already exists at this path." },
) {}

export class MemoryNotFound extends Domain.Rejection(
	"MemoryNotFound",
	{ memory_id: MemoryId },
	{ httpApiStatus: 404, description: "Memory does not exist." },
) {}

export class MemoryPreconditionFailed extends Domain.Rejection(
	"MemoryPreconditionFailed",
	{ memory_id: MemoryId, content_sha256: RecordedSha256 },
	{ httpApiStatus: 409, description: "The memory changed since it was read." },
) {}

export class MemoryStoreFull extends Domain.Rejection(
	"MemoryStoreFull",
	{ memory_store_id: MemoryStoreId, memory_count: NonNegativeInt },
	{ httpApiStatus: 409, description: "The memory store holds as many memories as it can." },
) {}

export class MemoryLayoutChanged extends Domain.Rejection(
	"MemoryLayoutChanged",
	{ memory_store_id: MemoryStoreId, layout_version: NonNegativeInt },
	{
		httpApiStatus: 409,
		description:
			"Memories were created or deleted in the store since this path was checked. Check it again.",
	},
) {}

export class MemoryPlacedElsewhere extends Domain.Rejection(
	"MemoryPlacedElsewhere",
	{ memory_id: MemoryId },
	{ httpApiStatus: 409, description: "This memory id belongs to another path or store." },
) {}

export class WriteMemory extends Domain.Command("WriteMemory", {
	input: {
		memory_id: MemoryId,
		memory_store_id: MemoryStoreId,
		path: RecordedMemoryPath,
		content: MemoryContent,
		content_sha256: RecordedSha256,
		content_size_bytes: MemorySize,
		precondition: WritePrecondition,
		// The store's layout version the path was checked against: a write that creates a memory
		// commits only if no memory was created or deleted in the store since.
		layout_version: NonNegativeInt,
		session_id: Schema.NullOr(Schema.String),
	},
	events: [MemoryWritten, MemoryAdded],
	rejects: [
		MemoryStoreNotFound,
		MemoryStoreArchivedError,
		MemoryStoreFull,
		MemoryAlreadyExists,
		MemoryNotFound,
		MemoryPreconditionFailed,
		MemoryPlacedElsewhere,
		MemoryLayoutChanged,
	],
	reply: {
		version: NonNegativeInt,
	},
}) {}
