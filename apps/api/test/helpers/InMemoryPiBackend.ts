import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context"
import type { Models } from "@earendil-works/pi-ai/models"
import {
	Harness as PiHarnessRuntime,
	MemoryStorage,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable"
import type { Cursor, Id, Storage } from "@earendil-works/pi-durable"
import * as Effect from "effect/Effect"
import * as Semaphore from "effect/Semaphore"
import { PI_HARNESS_SETTINGS } from "../../src/Pi/PiContextBudget.ts"
import {
	finalizeSettledTurnFromStorage,
	omitTurnEntriesFromStorage,
	readAssistantMessageFromStorage,
	readUnansweredSubmissionFromStorage,
	restoreRefusalEntryInStorage,
} from "../../src/Pi/PiDurableEngine.ts"
import type { PiDurableBackend } from "../../src/Pi/PiDurableEngine.ts"
import { createCheckfuRegistry } from "../../src/Pi/PiRefusals.ts"
import { CHECKFU_PI_DOCS, beginTurnUsage, settleTurnUsage } from "../../src/Pi/PiTurnUsage.ts"

export interface InMemoryEntryScanCall {
	readonly minEntryId?: number
	readonly maxEntryId?: number
	readonly order?: string
	readonly limit: number
}

export interface InMemoryPiDurableBackend extends PiDurableBackend {
	readonly storage: InMemoryStorage
	readonly countEntries: () => Promise<number>
	readonly getScanEntryCalls: () => ReadonlyArray<InMemoryEntryScanCall>
	readonly clearScanEntryCalls: () => void
	readonly close: () => Promise<void>
	/** Ends this object as a reset does: nothing it does afterwards reaches the storage. */
	readonly retire: () => void
}

export type InMemoryStorage = InstrumentedMemoryStorage

class InstrumentedMemoryStorage extends MemoryStorage {
	readonly scanEntryCalls: Array<InMemoryEntryScanCall> = []
	readonly cancelledOps = new Set<string>()

	override commit(
		batches: Parameters<Storage["commit"]>[0],
		receive: Parameters<Storage["commit"]>[1],
		context: Parameters<Storage["commit"]>[2],
	): ReturnType<Storage["commit"]> {
		for (const batch of batches) {
			for (const write of batch) {
				if (
					(write.type === "document.create" || write.type === "document.copy") &&
					!write.record.kind.startsWith("pi.") &&
					!CHECKFU_PI_DOCS.some((spec) => spec.token.definition.kind === write.record.kind)
				) {
					return Promise.reject(
						new Error(
							`Unregistered Pi durable document "${write.record.kind}" was persisted without registering it in CHECKFU_PI_DOCS.`,
						),
					)
				}
			}
		}
		return super.commit(batches, receive, context)
	}

	override scanEntries(
		query: Parameters<Storage["scanEntries"]>[0],
		limit: Parameters<Storage["scanEntries"]>[1],
		cursor: Parameters<Storage["scanEntries"]>[2],
		context: Parameters<Storage["scanEntries"]>[3],
	): ReturnType<Storage["scanEntries"]> {
		this.scanEntryCalls.push({
			...(query.minEntryId === undefined ? {} : { minEntryId: query.minEntryId }),
			...(query.maxEntryId === undefined ? {} : { maxEntryId: query.maxEntryId }),
			...(query.order === undefined ? {} : { order: query.order }),
			limit,
		})
		return super.scanEntries(query, limit, cursor, context)
	}
}

// The overload that names the conversation; the other takes the entry id and the context.
type EntryLookup = Parameters<Storage["entry"]>
type EntryResult = ReturnType<Storage["entry"]>

/**
 * One session object's view of the storage. A reset object's isolate is gone, so a call it
 * was still running can neither read nor write what the next object owns.
 */
class ObjectStorage implements Storage {
	readonly #shared: InstrumentedMemoryStorage
	#retired = false

	constructor(shared: InstrumentedMemoryStorage) {
		this.#shared = shared
	}

	retire(): void {
		this.#retired = true
	}

	/** The session object's fence table, which survives a reset with the rest of its storage. */
	fence(): Set<string> {
		return this.#live().cancelledOps
	}

	#live(): InstrumentedMemoryStorage {
		if (this.#retired) {
			throw new Error("This session object was reset")
		}
		return this.#shared
	}

	commit(...args: Parameters<Storage["commit"]>) {
		return this.#live().commit(...args)
	}
	mintId<I extends Id<string>>(): Promise<I> {
		return this.#live().mintId<I>()
	}
	conversation(...args: Parameters<Storage["conversation"]>) {
		return this.#live().conversation(...args)
	}
	scanConversations(...args: Parameters<Storage["scanConversations"]>) {
		return this.#live().scanConversations(...args)
	}
	entry(id: EntryLookup[1], context: EntryLookup[2]): EntryResult
	entry(conversationId: EntryLookup[0], id: EntryLookup[1], context: EntryLookup[2]): EntryResult
	entry(...args: [EntryLookup[1], EntryLookup[2]] | EntryLookup): EntryResult {
		const live = this.#live()
		return args.length === 2 ? live.entry(args[0], args[1]) : live.entry(args[0], args[1], args[2])
	}
	findLatestHeadMarker(...args: Parameters<Storage["findLatestHeadMarker"]>) {
		return this.#live().findLatestHeadMarker(...args)
	}
	scanEntries(...args: Parameters<Storage["scanEntries"]>) {
		return this.#live().scanEntries(...args)
	}
	task(...args: Parameters<Storage["task"]>) {
		return this.#live().task(...args)
	}
	scanTasks(...args: Parameters<Storage["scanTasks"]>) {
		return this.#live().scanTasks(...args)
	}
	submission(...args: Parameters<Storage["submission"]>) {
		return this.#live().submission(...args)
	}
	scanSubmissions(...args: Parameters<Storage["scanSubmissions"]>) {
		return this.#live().scanSubmissions(...args)
	}
	submissionByRequest(...args: Parameters<Storage["submissionByRequest"]>) {
		return this.#live().submissionByRequest(...args)
	}
	findDocument(...args: Parameters<Storage["findDocument"]>) {
		return this.#live().findDocument(...args)
	}
	document(...args: Parameters<Storage["document"]>) {
		return this.#live().document(...args)
	}
	scanDocuments(...args: Parameters<Storage["scanDocuments"]>) {
		return this.#live().scanDocuments(...args)
	}
	close(...args: Parameters<Storage["close"]>) {
		return this.#live().close(...args)
	}
}

