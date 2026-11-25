import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context"
import type { Models } from "@earendil-works/pi-ai/models"
import {
	Harness as PiHarnessRuntime,
	MemoryStorage,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable"
import type { Id, Storage } from "@earendil-works/pi-durable"
import * as Effect from "effect/Effect"
import * as Semaphore from "effect/Semaphore"
import { PI_HARNESS_SETTINGS } from "../../src/Pi/PiContextBudget.ts"
import type { PiDurableBackend } from "../../src/Pi/PiDurableEngine.ts"
import { createCheckfuRegistry } from "../../src/Pi/PiRefusals.ts"
import { CHECKFU_PI_DOCS } from "../../src/Pi/PiTurnUsage.ts"

export interface InMemoryPiDurableBackend extends PiDurableBackend {
	readonly storage: InMemoryStorage
	readonly close: () => Promise<void>
	readonly retire: () => void
}

export type InMemoryStorage = InstrumentedMemoryStorage

class InstrumentedMemoryStorage extends MemoryStorage {
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
}

type EntryLookup = Parameters<Storage["entry"]>
type EntryResult = ReturnType<Storage["entry"]>

class ObjectStorage implements Storage {
	readonly #shared: InstrumentedMemoryStorage
	#retired = false

	constructor(shared: InstrumentedMemoryStorage) {
		this.#shared = shared
	}

	retire(): void {
		this.#retired = true
	}

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

export const createInMemoryPiDurableBackend = async (
	models: Models,
	retryBaseDelayMs = 1,
	registry = createCheckfuRegistry(),
	hasApiKey: PiDurableBackend["hasApiKey"] = () => true,
	object: {
		readonly storage?: InMemoryStorage
		readonly reset?: PiDurableBackend["reset"]
	} = {},
): Promise<InMemoryPiDurableBackend> => {
	const shared = object.storage ?? new InstrumentedMemoryStorage()
	const storage = new ObjectStorage(shared)
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
		enterWorkspace: () => Promise.resolve(true),
		pi: () => Promise.resolve(pi),
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
		close: () => pi.close(BACKGROUND_CONTEXT),
		retire: () => {
			storage.retire()
		},
	}
}
