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
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { commitForStream } from "./Http/HttpHelpers.ts"

export class MemoryPathConflict extends Schema.TaggedError<
	MemoryPathConflict,
	{ readonly brand: unique symbol }
>()("MemoryPathConflict", { path: Schema.String, conflicts_with: Schema.String }) {}

export class MemoryViewLagging extends Schema.TaggedError<
	MemoryViewLagging,
	{ readonly brand: unique symbol }
>()("MemoryViewLagging", {}) {}

export const holdsOrIsHeldBy = (a: string, b: string): boolean =>
	a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

const VIEW_WAIT = "5 seconds"

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
}

export const MemoryAccess = Effect.gen(function* () {
	const stores = yield* MemoryStore
	const memories = yield* Memory
	const index = yield* MemoryIndex
	const views = yield* MemoryView
	const writeMemory = yield* WriteMemoryDecision

	const currentIndex = (storeId: MemoryStoreId) =>
		Effect.gen(function* () {
			const { layout_version } = yield* stores.get(storeId)
			return layout_version === 0
				? { entries: [], layout_version }
				: yield* index
						.waitFor(
							MemoryStore.ref(storeId),
							{ layout_version: { gte: layout_version } },
							{ timeout: VIEW_WAIT },
						)
						.pipe(Effect.catchTag("WaitTimeout", () => Effect.fail(new MemoryViewLagging())))
		})

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
			const receipt = yield* writeMemory.send(
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
			)
			const commit = commitForStream(receipt.commits, `Memory/${request.memoryId}`)
			const listed = yield* index
				.get(MemoryStore.ref(request.storeId), commit === undefined ? {} : { atLeast: commit })
				.pipe(
					Effect.as(true),
					Effect.catchIf(Predicate.isTagged("ConsistencyTimeout"), () => Effect.succeed(false)),
					Effect.catchDefect((defect) =>
						Effect.as(Effect.logError("Read after commit failed", defect), false),
					),
				)
			return { receipt, commit, listed }
		}).pipe(
			Effect.retry({
				while: (error) => error._tag === "MemoryLayoutChanged",
				times: LAYOUT_ATTEMPTS,
			}),
		)

	const read = (storeId: MemoryStoreId, memoryId: MemoryId) =>
		Effect.gen(function* () {
			const committed = yield* memories.get(memoryId)
			if (committed.status !== "present" || committed.memory_store_id !== storeId) {
				return null
			}
			return yield* views
				.waitFor(
					Memory.ref(memoryId),
					{ version: { gte: committed.version } },
					{ timeout: VIEW_WAIT },
				)
				.pipe(
					Effect.catchTag("WaitTimeout", () =>
						Effect.flatMap(memories.get(memoryId), (now) =>
							now.status === "present"
								? Effect.fail(new MemoryViewLagging())
								: Effect.succeed(null),
						),
					),
				)
		})

	return { currentIndex, write, read }
})
