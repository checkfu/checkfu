import { DeleteMemory } from "@checkfu/domain/Memory/DeleteMemory.command"
import { DeleteMemoryDecision } from "@checkfu/domain/Memory/DeleteMemory.decision"
import { Memory } from "@checkfu/domain/Memory/Memory.aggregate"
import { MemoryId } from "@checkfu/domain/Memory/Memory.id"
import { MemoryStore } from "@checkfu/domain/Memory/MemoryStore.aggregate"
import { MemoryStoreId } from "@checkfu/domain/Memory/MemoryStore.id"
import { MAX_MEMORY_CONTENT_BYTES, MemoryPath } from "@checkfu/domain/Memory/MemoryTypes"
import { memoryStoresOf } from "@checkfu/domain/Session/SessionResource"
import { MEMORY_BUSY_MESSAGE } from "./Workspace/SessionMemory.ts"
import type { MemoryStoreResource } from "@checkfu/domain/Session/SessionResource"
import * as Digest from "effect/crypto/Digest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { MemoryAccess } from "./MemoryAccess.ts"
import { measureContent, memoryIdOf } from "./MemoryIdentity.ts"
import { SessionResources } from "./SessionResources.ts"
import type {
	MemoryErrorCode,
	MemoryFileInfo,
	MemoryMountInfo,
	MemoryOutcome,
	MemoryReceipt,
} from "./Workspace/SessionMemory.ts"

const isMemoryPath = Schema.is(MemoryPath)

const refused = (code: MemoryErrorCode, message: string): MemoryOutcome => ({
	ok: false,
	code,
	message,
})

const accessOf = (store: MemoryStoreResource, status: string): MemoryMountInfo["access"] =>
	status === "active" && store.access === "read_write" ? "read_write" : "read_only"

const isLive = (status: string) => status === "active" || status === "archived"

export const readableMemoryStores = (resources: ReadonlyArray<MemoryStoreResource>) =>
	Effect.gen(function* () {
		if (resources.length === 0) {
			return []
		}
		const stores = yield* MemoryStore
		const resolved = yield* Effect.forEach(
			resources,
			(store) =>
				stores.get(MemoryStoreId.make(store.memory_store_id)).pipe(
					Effect.map(({ status }) =>
						isLive(status) ? { ...store, access: accessOf(store, status) } : null,
					),
					Effect.catchDefect((cause) =>
						Effect.as(
							Effect.logWarning(
								"Could not read a session memory store",
								store.memory_store_id,
								cause,
							),
							null,
						),
					),
				),
			{ concurrency: 8 },
		)
		return resolved.filter((store) => store !== null)
	})

const rejection = (tag: string, path: string): MemoryOutcome => {
	switch (tag) {
		case "MemoryStoreNotFound":
			return refused("ENOENT", "The memory store no longer exists.")
		case "MemoryStoreArchived":
			return refused("EROFS", "The memory store is archived and read-only.")
		case "MemoryStoreFull":
			return refused("ENOSPC", "The memory store is full; delete a memory first.")
		case "MemoryPlacedElsewhere":
		case "MemoryPathConflict":
			return refused("EISDIR", `${path} cannot be both a memory and a directory of memories.`)
		case "MemoryNotFound":
			return refused("ENOENT", `No memory at ${path}.`)
		case "MemoryAlreadyExists":
			return refused("EEXIST", `${path} is already a memory.`)
		case "MemoryViewLagging":
		case "MemoryLayoutChanged":
			return refused("EIO", MEMORY_BUSY_MESSAGE)
		default:
			return refused("EEXIST", `${path} changed while it was being moved.`)
	}
}

