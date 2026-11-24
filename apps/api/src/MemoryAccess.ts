import { Memory } from "@checkfu/domain/Memory/Memory.aggregate"
import type { MemoryId } from "@checkfu/domain/Memory/Memory.id"
import { MemoryIndex } from "@checkfu/domain/Memory/MemoryIndex.view"
import { MemoryStore } from "@checkfu/domain/Memory/MemoryStore.aggregate"
import type { MemoryStoreId } from "@checkfu/domain/Memory/MemoryStore.id"
import type { WritePrecondition } from "@checkfu/domain/Memory/MemoryTypes"
import { MemoryView } from "@checkfu/domain/Memory/MemoryView.view"
import { WriteMemory } from "@checkfu/domain/Memory/WriteMemory.command"
import { WriteMemoryDecision } from "@checkfu/domain/Memory/WriteMemory.decision"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"

// How memories are read and written, for the HTTP API and for a session's workspace alike.

export class MemoryPathConflict extends Schema.TaggedError<
	MemoryPathConflict,
	{ readonly brand: unique symbol }
>()("MemoryPathConflict", { path: Schema.String, conflicts_with: Schema.String }) {}

/** A view did not catch up with what was committed within the wait. */
export class MemoryViewLagging extends Schema.TaggedError<
	MemoryViewLagging,
	{ readonly brand: unique symbol }
>()("MemoryViewLagging", {}) {}

/** A path cannot be both a memory and a directory of memories. */
export const holdsOrIsHeldBy = (a: string, b: string): boolean =>
	a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

const VIEW_WAIT = { schedule: Schedule.spaced("25 millis"), times: 200 } as const

// A create that lost a race to another create or delete in the same store checks its path again.
const LAYOUT_ATTEMPTS = 5

export interface MemoryWrite {
	readonly storeId: MemoryStoreId
	readonly memoryId: MemoryId
	readonly path: string
	readonly content: string
	readonly content_sha256: string
	readonly content_size_bytes: number
	readonly precondition: WritePrecondition
	readonly sessionId: string | null
	/** Names this one write, so a retry of it is not written twice. */
	readonly commandId?: string
}

export const MemoryAccess = Effect.gen(function* () {
	const stores = yield* MemoryStore
	const memories = yield* Memory
	const index = yield* MemoryIndex
	const views = yield* MemoryView
	const writeMemory = yield* WriteMemoryDecision

	/** The store's index once it holds every create and delete the store has committed. */
	const currentIndex = (storeId: MemoryStoreId) =>
		Effect.gen(function* () {
			const { layout_version } = yield* stores.get(storeId)
			return yield* Effect.flatMap(index.get(MemoryStore.ref(storeId)), (found) => {
				const shown = Option.getOrElse(found, () => ({ entries: [], layout_version: 0 }))
				return shown.layout_version >= layout_version
					? Effect.succeed(shown)
					: Effect.fail(new MemoryViewLagging())
			}).pipe(Effect.retry(VIEW_WAIT))
		})

	/**
	 * Writes a memory. A new path is checked against the store's other paths in an index that holds
	 * every create and delete so far, and the write commits only if none happened since.
	 */
	const write = (request: MemoryWrite) =>
		Effect.gen(function* () {
			const current = yield* currentIndex(request.storeId)
			const clash = current.entries.find((entry) => holdsOrIsHeldBy(entry.path, request.path))
			if (clash !== undefined) {
				return yield* new MemoryPathConflict({
					path: request.path,
					conflicts_with: clash.path,
				})
			}
			return yield* writeMemory.send(
				new WriteMemory({
					memory_id: request.memoryId,
					memory_store_id: request.storeId,
					path: request.path,
					content: request.content,
					content_sha256: request.content_sha256,
					content_size_bytes: request.content_size_bytes,
					precondition: request.precondition,
					layout_version: current.layout_version,
					session_id: request.sessionId,
				}),
				// Each layout it is checked at is its own attempt, so a retry is not answered with the
				// refusal of the one before.
				...(request.commandId === undefined
					? []
					: [{ commandId: `${request.commandId}@${current.layout_version}` }]),
			)
		}).pipe(
			Effect.retry({
				while: (error) => error._tag === "MemoryLayoutChanged",
				times: LAYOUT_ATTEMPTS,
			}),
		)

	/**
	 * A memory as committed, or a later version of it: null when it is not present in the store.
	 * The content view can lag the memory, so a read waits for it, asking the memory again each
	 * time in case it changed or went away meanwhile.
	 */
	const read = (storeId: MemoryStoreId, memoryId: MemoryId) =>
		Effect.gen(function* () {
			const committed = yield* memories.get(memoryId)
			if (committed.status !== "present" || committed.memory_store_id !== storeId) {
				return null
			}
			const shown = Option.getOrNull(yield* views.get(Memory.ref(memoryId)))
			return shown !== null && shown.version >= committed.version
				? shown
				: yield* new MemoryViewLagging()
		}).pipe(Effect.retry({ ...VIEW_WAIT, while: (error) => error._tag === "MemoryViewLagging" }))

	return { currentIndex, write, read }
})
