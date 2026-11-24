import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "@checkfu/domain/Agent/AgentVersionByNumberView.view"
import { DEFAULT_TURN_TIMEOUT_MS, boundedHarness } from "@checkfu/domain/Session/Harness.external"
import type {
	HarnessUnavailable,
	TurnFailed,
	TurnInterrupted,
} from "@checkfu/domain/Session/Harness.external"
import { Environment } from "@checkfu/domain/Environment/Environment.aggregate"
import { EnvironmentId } from "@checkfu/domain/Environment/Environment.id"
import type { EnvironmentConfig } from "@checkfu/sdk/Schemas"
import * as Cause from "effect/Cause"
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
import { memoryStoresOf, repositoriesOf } from "@checkfu/domain/Session/SessionResource"
import type { MemoryStoreResource, SessionResources } from "@checkfu/domain/Session/SessionResource"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { resolveCatalogModel } from "./PiCatalog.ts"
import type { PiTurnOutcome, PiTurnRequest } from "./PiTurn.ts"
import type { TurnToken } from "../Workspace/WorkspaceFence.ts"
import { measureContent, memoryIdOf } from "../MemoryIdentity.ts"
import type {
	MemoryChanges,
	MemoryFile,
	MemoryManifestEntry,
	MemoryMount,
	MemorySaved,
	MemoryWrite,
} from "../Workspace/MemorySync.ts"
import type { RepositoryMount, WorkspacePreparation } from "../Workspace/Repositories.ts"

export class HarnessCallFailed extends Schema.TaggedError<
	HarnessCallFailed,
	{ readonly brand: unique symbol }
>()("HarnessCallFailed", { cause: Schema.Unknown }) {}

export const harnessCall = <A, E, R>(
	call: Effect.Effect<A, E, R>,
): Effect.Effect<A, HarnessCallFailed, R> =>
	Effect.catchCause(call, (cause): Effect.Effect<never, HarnessCallFailed> =>
		Cause.hasInterruptsOnly(cause)
			? Effect.interrupt
			: Effect.fail(new HarnessCallFailed({ cause })),
	)

export interface TurnExecutorService {
	readonly recoverTurn: (
		conversation: string,
		operationId: string,
	) => Effect.Effect<PiTurnOutcome | null, HarnessCallFailed>
	readonly runTurn: (
		conversation: string,
		request: PiTurnRequest,
	) => Effect.Effect<PiTurnOutcome, HarnessCallFailed>
	readonly abortTurn: (
		conversation: string,
		operationId: string,
	) => Effect.Effect<void, HarnessCallFailed>
}

