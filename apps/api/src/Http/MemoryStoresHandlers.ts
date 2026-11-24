import { ArchiveMemoryStore } from "@checkfu/domain/Memory/ArchiveMemoryStore.command"
import { CreateMemoryStore } from "@checkfu/domain/Memory/CreateMemoryStore.command"
import { DeleteMemory } from "@checkfu/domain/Memory/DeleteMemory.command"
import { DeleteMemoryDecision } from "@checkfu/domain/Memory/DeleteMemory.decision"
import { DeleteMemoryStore } from "@checkfu/domain/Memory/DeleteMemoryStore.command"
import { Memory } from "@checkfu/domain/Memory/Memory.aggregate"
import { MemoryId } from "@checkfu/domain/Memory/Memory.id"
import { MemoryIndex } from "@checkfu/domain/Memory/MemoryIndex.view"
import { MemoryStore } from "@checkfu/domain/Memory/MemoryStore.aggregate"
import { MemoryStoreId } from "@checkfu/domain/Memory/MemoryStore.id"
import { MemoryStoreView } from "@checkfu/domain/Memory/MemoryStoreView.view"
import { MAX_MEMORY_CONTENT_BYTES } from "@checkfu/domain/Memory/MemoryTypes"
import type { WritePrecondition } from "@checkfu/domain/Memory/MemoryTypes"
import { MemoryView } from "@checkfu/domain/Memory/MemoryView.view"
import { UpdateMemoryStore } from "@checkfu/domain/Memory/UpdateMemoryStore.command"
import { WriteMemory } from "@checkfu/domain/Memory/WriteMemory.command"
import { WriteMemoryDecision } from "@checkfu/domain/Memory/WriteMemory.decision"
import { IdempotencyClaim } from "@checkfu/domain/IdempotencyClaim/IdempotencyClaim.aggregate"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Option from "effect/Option"
import { CheckfuApi } from "./Api.ts"
import {
	archiveAndRead,
	bestEffortAfterCommit,
	commitForStream,
	createIdentity,
	handled,
	isPending,
	measureContent,
	memoryIdOf,
	orPending,
	present,
	readExisting,
	reject,
} from "./HttpHelpers.ts"

export const MemoryReadWaitTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/MemoryReadWaitTimeout",
	{ defaultValue: () => "5 seconds" },
)

const holdsOrIsHeldBy = (a: string, b: string): boolean =>
	a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

const isDirectChild = (path: string, prefix: string): boolean =>
	!path.slice(prefix.length).includes("/")

export const MemoryStoresLive = HttpApiBuilder.group(CheckfuApi, "memory_stores", (handlers) =>
	Effect.gen(function* () {
		const stores = yield* MemoryStore
		const storeViews = yield* MemoryStoreView
		const memories = yield* Memory
		const memoryViews = yield* MemoryView
		const index = yield* MemoryIndex
		const writeMemory = yield* WriteMemoryDecision
		const deleteMemory = yield* DeleteMemoryDecision
		const idempotencyClaims = yield* IdempotencyClaim
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
				const receipt = yield* writeMemory.send(
					new WriteMemory({
						memory_id: memoryId,
						memory_store_id: storeId,
						path,
						content,
						...measured,
						precondition,
						session_id: null,
					}),
				)
				const commit = commitForStream(receipt.commits, `Memory/${memoryId}`)
				const result = yield* memoryViews
					.get(Memory.ref(memoryId), commit === undefined ? {} : { atLeast: commit })
					.pipe(orPending(memoryId, "memory"))
				if (isPending(result)) {
					return result
				}
				return yield* present(result, 404, `Memory ${memoryId} not found.`)
			})

		// A memory read through its own id must belong to the store in the path.
		const existingMemory = (storeId: MemoryStoreId, memoryId: MemoryId) => {
			const ref = Memory.ref(memoryId)
			const notFound = reject(404, `Memory ${memoryId} not found in store ${storeId}.`)
			return Effect.gen(function* () {
				yield* storeMissing(storeId)
				const found = yield* readExisting({
					current: memoryViews.get(ref),
					missing: Effect.flatMap(memories.get(memoryId), (committed) =>
						committed.status !== "present" || committed.memory_store_id !== storeId
							? notFound
							: Effect.void,
					),
					projected: Effect.flatMap(MemoryReadWaitTimeout, (timeout) =>
						memoryViews.waitFor(ref, { id: memoryId }, { timeout }),
					),
				})
				return found.memory_store_id === storeId ? found : yield* notFound
			})
		}

		return handlers
			.handle("create", ({ payload, request }) =>
				Effect.gen(function* () {
					const description = payload.description ?? ""
					const identity = yield* createIdentity(
						{ idempotencyClaims, digest, random },
						"memory_store",
						"memstore",
						request.headers["idempotency-key"],
						{ name: payload.name, description },
					)
					const id = MemoryStoreId.make(identity.id)
					const receipt = yield* stores.send(
						new CreateMemoryStore({ memory_store_id: id, name: payload.name, description }),
						identity.sendOptions,
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
					const memoryId = MemoryId.make(yield* memoryIdOf(digest, storeId, payload.path))
					// A store is mounted as files, where one path cannot be both a file and a
					// directory. The index is read, not locked: two writers at the same instant can
					// still store such a pair, and a mount then leaves the file out.
					const { entries } = Option.getOrElse(yield* index.get(MemoryStore.ref(storeId)), () => ({
						entries: [],
					}))
					const clash = entries.find((entry) => holdsOrIsHeldBy(entry.path, payload.path))
					if (clash !== undefined) {
						return yield* reject(
							409,
							`Memory path ${payload.path} conflicts with ${clash.path}: a path cannot be both a memory and a directory of memories.`,
						)
					}
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
					const { entries } = Option.getOrElse(yield* index.get(MemoryStore.ref(storeId)), () => ({
						entries: [],
					}))
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
