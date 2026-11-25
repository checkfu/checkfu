import { ArchiveMemoryStore } from "@checkfu/domain/Memory/ArchiveMemoryStore.command"
import { CreateMemoryStore } from "@checkfu/domain/Memory/CreateMemoryStore.command"
import { DeleteMemory } from "@checkfu/domain/Memory/DeleteMemory.command"
import { DeleteMemoryDecision } from "@checkfu/domain/Memory/DeleteMemory.decision"
import { DeleteMemoryStore } from "@checkfu/domain/Memory/DeleteMemoryStore.command"
import { Memory } from "@checkfu/domain/Memory/Memory.aggregate"
import { MemoryId } from "@checkfu/domain/Memory/Memory.id"
import { MemoryStore } from "@checkfu/domain/Memory/MemoryStore.aggregate"
import { MemoryStoreId } from "@checkfu/domain/Memory/MemoryStore.id"
import { MemoryStoreView } from "@checkfu/domain/Memory/MemoryStoreView.view"
import { MAX_MEMORY_CONTENT_BYTES } from "@checkfu/domain/Memory/MemoryTypes"
import type { WritePrecondition } from "@checkfu/domain/Memory/MemoryTypes"
import { MemoryView } from "@checkfu/domain/Memory/MemoryView.view"
import { UpdateMemoryStore } from "@checkfu/domain/Memory/UpdateMemoryStore.command"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { MemoryAccess } from "../MemoryAccess.ts"
import { CheckfuApi } from "./Api.ts"
import { makeLister } from "./Listing.ts"
import {
	archiveAndRead,
	bestEffortAfterCommit,
	commitForStream,
	createIdentity,
	IDEMPOTENCY_KEY_REUSED,
	handled,
	isPending,
	measureContent,
	memoryIdOf,
	orPending,
	orPendingWithin,
	present,
	readExisting,
	reject,
} from "./HttpHelpers.ts"

export const MemoryReadWaitTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/MemoryReadWaitTimeout",
	{ defaultValue: () => "5 seconds" },
)

const isDirectChild = (path: string, prefix: string): boolean =>
	!path.slice(prefix.length).includes("/")

