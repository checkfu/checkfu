import * as Schema from "effect/Schema"
import { throwIfCallStopped } from "./CallSignal.ts"

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

export type PendingReceipts = Readonly<Record<string, ReadonlyArray<MemoryReceipt>>>

export interface PendingReceiptStore {
	readonly get: () => PendingReceipts | undefined
	readonly put: (pending: PendingReceipts) => void
}

export const makeSessionMemory = (
	calls: SessionMemoryCalls,
	store: PendingReceiptStore,
): SessionMemory => {
	const pendingFor = (name: string): ReadonlyArray<MemoryReceipt> => {
		const held = store.get() ?? {}
		return Object.hasOwn(held, name) ? (held[name] ?? []) : []
	}
	const keep = (name: string, receipts: ReadonlyArray<MemoryReceipt>): void => {
		const others = Object.entries(store.get() ?? {}).filter(([held]) => held !== name)
		store.put(Object.fromEntries(receipts.length === 0 ? others : [...others, [name, receipts]]))
	}
	return {
		mounts: calls.mounts,
		read: calls.read,
		remove: (name, path, expected) => {
			throwIfCallStopped()
			return calls.remove(name, path, expected)
		},
		list: async (name) => {
			const asked = pendingFor(name)
			const listed = await calls.list(name, asked)
			keep(
				name,
				pendingFor(name).filter(
					(held) =>
						!asked.some((shown) => shown.stream === held.stream && shown.version >= held.version),
				),
			)
			return listed
		},
		write: async (name, path, content, exclusive) => {
			throwIfCallStopped()
			const outcome = await calls.write(name, path, content, exclusive)
			if (outcome.ok && outcome.receipt !== null) {
				const { receipt } = outcome
				const held = pendingFor(name)
				if (
					!held.some((other) => other.stream === receipt.stream && other.version >= receipt.version)
				) {
					keep(name, [...held.filter((other) => other.stream !== receipt.stream), receipt])
				}
			}
			return outcome
		},
	}
}