export const SessionMemoryAccess = Effect.gen(function* () {
	const access = yield* MemoryAccess
	const stores = yield* MemoryStore
	const memories = yield* Memory
	const resourcesOf = yield* SessionResources
	const deleteMemory = yield* DeleteMemoryDecision
	const digest = yield* Digest.Digest

	const statusOf = (store: MemoryStoreResource) =>
		Effect.map(stores.get(MemoryStoreId.make(store.memory_store_id)), (state) => state.status)

	const attached = (sessionId: string) => Effect.map(resourcesOf(sessionId), memoryStoresOf)

	const storeNamed = (sessionId: string, name: string) =>
		Effect.map(attached(sessionId), (all) =>
			all.find((store) => store.mount_path.slice(store.mount_path.lastIndexOf("/") + 1) === name),
		)

	const writable = (sessionId: string, name: string) =>
		Effect.gen(function* () {
			const store = yield* storeNamed(sessionId, name)
			if (store === undefined) {
				return refused("EROFS", `No memory store is mounted as ${name}.`)
			}
			if (accessOf(store, yield* statusOf(store)) === "read_only") {
				return refused("EROFS", `The memory store ${name} is read-only.`)
			}
			return MemoryStoreId.make(store.memory_store_id)
		})

	const mountedMemory = (sessionId: string, name: string, path: string) =>
		Effect.gen(function* () {
			const store = yield* storeNamed(sessionId, name)
			if (store === undefined || !isMemoryPath(path) || !isLive(yield* statusOf(store))) {
				return null
			}
			const storeId = MemoryStoreId.make(store.memory_store_id)
			const memoryId = MemoryId.make(yield* memoryIdOf(digest, storeId, path))
			return yield* access.read(storeId, memoryId)
		})

	return {
		memoryMounts: (sessionId: string) =>
			Effect.flatMap(attached(sessionId), (all) =>
				Effect.forEach(all, (store) =>
					Effect.map(statusOf(store), (status) => ({
						name: store.mount_path.slice(store.mount_path.lastIndexOf("/") + 1),
						access: accessOf(store, status),
					})),
				),
			),
		memoryList: (sessionId: string, name: string, after: ReadonlyArray<MemoryReceipt>) =>
			Effect.gen(function* () {
				const store = yield* storeNamed(sessionId, name)
				if (store === undefined || !isLive(yield* statusOf(store))) {
					return []
				}
				const { entries } = yield* access.currentIndex(
					MemoryStoreId.make(store.memory_store_id),
					after,
				)
				return entries.map((entry): MemoryFileInfo => ({
					path: entry.path,
					size: entry.content_size_bytes,
					updated_at: DateTime.toEpochMillis(entry.updated_at),
				}))
			}).pipe(Effect.catchTag("MemoryViewLagging", () => Effect.succeed("busy" as const))),
		memoryStat: (sessionId: string, name: string, path: string) =>
			Effect.map(mountedMemory(sessionId, name, path), (found) =>
				found === null
					? null
					: {
							size: found.content_size_bytes,
							updated_at: DateTime.toEpochMillis(found.updated_at),
						},
			).pipe(Effect.catchTag("MemoryViewLagging", () => Effect.succeed("busy" as const))),
		memoryRead: (sessionId: string, name: string, path: string) =>
			Effect.map(mountedMemory(sessionId, name, path), (found) =>
				found === null
					? null
					: {
							content: found.content,
							content_sha256: found.content_sha256,
							updated_at: DateTime.toEpochMillis(found.updated_at),
						},
			).pipe(Effect.catchTag("MemoryViewLagging", () => Effect.succeed("busy" as const))),
		memoryWrite: (
			sessionId: string,
			name: string,
			path: string,
			content: string,
			exclusive: boolean,
		) =>
			Effect.gen(function* () {
				const storeId = yield* writable(sessionId, name)
				if (typeof storeId !== "string") {
					return storeId
				}
				if (!isMemoryPath(path)) {
					return refused("EINVAL", `${path} is not a path a memory can have.`)
				}
				const measured = yield* measureContent(digest, content)
				if (measured.content_size_bytes > MAX_MEMORY_CONTENT_BYTES) {
					return refused(
						"EINVAL",
						`A memory holds at most ${MAX_MEMORY_CONTENT_BYTES} bytes; this is ${measured.content_size_bytes}.`,
					)
				}
				return yield* access
					.write({
						storeId,
						memoryId: MemoryId.make(yield* memoryIdOf(digest, storeId, path)),
						path,
						content,
						...measured,
						precondition: exclusive ? { type: "exclusive" } : { type: "none" },
						sessionId,
					})
					.pipe(
						Effect.map(({ commit, listed }): MemoryOutcome => ({
							ok: true,
							content_sha256: measured.content_sha256,
							receipt: listed ? null : (commit ?? null),
						})),
						Effect.catch((error) => Effect.succeed(rejection(error._tag, path))),
					)
			}),
		memoryRemove: (sessionId: string, name: string, path: string, expected: string | null) =>
			Effect.gen(function* () {
				const storeId = yield* writable(sessionId, name)
				if (typeof storeId !== "string") {
					return storeId
				}
				const memoryId = MemoryId.make(yield* memoryIdOf(digest, storeId, path))
				const removed = expected ?? (yield* memories.get(memoryId)).content_sha256
				return yield* deleteMemory
					.send(
						new DeleteMemory({
							memory_id: memoryId,
							memory_store_id: storeId,
							expected_content_sha256: expected,
							session_id: sessionId,
						}),
					)
					.pipe(
						Effect.as<MemoryOutcome>({ ok: true, content_sha256: removed, receipt: null }),
						Effect.catch((error) => Effect.succeed(rejection(error._tag, path))),
					)
			}),
	}
})