export const MemoryStoresLive = HttpApiBuilder.group(CheckfuApi, "memory_stores", (handlers) =>
	Effect.gen(function* () {
		const stores = yield* MemoryStore
		const storeViews = yield* MemoryStoreView
		const memoryViews = yield* MemoryView
		const access = yield* MemoryAccess
		const deleteMemory = yield* DeleteMemoryDecision
		const list = yield* makeLister
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom

		const storeMissing = (id: MemoryStoreId) =>
			Effect.flatMap(stores.get(id), (committed) =>
				committed.status === "" || committed.status === "deleted"
					? reject(404, `Memory store ${id} not found.`)
					: Effect.void,
			)

		// Asked of the aggregate first: a store's row can outlive its deletion.
		const existingStore = (id: MemoryStoreId) => {
			const ref = MemoryStore.ref(id)
			return readExisting({
				missingFirst: true,
				current: storeViews.get(ref),
				missing: storeMissing(id),
				projected: Effect.flatMap(MemoryReadWaitTimeout, (timeout) =>
					storeViews.waitFor(ref, { id }, { timeout }),
				),
			})
		}

		const write = (
			storeId: MemoryStoreId,
			memoryId: MemoryId,
			path: string,
			content: string,
			precondition: WritePrecondition,
		) =>
			Effect.gen(function* () {
				const measured = yield* measureContent(digest, content)
				if (measured.content_size_bytes > MAX_MEMORY_CONTENT_BYTES) {
					return yield* reject(
						400,
						`A memory holds at most ${MAX_MEMORY_CONTENT_BYTES} bytes; this one is ${measured.content_size_bytes}.`,
					)
				}
				const receipt = yield* access
					.write({
						storeId,
						memoryId,
						path,
						content,
						...measured,
						precondition,
						sessionId: null,
					})
					.pipe(
						Effect.catchTags({
							MemoryPathConflict: ({ conflicts_with }) =>
								reject(
									409,
									`Memory path ${path} conflicts with ${conflicts_with}: a path cannot be both a memory and a directory of memories.`,
								),
							MemoryViewLagging: () => reject(503, "Timed out waiting for view consistency."),
						}),
					)
				const commit = commitForStream(receipt.commits, `Memory/${memoryId}`)
				const result = yield* memoryViews
					.get(Memory.ref(memoryId), commit === undefined ? {} : { atLeast: commit })
					.pipe(orPendingWithin(memoryId, "memory", { memory_store_id: storeId }))
				if (isPending(result)) {
					return result
				}
				const written = yield* present(result, 404, `Memory ${memoryId} not found.`)
				// Another writer's version can land before this read. Its hash is not this write's, and
				// a caller using it as a precondition would overwrite that change; as for an
				// environment, the answer is that the write is pending.
				if (written.version !== receipt.reply.version) {
					return {
						id: memoryId,
						type: "memory" as const,
						pending: true as const,
						memory_store_id: storeId,
					}
				}
				return written
			})

		// A memory read through its own id must belong to the store in the path, and be there as
		// committed: a deleted memory's row can outlive it.
		const existingMemory = (storeId: MemoryStoreId, memoryId: MemoryId) =>
			Effect.gen(function* () {
				yield* storeMissing(storeId)
				const found = yield* access
					.read(storeId, memoryId)
					.pipe(
						Effect.catchTag("MemoryViewLagging", () =>
							reject(503, "Timed out waiting for view consistency."),
						),
					)
				return found ?? (yield* reject(404, `Memory ${memoryId} not found in store ${storeId}.`))
			})

		return handlers
			.handle("create", ({ payload, request }) =>
				Effect.gen(function* () {
					const description = payload.description ?? ""
					const identity = yield* createIdentity(
						{ digest, random },
						"memory_store",
						"memstore",
						request.headers["idempotency-key"],
						{ name: payload.name, description },
					)
					const id = MemoryStoreId.make(identity.id)
					const receipt = yield* stores
						.send(
							new CreateMemoryStore({ memory_store_id: id, name: payload.name, description }),
							identity.sendOptions,
						)
						.pipe(
							Effect.catchTag("MemoryStoreAlreadyExists", () =>
								reject(409, IDEMPOTENCY_KEY_REUSED),
							),
						)
					const result = yield* storeViews
						.get(MemoryStore.ref(id), { atLeast: receipt })
						.pipe(orPending(id, "memory_store"))
					if (isPending(result)) {
						return result
					}
					return yield* present(result, 404, `Memory store ${id} not found.`)
				}).pipe(handled),
			)
			.handle("list", ({ query }) =>
				list("memory_store", query, (id) => existingStore(MemoryStoreId.make(id))).pipe(handled),
			)
			.handle("get", ({ params }) => existingStore(params.memory_store_id).pipe(handled))
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const id = params.memory_store_id
					const receipt = yield* stores.send(
						new UpdateMemoryStore({ memory_store_id: id, changes: payload }),
					)
					const result = yield* storeViews
						.get(MemoryStore.ref(id), { atLeast: receipt })
						.pipe(orPending(id, "memory_store"))
					if (isPending(result)) {
						return result
					}
					return yield* present(result, 404, `Memory store ${id} not found.`)
				}).pipe(handled),
			)
			.handle("archive", ({ params }) =>
				archiveAndRead(
					params.memory_store_id,
					"memory_store",
					"Memory store",
					stores.send(new ArchiveMemoryStore({ memory_store_id: params.memory_store_id })),
					(receipt) =>
						storeViews.get(MemoryStore.ref(params.memory_store_id), { atLeast: receipt }),
				).pipe(handled),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const id = params.memory_store_id
					const receipt = yield* stores.send(new DeleteMemoryStore({ memory_store_id: id }))
					yield* storeViews
						.get(MemoryStore.ref(id), { atLeast: receipt })
						.pipe(bestEffortAfterCommit)
					return { id, type: "memory_store_deleted" as const }
				}).pipe(handled),
			)
			.handle("createMemory", ({ params, payload }) =>
				Effect.gen(function* () {
					const storeId = params.memory_store_id
					// The index outlives its store: a deleted store's old paths must not answer for it.
					yield* storeMissing(storeId)
					const memoryId = MemoryId.make(yield* memoryIdOf(digest, storeId, payload.path))
					return yield* write(storeId, memoryId, payload.path, payload.content, {
						type: "absent",
					})
				}).pipe(handled),
			)
			.handle("listMemories", ({ params, query }) =>
				Effect.gen(function* () {
					const storeId = params.memory_store_id
					yield* storeMissing(storeId)
					const prefix = query.path_prefix ?? "/"
					if (!prefix.startsWith("/") || !prefix.endsWith("/")) {
						return yield* reject(400, "path_prefix must start and end with /.")
					}
					// The store's own creates and deletes are all listed, so a listing follows a write.
					const { entries } = yield* access
						.currentIndex(storeId)
						.pipe(
							Effect.catchTag("MemoryViewLagging", () =>
								reject(503, "Timed out waiting for view consistency."),
							),
						)
					return {
						data: entries
							.filter(
								(entry) =>
									entry.path.startsWith(prefix) &&
									(query.depth !== "1" || isDirectChild(entry.path, prefix)),
							)
							.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
							.map((entry) => ({
								...entry,
								type: "memory" as const,
								memory_store_id: storeId,
							})),
					}
				}).pipe(handled),
			)
			.handle("getMemory", ({ params }) =>
				existingMemory(params.memory_store_id, params.memory_id).pipe(handled),
			)
			.handle("updateMemory", ({ params, payload }) =>
				Effect.gen(function* () {
					const current = yield* existingMemory(params.memory_store_id, params.memory_id)
					return yield* write(
						params.memory_store_id,
						params.memory_id,
						current.path,
						payload.content,
						payload.precondition ?? { type: "present" },
					)
				}).pipe(handled),
			)
			.handle("deleteMemory", ({ params, query }) =>
				Effect.gen(function* () {
					const receipt = yield* deleteMemory.send(
						new DeleteMemory({
							memory_id: params.memory_id,
							memory_store_id: params.memory_store_id,
							expected_content_sha256: query.expected_content_sha256 ?? null,
							session_id: null,
						}),
					)
					const commit = commitForStream(receipt.commits, `Memory/${params.memory_id}`)
					yield* memoryViews
						.get(Memory.ref(params.memory_id), commit === undefined ? {} : { atLeast: commit })
						.pipe(bestEffortAfterCommit)
					return { id: params.memory_id, type: "memory_deleted" as const }
				}).pipe(handled),
			)
	}),
)