/**
 * In-process `pi-durable` backend backed by `MemoryStorage`.
 * Runs the real `@earendil-works/pi-durable` `Harness.open` loop (conversations,
 * submissions, generation task, retries, abort, and durable entries) for Node/Bun tests.
 */
export const createInMemoryPiDurableBackend = async (
	models: Models,
	retryBaseDelayMs = 1,
	registry = createCheckfuRegistry(),
	hasApiKey: PiDurableBackend["hasApiKey"] = () => true,
	object: {
		/** Reopen Pi over another backend's storage, as a reset Durable Object does. */
		readonly storage?: InMemoryStorage
		readonly reset?: PiDurableBackend["reset"]
	} = {},
): Promise<InMemoryPiDurableBackend> => {
	const shared = object.storage ?? new InstrumentedMemoryStorage()
	const { scanEntryCalls } = shared
	const storage = new ObjectStorage(shared)
	// Kept with the storage, as the session object's fence table is, so it survives a reset.
	const cancelledOps = {
		has: (operationId: string) => storage.fence().has(operationId),
		add: (operationId: string) => storage.fence().add(operationId),
	}
	const lock = Semaphore.makeUnsafe(1)
	const withLock: PiDurableBackend["withLock"] = (effect) =>
		lock.withPermit(Effect.uninterruptible(effect))

	const pi = await PiHarnessRuntime.open(
		storage,
		{
			models,
			registry,
			settings: {
				...PI_HARNESS_SETTINGS,
				retry: { ...PI_HARNESS_SETTINGS.retry, baseDelayMs: retryBaseDelayMs },
			},
		},
		BACKGROUND_CONTEXT,
	)
	pi.resume()

	return {
		storage: shared,
		withLock,
		hasApiKey,
		reset: object.reset ?? Effect.die(new Error("The Pi session object was reset")),
		isCancelled: (operationId) => cancelledOps.has(operationId),
		beginUsage: (operationId, turn, finalizedPrevious) =>
			beginTurnUsage(pi, operationId, turn, finalizedPrevious),
		settleUsage: (operationId) => settleTurnUsage(pi, operationId),
		hasSubmission: async (operationId) =>
			(await storage.submissionByRequest(ROOT_CONVERSATION_ID, operationId, BACKGROUND_CONTEXT)) !==
			undefined,
		ensureRoot: async (agent) => {
			const existing = await pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
			if (existing === undefined) {
				await pi.root(BACKGROUND_CONTEXT, { agent })
			} else {
				await existing.configure(agent, BACKGROUND_CONTEXT)
			}
		},
		submit: async (text, operationId) => {
			const conversation = await pi.root(BACKGROUND_CONTEXT)
			await conversation.submit(
				{
					type: "input",
					content: text,
					whenBusy: "followUp",
					onAbort: "keep",
					requestId: operationId,
				},
				BACKGROUND_CONTEXT,
			)
		},
		wait: async (operationId, signal) => {
			const ctx =
				signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
			const record = await storage.submissionByRequest(ROOT_CONVERSATION_ID, operationId, ctx)
			if (record === undefined) {
				return { status: "unanswered", reason: "not_found" }
			}
			const submission = await pi.submission(record.id, ctx)
			if (submission === undefined) {
				return { status: "unanswered", reason: "not_found" }
			}
			const settled = await submission.wait(ctx)
			if (settled.status === "unanswered") {
				return { status: "unanswered", reason: settled.reason }
			}
			return { status: "done" }
		},
		abort: (operationId) =>
			// Match `PiSession.do.ts`: once cancellation is recorded, keep permit
			// acquisition and abort delivery uninterruptible so an interrupted
			// abort cannot strand an in-flight `submit`.
			Effect.uninterruptible(
				Effect.suspend(() => {
					cancelledOps.add(operationId)
					return withLock(
						Effect.promise(async () => {
							const record = await storage.submissionByRequest(
								ROOT_CONVERSATION_ID,
								operationId,
								BACKGROUND_CONTEXT,
							)
							if (
								record === undefined ||
								record.status === "done" ||
								record.status === "unanswered"
							) {
								return true
							}
							const outcome = await pi.abortSubmission(
								record.id,
								BACKGROUND_CONTEXT,
								ROOT_CONVERSATION_ID,
							)
							if (outcome === "already_placed") {
								const conversation = await pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
								await conversation?.abort(BACKGROUND_CONTEXT)
								return true
							}
							return outcome === "aborted"
						}),
					)
				}),
			),
		readAnswerEntry: (operationId) => readAssistantMessageFromStorage(pi, storage, operationId),
		readUnansweredSubmission: (operationId) =>
			readUnansweredSubmissionFromStorage(pi, storage, operationId),
		restoreRefusal: (operationId, entryId, message) =>
			restoreRefusalEntryInStorage(pi, operationId, entryId, message),
		omitEntries: (operationId) => omitTurnEntriesFromStorage(pi, storage, operationId),
		finalizePrevious: (operationId) => finalizeSettledTurnFromStorage(pi, storage, operationId),
		countEntries: async () => {
			let total = 0
			let cursor: Cursor | undefined
			do {
				const page = await storage.scanEntries(
					{ conversationId: ROOT_CONVERSATION_ID },
					256,
					cursor,
					BACKGROUND_CONTEXT,
				)
				total += page.items.length
				cursor = page.next
			} while (cursor !== undefined)
			return total
		},
		getScanEntryCalls: () => [...scanEntryCalls],
		clearScanEntryCalls: () => {
			scanEntryCalls.length = 0
		},
		close: () => pi.close(BACKGROUND_CONTEXT),
		retire: () => {
			storage.retire()
		},
	}
}