export interface WorkspaceExecutorService {
	/** Gives the workspace to this turn; false when a later turn has it or the session has ended. */
	readonly enterWorkspace: (
		sessionId: string,
		token: TurnToken,
	) => Effect.Effect<boolean, HarnessCallFailed>
	readonly prepareWorkspace: (
		sessionId: string,
		token: TurnToken,
		repositories: ReadonlyArray<RepositoryMount>,
		allowedHosts: ReadonlyArray<string> | null,
	) => Effect.Effect<WorkspacePreparation, HarnessCallFailed>
	readonly storeRepositoryToken: (
		sessionId: string,
		resourceId: string,
		token: string,
		replace: boolean,
	) => Effect.Effect<void, HarnessCallFailed>
	readonly mountMemory: (
		sessionId: string,
		token: TurnToken,
		mount: MemoryMount,
	) => Effect.Effect<ReadonlyArray<string>, HarnessCallFailed>
	readonly fillMemory: (
		sessionId: string,
		token: TurnToken,
		mountPath: string,
		memories: ReadonlyArray<MemoryFile>,
	) => Effect.Effect<void, HarnessCallFailed>
	readonly memoryChanges: (
		sessionId: string,
		token: TurnToken,
		mountPath: string,
	) => Effect.Effect<MemoryChanges, HarnessCallFailed>
	readonly memoryContents: (
		sessionId: string,
		token: TurnToken,
		mountPath: string,
		paths: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyArray<MemoryFile>, HarnessCallFailed>
	readonly memorySaved: (
		sessionId: string,
		token: TurnToken,
		mountPath: string,
		saved: MemorySaved,
	) => Effect.Effect<void, HarnessCallFailed>
	readonly discardWorkspace: (sessionId: string) => Effect.Effect<void, HarnessCallFailed>
}

export const HarnessLimits = Context.Reference<{
	readonly attempts: number
	readonly baseDelay: Duration.Input
	readonly interruptTimeout: Duration.Input
	readonly settleMargin: Duration.Input
}>("@checkfu/api/HarnessLimits", {
	defaultValue: () => ({
		attempts: 6,
		baseDelay: "500 millis",
		interruptTimeout: "30 seconds",
		settleMargin: "1 minute",
	}),
})

export const conversationName = (sessionId: string): string => sessionId

const withRetry = <A>(call: Effect.Effect<A, HarnessCallFailed>) =>
	Effect.gen(function* () {
		const { attempts, baseDelay } = yield* HarnessLimits
		return yield* Effect.retry(call, {
			times: attempts - 1,
			schedule: Schedule.exponential(baseDelay).pipe(Schedule.jittered),
		})
	})

export interface PiTurnExecutorService extends TurnExecutorService, WorkspaceExecutorService {}

export class PiTurnExecutor extends Context.Service<PiTurnExecutor, PiTurnExecutorService>()(
	"@checkfu/api/PiTurnExecutor",
) {}

export const AgentVersionLookupTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/AgentVersionLookupTimeout",
	{ defaultValue: () => "5 seconds" },
)

export const HarnessTurnTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/HarnessTurnTimeout",
	{ defaultValue: () => Duration.millis(DEFAULT_TURN_TIMEOUT_MS) },
)

const settleTimeout = Effect.gen(function* () {
	const { settleMargin } = yield* HarnessLimits
	return Duration.sum(
		Duration.fromInputUnsafe(yield* HarnessTurnTimeout),
		Duration.fromInputUnsafe(settleMargin),
	)
})

const turnOperationId = (turn: number) => `turn:${turn}`

// Every turn after the last published reply and before this one.
const unpublishedTurns = (lastReplyTurn: number, turn: number): ReadonlyArray<string> =>
	Array.from({ length: Math.max(0, turn - lastReplyTurn - 1) }, (_, i) =>
		turnOperationId(lastReplyTurn + 1 + i),
	)

const checkoutLabel = ({ checkout }: RepositoryMount): string =>
	checkout === null
		? "default branch"
		: checkout.type === "branch"
			? `branch ${checkout.name}`
			: `commit ${checkout.sha}`

const describeStore = (store: MemoryStoreResource): string =>
	[
		`- ${store.mount_path} (${store.access === "read_only" ? "read-only" : "read and write"}): ${store.name}.`,
		store.description,
		store.instructions ?? "",
	]
		.filter((part) => part.length > 0)
		.join(" ")

/** Tells the model what is mounted where, after the agent's own instructions. */
export const describeMounts = (
	system: string | null,
	repositories: ReadonlyArray<RepositoryMount>,
	stores: ReadonlyArray<MemoryStoreResource> = [],
): string | null => {
	const sections = [
		...(system === null || system.length === 0 ? [] : [system]),
		...(repositories.length === 0
			? []
			: [
					[
						"Repositories mounted in your workspace:",
						...repositories.map(
							(repository) =>
								`- ${repository.mount_path}: ${repository.url} (${checkoutLabel(repository)})`,
						),
					].join("\n"),
				]),
		...(stores.length === 0
			? []
			: [
					[
						"Memory stores mounted in your workspace. Each is a directory of files that outlasts this session; what you change in one is saved when your turn ends:",
						...stores.map(describeStore),
					].join("\n"),
				]),
	]
	return repositories.length === 0 && stores.length === 0 ? system : sections.join("\n\n")
}

// A batch of memories sent to a workspace in one call stays well under an RPC's size limit.
const FILL_BATCH_BYTES = 2_000_000

