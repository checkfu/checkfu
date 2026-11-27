import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "@checkfu/domain/Agent/AgentVersionByNumberView.view"
import { Environment } from "@checkfu/domain/Environment/Environment.aggregate"
import { EnvironmentId } from "@checkfu/domain/Environment/Environment.id"
import { bindMcpServers, encodeAgentTools } from "@checkfu/domain/Mcp/McpServers"
import { DEFAULT_TURN_TIMEOUT_MS, boundedHarness } from "@checkfu/domain/Session/Harness.external"
import type {
	HarnessReply,
	HarnessUnavailable,
	TurnFailed,
	TurnInterrupted,
	TurnPaused,
} from "@checkfu/domain/Session/Harness.external"
import { recordToolEvents } from "@checkfu/domain/Session/RecordToolEvents"
import { RequestToolAction } from "@checkfu/domain/Session/RequestToolAction.command"
import { RequestToolActionDecision } from "@checkfu/domain/Session/RequestToolAction.decision"
import { segmentKey } from "@checkfu/domain/Session/RunTurn.saga"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import type { ModelUsage, ToolEvent } from "@checkfu/domain/Session/SessionTypes"
import { ToolConfirmation } from "@checkfu/domain/Session/ToolConfirmation.aggregate"
import { toolConfirmationId } from "@checkfu/domain/Session/ToolConfirmation.id"
import type { SessionId } from "@checkfu/domain/Session/Session.id"
import { SessionView } from "@checkfu/domain/Session/SessionView.view"
import { MAX_MEMORIES_PER_STORE, MAX_MEMORY_CONTENT_BYTES } from "@checkfu/sdk/Schemas"
import type { EnvironmentConfig } from "@checkfu/sdk/Schemas"
import * as Cause from "effect/Cause"
import {
	artifactsOf,
	memoryStoresOf,
	repositoriesOf,
	skillsOf,
} from "@checkfu/domain/Session/SessionResource"
import type {
	ArtifactMount,
	MemoryStoreResource,
	SkillMount,
} from "@checkfu/domain/Session/SessionResource"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import {
	configuredApiCustomProviders,
	resolveCatalogModel,
	supportedProvidersDescription,
} from "./PiCatalog.ts"
import { turnOperationId } from "./PiTurn.ts"
import type { PiActionAnswer, PiParkedCall, PiTurnOutcome, PiTurnRequest } from "./PiTurn.ts"
import type { OutputBytes, OutputRead, OutputsListing } from "../Workspace/SessionOutputs.ts"
import { PACKAGE_REGISTRY_HOSTS } from "../Workspace/MachineEgress.ts"
import type {
	RepositoryMount,
	TurnToken,
	WorkspacePreparation,
} from "../Workspace/WorkspaceShapes.ts"

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
	readonly pauseUsage: (
		conversation: string,
		operationId: string,
		pause: string,
	) => Effect.Effect<ModelUsage, HarnessCallFailed>
	readonly answerCall: (
		conversation: string,
		toolUseId: string,
		answer: typeof PiActionAnswer.Type,
	) => Effect.Effect<"delivered" | "gone", HarnessCallFailed>
}

