import * as Schema from "effect/Schema"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const MemoryMountInfo = Schema.Struct({
	name: Schema.String,
	access: Schema.Literals(["read_write", "read_only"]),
})
export type MemoryMountInfo = typeof MemoryMountInfo.Type

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

export const MemoryReceipt = Schema.Struct({ stream: Schema.String, version: Count })
export type MemoryReceipt = typeof MemoryReceipt.Type

export const MemoryOutcome = Schema.Union([
	Schema.Struct({
		ok: Schema.Literal(true),
		content_sha256: Schema.String,
		receipt: Schema.NullOr(MemoryReceipt),
	}),
	Schema.Struct({ ok: Schema.Literal(false), code: MemoryErrorCode, message: Schema.String }),
])
export type MemoryOutcome = typeof MemoryOutcome.Type

const Session = Schema.String
const StoreName = Schema.String
const Path = Schema.String

export const SessionMemoryCalls = {
	memoryMounts: { args: Schema.Tuple([Session]), result: Schema.Array(MemoryMountInfo) },
	memoryList: {
		args: Schema.Tuple([Session, StoreName, Schema.Array(MemoryReceipt)]),
		result: Schema.Array(MemoryFileInfo),
	},
	memoryRead: {
		args: Schema.Tuple([Session, StoreName, Path]),
		result: Schema.NullOr(MemoryContent),
	},
	memoryWrite: {
		args: Schema.Tuple([Session, StoreName, Path, Schema.String, Schema.Boolean]),
		result: MemoryOutcome,
	},
	memoryRemove: {
		args: Schema.Tuple([Session, StoreName, Path, Schema.NullOr(Schema.String)]),
		result: MemoryOutcome,
	},
}

export interface SessionMemory {
	readonly mounts: () => Promise<ReadonlyArray<MemoryMountInfo>>
	readonly list: (name: string) => Promise<ReadonlyArray<MemoryFileInfo>>
	readonly read: (name: string, path: string) => Promise<MemoryContent | null>
	readonly write: (
		name: string,
		path: string,
		content: string,
		exclusive: boolean,
	) => Promise<MemoryOutcome>
	readonly remove: (name: string, path: string, expected: string | null) => Promise<MemoryOutcome>
}

export interface SessionMemoryCalls {
	readonly mounts: SessionMemory["mounts"]
	readonly list: (
		name: string,
		after: ReadonlyArray<MemoryReceipt>,
	) => Promise<ReadonlyArray<MemoryFileInfo>>
	readonly read: SessionMemory["read"]
	readonly write: SessionMemory["write"]
	readonly remove: SessionMemory["remove"]
}

export const makeSessionMemory = (calls: SessionMemoryCalls): SessionMemory => {
	const written = new Map<string, Map<string, MemoryReceipt>>()
	return {
		mounts: calls.mounts,
		read: calls.read,
		remove: calls.remove,
		list: async (name) => {
			const waiting = written.get(name)
			const asked = [...(waiting?.values() ?? [])]
			const listed = await calls.list(name, asked)
			for (const receipt of asked) {
				if (waiting?.get(receipt.stream) === receipt) {
					waiting.delete(receipt.stream)
				}
			}
			return listed
		},
		write: async (name, path, content, exclusive) => {
			const outcome = await calls.write(name, path, content, exclusive)
			if (outcome.ok && outcome.receipt !== null) {
				const waiting = written.get(name) ?? new Map<string, MemoryReceipt>()
				waiting.set(outcome.receipt.stream, outcome.receipt)
				written.set(name, waiting)
			}
			return outcome
		},
	}
}