const MEMORY_UNAVAILABLE: TurnFailed = {
	_tag: "TurnFailed",
	error_type: "memory_store_unavailable",
	message: "Could not copy the session's memory stores into its workspace.",
	terminal: false,
}

const isMemoryPath = Schema.is(MemoryPath)

// The hosts an environment lets a workspace reach: null for any, none when it has no settings.
const allowedHostsOf = (config: EnvironmentConfig | null): ReadonlyArray<string> | null =>
	config === null
		? []
		: config.networking.type === "limited"
			? config.networking.allowed_hosts
			: null

export const PiDurableHarnessLive = boundedHarness(
	Effect.gen(function* () {
		const agentVersionsByNumber = yield* AgentVersionByNumberView
		const environments = yield* Environment
		const executor = yield* PiTurnExecutor
		const memoryIndex = yield* MemoryIndex
		const memoryStores = yield* MemoryStore
		const memoryViews = yield* MemoryView
		const writeMemory = yield* WriteMemoryDecision
		const deleteMemory = yield* DeleteMemoryDecision
		const digest = yield* Digest.Digest

		// Before a turn: the store's memories as files, where the workspace does not have them yet.
		const copyMemoryIn = Effect.fn("PiDurableHarness.copyMemoryIn")(function* (
			sessionId: string,
			token: TurnToken,
			store: MemoryStoreResource,
		) {
			const memoryStoreId = MemoryStoreId.make(store.memory_store_id)
			// The index outlives its store, so a deleted store is mounted as holding nothing,
			// which also removes what an earlier turn copied in.
			const { status } = yield* memoryStores.get(memoryStoreId)
			const { entries } =
				status === "active" || status === "archived"
					? Option.getOrElse(yield* memoryIndex.get(MemoryStore.ref(memoryStoreId)), () => ({
							entries: [],
						}))
					: { entries: [] }
			const needed = new Set(
				yield* withRetry(
					executor.mountMemory(sessionId, token, {
						mount_path: store.mount_path,
						access: status === "active" ? store.access : "read_only",
						manifest: entries.map(({ path, content_sha256 }) => ({ path, content_sha256 })),
					}),
				),
			)
			let batch: Array<MemoryFile> = []
			let batchBytes = 0
			const flush = Effect.suspend(() => {
				const memories = batch
				batch = []
				batchBytes = 0
				return memories.length === 0
					? Effect.void
					: withRetry(executor.fillMemory(sessionId, token, store.mount_path, memories))
			})
			for (const entry of entries.filter(({ path }) => needed.has(path))) {
				const memory = Option.getOrNull(yield* memoryViews.get(Memory.ref(entry.id)))
				if (memory === null) {
					continue
				}
				batch.push({
					path: memory.path,
					content: memory.content,
					content_sha256: memory.content_sha256,
				})
				batchBytes += memory.content_size_bytes
				if (batchBytes >= FILL_BATCH_BYTES) {
					yield* flush
				}
			}
			yield* flush
		})

		// After a turn: what the session changed, sent as commands. A write names the
		// content it replaces, so one that would undo another session's is refused, and
		// the store's version is copied back in before the next turn. What the store
		// takes becomes the workspace's new base; what it refuses stays pending.
		const saveMemoryOut = Effect.fn("PiDurableHarness.saveMemoryOut")(function* (
			sessionId: string,
			token: TurnToken,
			store: MemoryStoreResource,
		) {
			const memoryStoreId = MemoryStoreId.make(store.memory_store_id)
			if ((yield* memoryStores.get(memoryStoreId)).status !== "active") {
				return
			}
			const notSaved = (reason: string, path: string) =>
				Effect.logWarning(reason).pipe(
					Effect.annotateLogs({ sessionId, mount: store.mount_path, path }),
				)
			const changes = yield* executor.memoryChanges(sessionId, token, store.mount_path)
			const written: Array<MemoryManifestEntry> = []
			const deleted: Array<string> = []

			const sendable: Array<MemoryWrite> = []
			for (const change of changes.written) {
				if (isMemoryPath(change.path) && change.size_bytes <= MAX_MEMORY_CONTENT_BYTES) {
					sendable.push(change)
				} else {
					yield* notSaved("Memory not saved: its path or size is not allowed", change.path)
				}
			}
			// Content crosses to this Worker a bounded batch at a time.
			const batches: Array<Array<MemoryWrite>> = []
			let batchBytes = 0
			for (const change of sendable) {
				if (batches.length === 0 || batchBytes + change.size_bytes > FILL_BATCH_BYTES) {
					batches.push([])
					batchBytes = 0
				}
				batches.at(-1)?.push(change)
				batchBytes += change.size_bytes
			}
			for (const batch of batches) {
				const bases = new Map(batch.map((change) => [change.path, change.base]))
				const contents = yield* executor.memoryContents(
					sessionId,
					token,
					store.mount_path,
					batch.map((change) => change.path),
				)
				for (const memory of contents) {
					const base = bases.get(memory.path) ?? null
					const measured = yield* measureContent(digest, memory.content)
					const memoryId = MemoryId.make(yield* memoryIdOf(digest, memoryStoreId, memory.path))
					yield* writeMemory
						.send(
							new WriteMemory({
								memory_id: memoryId,
								memory_store_id: memoryStoreId,
								path: memory.path,
								content: memory.content,
								...measured,
								precondition:
									base === null
										? { type: "absent" }
										: { type: "content_sha256", content_sha256: base },
								session_id: sessionId,
							}),
							{
								commandId: `memory:${sessionId}:${token.turn}:${memoryId}:${measured.content_sha256}`,
							},
						)
						.pipe(
							Effect.andThen(
								Effect.sync(() => {
									written.push({ path: memory.path, content_sha256: measured.content_sha256 })
								}),
							),
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
								(rejection) => notSaved(`Memory not saved: ${rejection._tag}`, memory.path),
							),
						)
				}
			}
			for (const change of changes.deleted) {
				const memoryId = MemoryId.make(yield* memoryIdOf(digest, memoryStoreId, change.path))
				yield* deleteMemory
					.send(
						new DeleteMemory({
							memory_id: memoryId,
							memory_store_id: memoryStoreId,
							expected_content_sha256: change.base,
							session_id: sessionId,
						}),
						{ commandId: `memory:${sessionId}:${token.turn}:${memoryId}:deleted` },
					)
					.pipe(
						Effect.andThen(
							Effect.sync(() => {
								deleted.push(change.path)
							}),
						),
						Effect.catchTag(
							[
								"MemoryStoreNotFound",
								"MemoryStoreArchived",
								"MemoryNotFound",
								"MemoryPreconditionFailed",
							],
							(rejection) => notSaved(`Memory not deleted: ${rejection._tag}`, change.path),
						),
					)
			}
			if (written.length > 0 || deleted.length > 0) {
				yield* executor.memorySaved(sessionId, token, store.mount_path, { written, deleted })
			}
		})

		// A turn's reply stands whether or not its memory was saved: what is not saved stays
		// in the workspace and is sent again when the next turn ends.
		const saveMemory = (sessionId: string, token: TurnToken, resources: SessionResources) =>
			Effect.forEach(
				memoryStoresOf(resources).filter((store) => store.access === "read_write"),
				(store) =>
					saveMemoryOut(sessionId, token, store).pipe(
						Effect.catchCause((cause) =>
							Effect.logError("Memory not saved", sessionId, store.mount_path, cause),
						),
					),
				{ discard: true },
			)

		return {
			runTurn: (args) => {
				const conversation = conversationName(args.session_id)
				const settle = Effect.gen(function* () {
					const operationId = turnOperationId(args.turn)

					// Recover any already-admitted or settled Pi operation before checking
					// mutable prerequisites (views, API keys) so a replay after a RunTurn
					// restart always records Pi's actual outcome instead of diverging from
					// Pi's live conversation history.
					const recovered = yield* withRetry(executor.recoverTurn(conversation, operationId)).pipe(
						Effect.tapError((error) =>
							Effect.logError("Harness unreachable", conversation, error.cause),
						),
						Effect.mapError((): HarnessUnavailable => ({ _tag: "HarnessUnavailable" })),
					)
					if (recovered !== null) {
						yield* saveMemory(args.session_id, { turn: args.turn }, args.resources)
						if (!recovered.ok) {
							return yield* Effect.fail(recovered.error)
						}
						return recovered.reply
					}

					const lookupTimeout = yield* AgentVersionLookupTimeout
					const lookupKey = agentVersionLookupKey(args.agent_id, args.agent_version)
					const missingVersion: TurnFailed = {
						_tag: "TurnFailed",
						error_type: "agent_version_not_found",
						message: `Agent version ${args.agent_id}@${args.agent_version} was not found.`,
						terminal: false,
					}
					const version = yield* agentVersionsByNumber
						.waitFor(lookupKey, { version: args.agent_version }, { timeout: lookupTimeout })
						.pipe(Effect.mapError(() => missingVersion))
					if (version === null) {
						return yield* Effect.fail(missingVersion)
					}

					const resolved = resolveCatalogModel(version.model.id)
					if (resolved === null) {
						return yield* Effect.fail<TurnFailed>({
							_tag: "TurnFailed",
							error_type: "unknown_model_error",
							message: `Unsupported model "${version.model.id}". Only OpenAI and Anthropic models are supported.`,
							terminal: true,
						})
					}

					const userText = args.input.join("\n")
					if (userText.length === 0) {
						return yield* Effect.fail<TurnFailed>({
							_tag: "TurnFailed",
							error_type: "invalid_turn_input",
							message: "Turn contained no user message to send to Pi.",
							terminal: false,
						})
					}

					// The workspace is given to this turn before anything is copied into it, so a late
					// call of an earlier turn can no longer write into what this one copies or saves.
					const token = { turn: args.turn }
					const entered = yield* withRetry(executor.enterWorkspace(args.session_id, token)).pipe(
						Effect.tapError((error) =>
							Effect.logError("Workspace unreachable", args.session_id, error.cause),
						),
						Effect.mapError((): HarnessUnavailable => ({ _tag: "HarnessUnavailable" })),
					)
					if (!entered) {
						return yield* Effect.fail<TurnInterrupted>({ _tag: "TurnInterrupted" })
					}

					const repositories = repositoriesOf(args.resources)
					const stores = memoryStoresOf(args.resources)
					if (repositories.length > 0) {
						const prepared = yield* withRetry(
							executor.prepareWorkspace(
								args.session_id,
								token,
								repositories,
								allowedHostsOf(
									(yield* environments.get(EnvironmentId.make(args.environment_id))).config,
								),
							),
						).pipe(
							Effect.tapError((error) =>
								Effect.logError("Workspace unreachable", args.session_id, error.cause),
							),
							Effect.mapError((): HarnessUnavailable => ({ _tag: "HarnessUnavailable" })),
						)
						if (!prepared.ok) {
							const failed = repositories.find(({ id }) => id === prepared.resource_id)
							return yield* Effect.fail<TurnFailed>({
								_tag: "TurnFailed",
								error_type: "repository_unavailable",
								message: `Could not clone ${failed?.url ?? prepared.resource_id}: ${prepared.message}`,
								terminal: false,
							})
						}
					}
					yield* Effect.forEach(stores, (store) => copyMemoryIn(args.session_id, token, store), {
						discard: true,
					}).pipe(
						Effect.tapCause((cause) =>
							Effect.logError("Memory not copied in", args.session_id, cause),
						),
						Effect.catchCause(() => Effect.fail(MEMORY_UNAVAILABLE)),
					)
					const system = describeMounts(version.system, repositories, stores)

					const request: PiTurnRequest = {
						operationId,
						turn: args.turn,
						provider: resolved.provider,
						modelId: resolved.model.id,
						system,
						text: userText,
						...(args.last_reply_turn === undefined
							? {}
							: { unpublishedOperationIds: unpublishedTurns(args.last_reply_turn, args.turn) }),
					}
					// A turn is submitted under its operation id, so sending it again after a
					// lost reply joins the turn already there instead of starting another. The
					// last attempt has no next one to join it, so Pi is asked once, read-only.
					const { attempts, baseDelay } = yield* HarnessLimits
					// With no attempts allowed the turn is never submitted; Pi is only asked.
					const submitted =
						attempts > 0
							? withRetry(executor.runTurn(conversation, request))
							: Effect.fail(new HarnessCallFailed({ cause: "No submission attempts are allowed" }))
					const outcome = yield* submitted.pipe(
						Effect.catchTag("HarnessCallFailed", (failed) =>
							executor.recoverTurn(conversation, operationId).pipe(
								Effect.delay(baseDelay),
								Effect.filterOrFail(
									(recovered): recovered is PiTurnOutcome => recovered !== null,
									() => failed,
								),
							),
						),
						Effect.tapError((error) =>
							Effect.logError("Harness unreachable", conversation, error.cause),
						),
						Effect.mapError((): HarnessUnavailable => ({ _tag: "HarnessUnavailable" })),
					)
					yield* saveMemory(args.session_id, token, args.resources)

					if (!outcome.ok) {
						return yield* Effect.fail(outcome.error)
					}
					return outcome.reply
				})
				// One deadline for recovery and submission together, so the saga step that waits on
				// them ends inside the alarm that runs it.
				return Effect.flatMap(settleTimeout, (duration) =>
					Effect.timeoutOrElse(settle, {
						duration,
						orElse: () =>
							Effect.andThen(
								Effect.logError("Harness did not settle the turn in time", conversation),
								Effect.fail<HarnessUnavailable>({ _tag: "HarnessUnavailable" }),
							),
					}),
				)
			},
			interrupt: (args) =>
				Effect.gen(function* () {
					const { interruptTimeout } = yield* HarnessLimits
					yield* withRetry(
						executor.abortTurn(conversationName(args.session_id), turnOperationId(args.turn)),
					).pipe(Effect.timeout(interruptTimeout))
				}).pipe(
					Effect.tapError((error) =>
						Effect.logError("Interrupt not delivered to the harness", error),
					),
					Effect.mapError((): HarnessUnavailable => ({ _tag: "HarnessUnavailable" })),
				),
			storeRepositoryToken: (args) => {
				const store = executor.storeRepositoryToken(
					args.session_id,
					args.resource_id,
					Redacted.value(args.authorization_token),
					args.replace,
				)
				// A replacement is not sent again on its own: one whose reply was lost may have landed,
				// and resending it after a later rotation would put the older token back. The caller
				// sends it again.
				return (args.replace ? store : withRetry(store)).pipe(
					Effect.tapError((error) =>
						Effect.logError("Repository token not stored", args.session_id, error.cause),
					),
					Effect.mapError((): HarnessUnavailable => ({ _tag: "HarnessUnavailable" })),
				)
			},
			discardWorkspace: (args) =>
				withRetry(executor.discardWorkspace(args.session_id)).pipe(
					Effect.tap(() => Effect.logInfo("Workspace discarded", args.session_id)),
					Effect.tapError((error) =>
						Effect.logError("Workspace not discarded", args.session_id, error.cause),
					),
					Effect.orDie,
				),
		}
	}),
)

const NO_WORKSPACES: WorkspaceExecutorService = {
	enterWorkspace: () => Effect.succeed(true),
	prepareWorkspace: () => Effect.succeed({ ok: true }),
	storeRepositoryToken: () => Effect.void,
	mountMemory: () => Effect.succeed([]),
	fillMemory: () => Effect.void,
	memoryChanges: () => Effect.succeed({ written: [], deleted: [] }),
	memoryContents: () => Effect.succeed([]),
	memorySaved: () => Effect.void,
	discardWorkspace: () => Effect.void,
}

export const makePiTurnExecutorLayer = (
	turns: TurnExecutorService,
	workspaces: WorkspaceExecutorService = NO_WORKSPACES,
) => Layer.succeed(PiTurnExecutor, { ...turns, ...workspaces })