export interface WorkspaceExecutorService {
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
	readonly interruptWorkspace: (
		sessionId: string,
		token: TurnToken,
	) => Effect.Effect<void, HarnessCallFailed>
	readonly listOutputs: (
		sessionId: string,
		turn: number,
	) => Effect.Effect<OutputsListing | null, HarnessCallFailed>
	readonly readOutputs: (
		sessionId: string,
		turn: number,
		files: ReadonlyArray<OutputRead>,
	) => Effect.Effect<ReadonlyArray<OutputBytes> | null, HarnessCallFailed>
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

const RECORD_RETRY_CAP = "10 seconds"

const withRetry = <A>(call: Effect.Effect<A, HarnessCallFailed>) =>
	Effect.gen(function* () {
		const { attempts, baseDelay } = yield* HarnessLimits
		return yield* Effect.retry(call, {
			times: attempts - 1,
			schedule: Schedule.exponential(baseDelay).pipe(Schedule.jittered),
		})
	})

export const retryRecording = <A, E, R>(write: Effect.Effect<A, E, R>, session_id: SessionId) =>
	Effect.gen(function* () {
		const { baseDelay } = yield* HarnessLimits
		return yield* write.pipe(
			Effect.catchDefect((defect) =>
				Effect.andThen(
					Effect.logWarning("Tool events not recorded yet", session_id, defect),
					Effect.fail({ _tag: "NotRecorded" as const, defect }),
				),
			),
			Effect.retry({
				schedule: Schedule.min([
					Schedule.exponential(baseDelay),
					Schedule.spaced(RECORD_RETRY_CAP),
				]).pipe(Schedule.jittered),
				while: (error) => isNotRecorded(error),
			}),
			Effect.catchIf(isNotRecorded, ({ defect }) => Effect.die(defect)),
		)
	})

const isNotRecorded = (
	error: unknown,
): error is { readonly _tag: "NotRecorded"; readonly defect: unknown } =>
	typeof error === "object" && error !== null && "_tag" in error && error._tag === "NotRecorded"

export const recordSettledToolEvents = (
	args: { readonly session_id: SessionId; readonly turn: number; readonly segment: number },
	events: ReadonlyArray<ToolEvent>,
) => retryRecording(recordToolEvents({ ...args, events }), args.session_id)

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

type TurnOutcomeError = Extract<PiTurnOutcome, { readonly ok: false }>["error"]

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

export const describeMounts = (
	system: string | null,
	repositories: ReadonlyArray<RepositoryMount>,
	stores: ReadonlyArray<MemoryStoreResource> = [],
	artifacts: ReadonlyArray<ArtifactMount> = [],
	skills: ReadonlyArray<SkillMount> = [],
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
								`- ${repository.mount_path}: ${repository.url} (${checkoutLabel(repository)}${repository.access === "read_only" ? ", read-only: pushing is refused" : ""})`,
						),
					].join("\n"),
				]),
		...(stores.length === 0
			? []
			: [
					[
						`Memory stores mounted in your workspace outlast this session. What you write there is saved as you write it. Each file holds at most ${MAX_MEMORY_CONTENT_BYTES} bytes of UTF-8 text, and each store holds at most ${MAX_MEMORIES_PER_STORE} files.`,
						...stores.map(describeStore),
					].join("\n"),
				]),
		...(artifacts.length === 0
			? []
			: [
					[
						"Files mounted in your workspace, read-only:",
						...artifacts.map(
							(artifact) =>
								`- ${artifact.mount_path}: ${artifact.name} (version ${artifact.version})`,
						),
					].join("\n"),
				]),
		...(skills.length === 0
			? []
			: [
					[
						"Skills in your workspace. Each is a directory of instructions for one kind of task. When a task matches a skill's description, read its SKILL.md before you start:",
						...skills.map(
							(skill) => `- ${skill.mount_path}/SKILL.md: ${skill.name}. ${skill.description}`,
						),
					].join("\n"),
				]),
	]
	return repositories.length + stores.length + artifacts.length + skills.length === 0
		? system
		: sections.join("\n\n")
}

export const allowedHostsOf = (config: EnvironmentConfig | null): ReadonlyArray<string> | null =>
	config === null
		? []
		: config.networking.type === "limited"
			? [
					...config.networking.allowed_hosts,
					...(config.networking.allow_package_managers ? PACKAGE_REGISTRY_HOSTS : []),
				]
			: null

