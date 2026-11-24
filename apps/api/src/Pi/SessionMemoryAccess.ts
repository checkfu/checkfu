import { DeleteMemory } from "@checkfu/domain/Memory/DeleteMemory.command"
import { DeleteMemoryDecision } from "@checkfu/domain/Memory/DeleteMemory.decision"
import { Memory } from "@checkfu/domain/Memory/Memory.aggregate"
import { MemoryId } from "@checkfu/domain/Memory/Memory.id"
import { MemoryIndex } from "@checkfu/domain/Memory/MemoryIndex.view"
import { MemoryStore } from "@checkfu/domain/Memory/MemoryStore.aggregate"
import { MemoryStoreId } from "@checkfu/domain/Memory/MemoryStore.id"
import { MAX_MEMORY_CONTENT_BYTES, MemoryPath } from "@checkfu/domain/Memory/MemoryTypes"
import { MemoryView } from "@checkfu/domain/Memory/MemoryView.view"
import { WriteMemory } from "@checkfu/domain/Memory/WriteMemory.command"
import { WriteMemoryDecision } from "@checkfu/domain/Memory/WriteMemory.decision"
import type { MemoryStoreResource } from "@checkfu/domain/Session/SessionResource"
import * as Digest from "effect/crypto/Digest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { measureContent, memoryIdOf } from "../MemoryIdentity.ts"
import type {
	MemoryErrorCode,
	MemoryFileInfo,
	MemoryMountInfo,
	MemoryOutcome,
	SessionMemory,
} from "../Workspace/SessionMemory.ts"

const isMemoryPath = Schema.is(MemoryPath)

const refused = (code: MemoryErrorCode, message: string): MemoryOutcome => ({
	ok: false,
	code,
	message,
})

const holdsOrIsHeldBy = (a: string, b: string): boolean =>
	a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

// A deleted store is mounted as holding nothing, and an archived one as read-only.
const accessOf = (store: MemoryStoreResource, status: string): MemoryMountInfo["access"] =>
	status === "active" && store.access === "read_write" ? "read_write" : "read_only"

const rejection = (tag: string, path: string): MemoryOutcome => {
	switch (tag) {
		case "MemoryStoreNotFound":
			return refused("ENOENT", "The memory store no longer exists.")
		case "MemoryStoreArchived":
			return refused("EROFS", "The memory store is archived and read-only.")
		case "MemoryStoreFull":
			return refused("ENOSPC", "The memory store is full; delete a memory first.")
		case "MemoryPlacedElsewhere":
			return refused("EISDIR", `${path} cannot be both a memory and a directory of memories.`)
		default:
			return refused(
				"EEXIST",
				`${path} changed since this session last read it. Read it again, then write.`,
			)
	}
}

// The content view follows the memory it shows; a read waits this long for it to catch up.
const CONTENT_WAIT = { schedule: Schedule.spaced("50 millis"), times: 100 } as const

/**
 * Serves a session's memory stores to its workspace for one turn, through the same decisions the
 * HTTP API uses. Each write names the content it replaces, so two sessions never silently undo
 * each other's changes.
 */
