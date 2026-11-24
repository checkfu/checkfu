import { WritePrecondition } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"

// What a session's workspace may do with the memory stores attached to its session, as the API
// Worker answers it. Each call names the session, so nothing is held between calls but the hashes
// the workspace last read.

// Sizes in bytes and times in epoch milliseconds.
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const MemoryMountInfo = Schema.Struct({
	/** The store's directory under /mnt/memory. */
	name: Schema.String,
	access: Schema.Literals(["read_write", "read_only"]),
})
export type MemoryMountInfo = typeof MemoryMountInfo.Type

/** A memory as a file: its path in the store, its size in bytes and when it last changed. */
export const MemoryFileInfo = Schema.Struct({
	path: Schema.String,
	size: Count,
	updated_at: Count,
})
export type MemoryFileInfo = typeof MemoryFileInfo.Type

export const MemoryContent = Schema.Struct({
	content: Schema.String,
	content_sha256: Schema.String,
	updated_at: Count,
})
export type MemoryContent = typeof MemoryContent.Type

export const MemoryErrorCode = Schema.Literals([
	"EROFS",
	"ENOENT",
	"EEXIST",
	"ENOSPC",
	"EINVAL",
	"EISDIR",
	"EIO",
])
export type MemoryErrorCode = typeof MemoryErrorCode.Type

export const MemoryOutcome = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true), content_sha256: Schema.String }),
	Schema.Struct({ ok: Schema.Literal(false), code: MemoryErrorCode, message: Schema.String }),
])
export type MemoryOutcome = typeof MemoryOutcome.Type

const Session = Schema.String
const StoreName = Schema.String
const Path = Schema.String
/** Names one change, so a retry of it is not made twice. */
const MutationId = Schema.String

/** The calls the harness Worker makes into the API Worker. */
export const SessionMemoryCalls = {
	memoryMounts: { args: Schema.Tuple([Session]), result: Schema.Array(MemoryMountInfo) },
	memoryList: { args: Schema.Tuple([Session, StoreName]), result: Schema.Array(MemoryFileInfo) },
	memoryRead: {
		args: Schema.Tuple([Session, StoreName, Path]),
		result: Schema.NullOr(MemoryContent),
	},
	memoryWrite: {
		args: Schema.Tuple([Session, StoreName, Path, Schema.String, WritePrecondition, MutationId]),
		result: MemoryOutcome,
	},
	memoryRemove: {
		args: Schema.Tuple([Session, StoreName, Path, Schema.NullOr(Schema.String), MutationId]),
		result: MemoryOutcome,
	},
}

/** The same calls for one session, as the workspace's memory mount uses them. */
export interface SessionMemory {
	readonly mounts: () => Promise<ReadonlyArray<MemoryMountInfo>>
	/** Every memory in the store, as of every create and delete committed so far. */
	readonly list: (name: string) => Promise<ReadonlyArray<MemoryFileInfo>>
	/** The memory as committed, or null when it is not there. */
	readonly read: (name: string, path: string) => Promise<MemoryContent | null>
	/** Refused (EEXIST) when the memory is not as `precondition` expects. */
	readonly write: (
		name: string,
		path: string,
		content: string,
		precondition: WritePrecondition,
		mutationId: string,
	) => Promise<MemoryOutcome>
	/** `expected` is the content the session last read there, or null to remove whatever is. */
	readonly remove: (
		name: string,
		path: string,
		expected: string | null,
		mutationId: string,
	) => Promise<MemoryOutcome>
}