export const PiDurableHarnessLive = boundedHarness(
	Effect.gen(function* () {
		const agentVersionsByNumber = yield* AgentVersionByNumberView
		const environments = yield* Environment
		const executor = yield* PiTurnExecutor
		const customProviders = yield* configuredApiCustomProviders
		const sessions = yield* Session
		const sessionViews = yield* SessionView
		const confirmations = yield* ToolConfirmation
		const requestAction = yield* RequestToolActionDecision

		type TurnArgs = {
			readonly session_id: SessionId
			readonly turn: number
			readonly segment: number
		}

		const record = (args: TurnArgs, events: ReadonlyArray<ToolEvent>) =>
			recordSettledToolEvents(
				{
					session_id: args.session_id,
					turn: args.turn,
					segment: args.segment,
				},
				events,
			).pipe(Effect.provideService(Session, sessions))

		const waitOn = (args: TurnArgs, calls: ReadonlyArray<PiParkedCall>) =>
			Effect.gen(function* () {
				const segment = args.segment
				const requestId = `${segmentKey(args.session_id, args.turn, segment)}:req:${segment}`
				const answers: Array<{
					readonly tool_use_id: string
					readonly answer: typeof PiActionAnswer.Type
				}> = []
				for (const call of calls) {
					const confirmation_id = toolConfirmationId(args.session_id, call.tool_use_id)
					yield* retryRecording(
						requestAction
							.send(
								new RequestToolAction({
									session_id: args.session_id,
									confirmation_id,
									turn: args.turn,
									model_request_start_id: requestId,
									tool_use_id: call.tool_use_id,
									name: call.name,
									input: call.input,
									awaits: call.awaits,
									mcp_server_name: call.mcp_server_name,
								}),
								{ commandId: `action:${args.session_id}:${call.tool_use_id}` },
							)
							.pipe(
								Effect.catchTag(
									["UnknownModelRequest", "SessionNotFound", "SessionNotRunning", "StaleTurn"],
									() => Effect.void,
								),
							),
						args.session_id,
					)
					const state = yield* confirmations.get(confirmation_id)
					if (state.status === "allowed" || state.status === "denied") {
						answers.push({
							tool_use_id: call.tool_use_id,
							answer: {
								type: "confirmation",
								allow: state.status === "allowed",
								deny_message: state.deny_message,
							},
						})
					} else if (state.status === "returned") {
						answers.push({
							tool_use_id: call.tool_use_id,
							answer: { type: "result", text: state.result_text, is_error: state.result_is_error },
						})
					}
				}
				return answers
			})

		const settled = (
			args: TurnArgs & { readonly conversation: string; readonly operationId: string },
			outcome: PiTurnOutcome,
			again: Effect.Effect<PiTurnOutcome, HarnessUnavailable>,
		): Effect.Effect<HarnessReply, TurnOutcomeError | HarnessUnavailable | TurnPaused> =>
			Effect.gen(function* () {
				if (outcome.ok === true) {
					yield* record(args, outcome.tool_events ?? [])
					return outcome.reply
				}
				if (outcome.ok === false) {
					yield* record(args, outcome.tool_events ?? [])
					return yield* Effect.fail(outcome.error)
				}
				yield* record(args, outcome.tool_events ?? [])
				const answers = yield* waitOn(args, outcome.calls)
				if (answers.length > 0) {
					yield* Effect.forEach(
						answers,
						({ tool_use_id, answer }) =>
							withRetry(executor.answerCall(args.conversation, tool_use_id, answer)),
						{ discard: true },
					).pipe(Effect.mapError((): HarnessUnavailable => ({ _tag: "HarnessUnavailable" })))
					return yield* settled(args, yield* again, again)
				}
				const pause = outcome.calls.map((call) => call.tool_use_id).join(",")
				const model_usage = yield* withRetry(
					executor.pauseUsage(args.conversation, args.operationId, pause),
				).pipe(Effect.mapError((): HarnessUnavailable => ({ _tag: "HarnessUnavailable" })))
				return yield* Effect.fail<TurnPaused>({ _tag: "TurnPaused", model_usage })
			})

		return {
			runTurn: (args) => {
				const conversation = conversationName(args.session_id)
				const settle = Effect.gen(function* () {
					const operationId = turnOperationId(args.turn)
					const turnArgs = {
						session_id: args.session_id,
						turn: args.turn,
						segment: args.segment,
						conversation,
						operationId,
					}

					const recover = withRetry(executor.recoverTurn(conversation, operationId)).pipe(
						Effect.tapError((error) =>
							Effect.logError("Harness unreachable", conversation, error.cause),
						),
						Effect.mapError((): HarnessUnavailable => ({ _tag: "HarnessUnavailable" })),
					)
					const again = recover.pipe(
						Effect.filterOrFail(
							(outcome): outcome is PiTurnOutcome => outcome !== null,
							(): HarnessUnavailable => ({ _tag: "HarnessUnavailable" }),
						),
					)
					const recovered = yield* recover
					if (recovered !== null) {
						return yield* settled(turnArgs, recovered, again)
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

					const resolved = resolveCatalogModel(version.model.id, customProviders)
					if (resolved === null) {
						return yield* Effect.fail<TurnFailed>({
							_tag: "TurnFailed",
							error_type: "unknown_model_error",
							message: `Unsupported model "${version.model.id}". Supported providers: ${supportedProvidersDescription(customProviders)}.`,
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

					const token = { turn: args.turn }
					const repositories = repositoriesOf(args.resources)
					const stores = memoryStoresOf(args.resources)
					const artifacts = artifactsOf(args.resources)
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
					if (!prepared.ok && "interrupted" in prepared) {
						return yield* Effect.fail<TurnInterrupted>({ _tag: "TurnInterrupted" })
					}
					if (!prepared.ok) {
						const failed = repositories.find(({ id }) => id === prepared.resource_id)
						return yield* Effect.fail<TurnFailed>({
							_tag: "TurnFailed",
							error_type: "repository_unavailable",
							message: `Could not clone ${failed?.url ?? prepared.resource_id}: ${prepared.message}`,
							terminal: false,
						})
					}
					const skills = skillsOf(args.resources)
					const system = describeMounts(version.system, repositories, stores, artifacts, skills)

					const mcp =
						version.mcp_servers.length === 0 ||
						(yield* sessions.get(args.session_id))._tag === "Uninitialized"
							? undefined
							: {
									servers: bindMcpServers(
										version.mcp_servers,
										(yield* sessionViews
											.waitFor(
												Session.ref(args.session_id),
												{ id: args.session_id },
												{ timeout: lookupTimeout },
											)
											.pipe(
												Effect.orElseSucceed(() => null),
												Effect.filterOrFail(
													(view) => view !== null,
													(): TurnFailed => ({
														_tag: "TurnFailed",
														error_type: "session_not_ready",
														message: `Session ${args.session_id} is not ready yet.`,
														terminal: false,
													}),
												),
											)).mcp_server_credentials,
									),
									networking:
										(yield* environments.get(EnvironmentId.make(args.environment_id))).config
											?.networking ?? null,
								}

					const tools = version.tools.length === 0 ? undefined : encodeAgentTools(version.tools)

					const request: PiTurnRequest = {
						operationId,
						turn: args.turn,
						provider: resolved.provider,
						modelId: resolved.modelId,
						system,
						...(args.system_context === undefined ? {} : { systemContext: args.system_context }),
						...(args.unattended === true ? { unattended: true as const } : {}),
						text: userText,
						...(mcp === undefined ? {} : { mcp }),
						...(tools === undefined ? {} : { tools }),
						unpublishedOperationIds: unpublishedTurns(args.last_reply_turn, args.turn),
					}
					const { attempts, baseDelay } = yield* HarnessLimits
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

					return yield* settled(turnArgs, outcome, again)
				})
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
					yield* Effect.all(
						[
							withRetry(
								executor.abortTurn(conversationName(args.session_id), turnOperationId(args.turn)),
							),
							withRetry(executor.interruptWorkspace(args.session_id, { turn: args.turn })),
						],
						{ concurrency: "unbounded", discard: true },
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
	prepareWorkspace: () => Effect.succeed({ ok: true }),
	storeRepositoryToken: () => Effect.void,
	interruptWorkspace: () => Effect.void,
	listOutputs: () => Effect.succeed({ ok: true, files: [], skipped: [] }),
	readOutputs: () => Effect.succeed([]),
	discardWorkspace: () => Effect.void,
}

export const makePiTurnExecutorLayer = (
	turns: Omit<TurnExecutorService, "pauseUsage" | "answerCall"> &
		Partial<Pick<TurnExecutorService, "pauseUsage" | "answerCall">>,
	workspaces: WorkspaceExecutorService = NO_WORKSPACES,
) =>
	Layer.succeed(PiTurnExecutor, {
		pauseUsage: () =>
			Effect.fail(new HarnessCallFailed({ cause: "No turn of this harness pauses" })),
		answerCall: () => Effect.succeed("gone" as const),
		...turns,
		...workspaces,
	})