export const SessionMemoryAccess = Effect.gen(function* () {
	const stores = yield* MemoryStore
	const memories = yield* Memory
	const index = yield* MemoryIndex
	const views = yield* MemoryView
	const writeMemory = yield* WriteMemoryDecision
	const deleteMemory = yield* DeleteMemoryDecision
	const digest = yield* Digest.Digest
	const services = yield* Effect.context<never>()
	const run = <A, E>(effect: Effect.Effect<A, E>) =>
		Effect.runPromiseWith(services)(Effect.orDie(effect))
	const statusOf = (storeId: MemoryStoreId) =>
		Effect.map(stores.get(storeId), (state) => state.status)

	return (
		sessionId: string,
		turn: number,
		mounted: ReadonlyArray<MemoryStoreResource>,
	): SessionMemory => {
		const byName = new Map(
			mounted.map((store) => [
				store.mount_path.slice(store.mount_path.lastIndexOf("/") + 1),
				store,
			]),
		)
		const storeOf = (name: string) => {
			const store = byName.get(name)
			return store === undefined ? undefined : MemoryStoreId.make(store.memory_store_id)
		}

		const writableStore = (name: string) =>
			Effect.gen(function* () {
				const store = byName.get(name)
				if (store === undefined) {
					return refused("ENOENT", `No memory store is mounted as ${name}.`)
				}
				const storeId = MemoryStoreId.make(store.memory_store_id)
				if (accessOf(store, yield* statusOf(storeId)) === "read_only") {
					return refused("EROFS", `The memory store ${name} is read-only.`)
				}
				return storeId
			})

		return {
			mounts: () =>
				run(
					Effect.forEach([...byName], ([name, store]) =>
						Effect.map(statusOf(MemoryStoreId.make(store.memory_store_id)), (status) => ({
							name,
							access: accessOf(store, status),
						})),
					),
				),
			list: (name) =>
				run(
					Effect.gen(function* () {
						const storeId = storeOf(name)
						if (storeId === undefined) {
							return []
						}
						const status = yield* statusOf(storeId)
						if (status !== "active" && status !== "archived") {
							return []
						}
						const entries = Option.match(yield* index.get(MemoryStore.ref(storeId)), {
							onNone: () => [],
							onSome: (state) => state.entries,
						})
						return entries.map((entry): MemoryFileInfo => ({
							path: entry.path,
							size: entry.content_size_bytes,
							updated_at: DateTime.toEpochMillis(entry.updated_at),
						}))
					}),
				),
			read: (name, path) =>
				run(
					Effect.gen(function* () {
						const storeId = storeOf(name)
						if (storeId === undefined || !isMemoryPath(path)) {
							return null
						}
						const status = yield* statusOf(storeId)
						if (status !== "active" && status !== "archived") {
							return null
						}
						const memoryId = MemoryId.make(yield* memoryIdOf(digest, storeId, path))
						const committed = yield* memories.get(memoryId)
						if (committed.status !== "present" || committed.memory_store_id !== storeId) {
							return null
						}
						// The content view can lag the memory it shows: wait for the committed content.
						const view = yield* Effect.flatMap(views.get(Memory.ref(memoryId)), (shown) =>
							Option.isSome(shown) &&
							shown.value !== null &&
							shown.value.content_sha256 === committed.content_sha256
								? Effect.succeed(shown.value)
								: Effect.fail("lagging" as const),
						).pipe(Effect.retry(CONTENT_WAIT))
						return { content: view.content, content_sha256: view.content_sha256 }
					}),
				),
			write: (name, path, content, base) =>
				run(
					Effect.gen(function* () {
						const storeId = yield* writableStore(name)
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
						// A store's memories are files, where a path cannot be both a file and a directory.
						const entries = Option.match(yield* index.get(MemoryStore.ref(storeId)), {
							onNone: () => [],
							onSome: (state) => state.entries,
						})
						const clash = entries.find((entry) => holdsOrIsHeldBy(entry.path, path))
						if (clash !== undefined) {
							return refused("EISDIR", `${path} conflicts with ${clash.path}.`)
						}
						const memoryId = MemoryId.make(yield* memoryIdOf(digest, storeId, path))
						return yield* writeMemory
							.send(
								new WriteMemory({
									memory_id: memoryId,
									memory_store_id: storeId,
									path,
									content,
									...measured,
									precondition:
										base === null
											? { type: "absent" }
											: base === undefined
												? { type: "none" }
												: { type: "content_sha256", content_sha256: base },
									session_id: sessionId,
								}),
								{
									commandId: `memory:${sessionId}:${turn}:${memoryId}:${base ?? String(base)}:${measured.content_sha256}`,
								},
							)
							.pipe(
								Effect.as<MemoryOutcome>({ ok: true, content_sha256: measured.content_sha256 }),
								Effect.catchTag(
									[
										"MemoryStoreNotFound",
										"MemoryStoreArchived",
										"MemoryStoreFull",
										"MemoryAlreadyExists",
										"MemoryNotFound",
										"MemoryPreconditionFailed",
										"MemoryPlacedElsewhere",
									],
									(error) => Effect.succeed(rejection(error._tag, path)),
								),
							)
					}),
				),
			remove: (name, path, base) =>
				run(
					Effect.gen(function* () {
						const storeId = yield* writableStore(name)
						if (typeof storeId !== "string") {
							return storeId
						}
						const memoryId = MemoryId.make(yield* memoryIdOf(digest, storeId, path))
						const expected = base ?? (yield* memories.get(memoryId)).content_sha256
						return yield* deleteMemory
							.send(
								new DeleteMemory({
									memory_id: memoryId,
									memory_store_id: storeId,
									expected_content_sha256: expected.length === 0 ? null : expected,
									session_id: sessionId,
								}),
								{ commandId: `memory:${sessionId}:${turn}:${memoryId}:deleted:${expected}` },
							)
							.pipe(
								Effect.as<MemoryOutcome>({ ok: true, content_sha256: expected }),
								Effect.catchTag(
									[
										"MemoryStoreNotFound",
										"MemoryStoreArchived",
										"MemoryNotFound",
										"MemoryPreconditionFailed",
									],
									(error) =>
										Effect.succeed(
											error._tag === "MemoryNotFound"
												? refused("ENOENT", `No memory at ${path}.`)
												: rejection(error._tag, path),
										),
								),
							)
					}),
				),
		}
	}
})
