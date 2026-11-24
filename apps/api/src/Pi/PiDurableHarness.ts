import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "@checkfu/domain/Agent/AgentVersionByNumberView.view"
import { Environment } from "@checkfu/domain/Environment/Environment.aggregate"
import { EnvironmentId } from "@checkfu/domain/Environment/Environment.id"
import { CustomToolList, customToolSetId } from "@checkfu/domain/Mcp/CustomTools"
import {
	McpServerSet,
	McpServerSetId,
	RecordMcpServers,
} from "@checkfu/domain/Mcp/McpServerSet.aggregate"
import { McpServerBindingList, McpServerList } from "@checkfu/domain/Mcp/McpServers"
import { DEFAULT_TURN_TIMEOUT_MS, boundedHarness } from "@checkfu/domain/Session/Harness.external"
import type {
	HarnessReply,
	HarnessUnavailable,
	TurnFailed,
	TurnInterrupted,
	TurnPaused,
} from "@checkfu/domain/Session/Harness.external"
import { PauseTurn } from "@checkfu/domain/Session/PauseTurn.command"
import { recordToolCalls } from "@checkfu/domain/Session/RecordToolCalls"
import { ResumeTurn } from "@checkfu/domain/Session/ResumeTurn.command"
import { turnKey } from "@checkfu/domain/Session/RunTurn.saga"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import type { SessionId } from "@checkfu/domain/Session/Session.id"
import { MAX_WAITING_TOOL_USES, ToolUseIds } from "@checkfu/domain/Session/SessionTypes"
import {
	CancelToolConfirmation,
	RequestToolConfirmation,
	ToolConfirmation,
} from "@checkfu/domain/Session/ToolConfirmation.aggregate"
import { toolConfirmationId } from "@checkfu/domain/Session/ToolConfirmation.id"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { resolveCatalogModel } from "./PiCatalog.ts"
import { bindSessionServers } from "../Connection/McpBindings.ts"
import type { ToolAnswer } from "./PiApprovals.ts"
import { isPaused } from "./PiTurn.ts"
import type { PiTurnOutcome, PiTurnRequest } from "./PiTurn.ts"

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

export interface PiTurnExecutorService {
	readonly recoverTurn: (
		conversation: string,
		operationId: string,
	) => Effect.Effect<PiTurnOutcome | null, HarnessCallFailed>
	readonly runTurn: (
		conversation: string,
		request: PiTurnRequest,
	) => Effect.Effect<PiTurnOutcome, HarnessCallFailed>
	/** Hands answers to the tool calls that wait, then follows the operation to where it ends or pauses next. */
	readonly resumeTurn: (
		conversation: string,
		operationId: string,
		answers: ReadonlyArray<ToolAnswer>,
	) => Effect.Effect<PiTurnOutcome | null, HarnessCallFailed>
	readonly abortTurn: (
		conversation: string,
		operationId: string,
	) => Effect.Effect<void, HarnessCallFailed>
	/** The tool calls a person has yet to answer. */
	readonly waitingCalls: (
		conversation: string,
	) => Effect.Effect<ReadonlyArray<string>, HarnessCallFailed>
	/** Gives up whatever waits for a person, so `operationId` can run as a turn of its own. */
	readonly cancelWaiting: (
		conversation: string,
		operationId: string,
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

const turnOperationId = (turn: number) => `turn:${turn}`

// Every turn after the last published reply and before this one.
const unpublishedTurns = (lastReplyTurn: number, turn: number): ReadonlyArray<string> =>
	Array.from({ length: Math.max(0, turn - lastReplyTurn - 1) }, (_, i) =>
		turnOperationId(lastReplyTurn + 1 + i),
	)

const NOTHING_WAITING: TurnFailed = {
	_tag: "TurnFailed",
	error_type: "tool_call_not_waiting",
	message: "The tool calls this turn was to carry on are no longer waiting.",
	terminal: false,
}

const QUEUED_MESSAGE_DENIAL =
	"A new message from the user arrived before this call was approved, so it did not run."
const CANCELLED_DENIAL = "This call was cancelled before it was approved, so it did not run."
const QUEUED_MESSAGE_NO_RESULT =
	"A new message from the user arrived before this tool's result did, so the call has no result."
const CANCELLED_NO_RESULT = "This call was cancelled before its result arrived."

interface WaitingCalls {
	readonly waiting: ReadonlyArray<string>
	/** Those of `waiting` that wait for a result from the caller's application. */
	readonly waiting_results?: ReadonlyArray<string>
}

const unreachable = (conversation: string) => (error: HarnessCallFailed) =>
	Effect.andThen(
		Effect.logError("Harness unreachable", conversation, error.cause),
		Effect.fail<HarnessUnavailable>({ _tag: "HarnessUnavailable" }),
	)

const isResume = (args: { readonly resume?: true }): boolean => args.resume === true

export const PiDurableHarnessLive = boundedHarness(
	Effect.gen(function* () {
		const agentVersionsByNumber = yield* AgentVersionByNumberView
		const executor = yield* PiTurnExecutor
		const sessions = yield* Session
		const confirmations = yield* ToolConfirmation
		const serverSets = yield* McpServerSet
		const environments = yield* Environment
		// A session admitted without a recorded binding (an automation's, for one) is bound here,
		// at its first turn, by the same step as one created over HTTP: without credentials, under
		// its environment's network rules. What is recorded then holds for the session's life.
		const sessionMcpServers = (sessionId: string, versionId: string, environmentId: string) =>
			Effect.gen(function* () {
				const setId = McpServerSetId.make(sessionId)
				const recorded = yield* serverSets.get(setId)
				if (recorded.recorded) {
					return McpServerBindingList.decode(recorded.servers)
				}
				const servers = McpServerList.decode(
					(yield* serverSets.get(McpServerSetId.make(versionId))).servers,
				)
				if (servers.length === 0) {
					return []
				}
				const environment = yield* environments.get(EnvironmentId.make(environmentId))
				const bound = bindSessionServers({
					servers,
					explicit: [],
					offered: [],
					networking: environment.config === null ? null : environment.config.networking,
				})
				if (!bound.ok) {
					return yield* Effect.fail<TurnFailed>({
						_tag: "TurnFailed",
						error_type: "mcp_servers_unavailable",
						message: bound.message,
						terminal: true,
					})
				}
				yield* serverSets.send(new RecordMcpServers({ set_id: setId, servers: bound.mcpServers }))
				return McpServerBindingList.decode((yield* serverSets.get(setId)).servers)
			})

		type TurnRef = { readonly session_id: SessionId; readonly turn: number }

		const record = (args: TurnRef, outcome: PiTurnOutcome) =>
			recordToolCalls({
				session_id: args.session_id,
				turn: args.turn,
				calls: "tool_calls" in outcome ? (outcome.tool_calls ?? []) : [],
			}).pipe(
				Effect.provideService(Session, sessions),
				// Pi kept what it did. Failing the turn any other way would leave it in a
				// conversation the session log says never answered.
				Effect.catchDefect((defect) =>
					Effect.andThen(
						Effect.logError("Tool calls not recorded", args.session_id, defect),
						Effect.fail<HarnessUnavailable>({ _tag: "HarnessUnavailable" }),
					),
				),
			)

		const answersTo = (
			args: TurnRef,
			waiting: ReadonlyArray<string>,
			cancelled: (awaits: string) => string = (awaits) =>
				awaits === "result" ? CANCELLED_NO_RESULT : CANCELLED_DENIAL,
		) =>
			Effect.map(
				Effect.forEach(waiting, (tool_use_id) =>
					Effect.map(
						confirmations.get(toolConfirmationId(args.session_id, tool_use_id)),
						(state): ReadonlyArray<ToolAnswer> => {
							if (state.status === "allowed") {
								return [{ tool_use_id, allow: true, message: "" }]
							}
							if (state.status === "denied") {
								return [{ tool_use_id, allow: false, message: state.deny_message }]
							}
							if (state.status === "returned") {
								return [
									{
										tool_use_id,
										content: [{ type: "text", text: state.result_text }],
										is_error: state.result_is_error,
									},
								]
							}
							return state.status === "cancelled"
								? [
										{
											tool_use_id,
											allow: false,
											message: cancelled(state.awaits),
										},
									]
								: []
						},
					),
				),
				(answers) => answers.flat(),
			)

		const cancelConfirmations = (args: TurnRef, waiting: ReadonlyArray<string>) =>
			Effect.forEach(
				waiting,
				(tool_use_id) =>
					confirmations.send(
						new CancelToolConfirmation({
							confirmation_id: toolConfirmationId(args.session_id, tool_use_id),
						}),
					),
				{ discard: true },
			)

		/**
		 * What to do about tool calls that wait for a person: the answers already
		 * given, or "paused" once the session has gone idle naming the calls. A
		 * turn with messages queued behind it cannot wait, so its calls are denied.
		 */
		const answersOrPause = Effect.fn("PiDurableHarness.answersOrPause")(function* (
			args: TurnRef,
			calls: WaitingCalls,
		) {
			// More than a pause can name wait their turn: the next pause names them.
			const waiting = calls.waiting.slice(0, MAX_WAITING_TOOL_USES)
			if (waiting.length === 0) {
				return []
			}
			const results = new Set(calls.waiting_results)
			yield* Effect.forEach(
				waiting,
				(tool_use_id) =>
					confirmations.send(
						new RequestToolConfirmation({
							confirmation_id: toolConfirmationId(args.session_id, tool_use_id),
							session_id: args.session_id,
							tool_use_id,
							awaits: results.has(tool_use_id) ? "result" : "confirmation",
						}),
					),
				{ discard: true },
			)
			const given = yield* answersTo(args, waiting)
			if (given.length > 0) {
				return given
			}
			const paused = yield* sessions
				.send(
					new PauseTurn({
						session_id: args.session_id,
						turn: args.turn,
						request_seq: 1,
						model_request_start_id: `${turnKey(args.session_id, args.turn)}:req:1`,
						event_ids: ToolUseIds.encode(waiting),
					}),
				)
				.pipe(
					Effect.as(true),
					Effect.catchTag("UserMessagesQueued", () => Effect.succeed(false)),
					// The turn is over already, paused by an earlier attempt or ended some other way.
					Effect.catchTag(
						["SessionNotFound", "SessionNotRunning", "StaleTurn", "UnknownModelRequest"],
						() => Effect.succeed(true),
					),
				)
			if (!paused) {
				yield* cancelConfirmations(args, waiting)
				// An answer can land between the read above and the cancellation; whichever won is what the
				// model gets.
				return yield* answersTo(args, waiting, (awaits) =>
					awaits === "result" ? QUEUED_MESSAGE_NO_RESULT : QUEUED_MESSAGE_DENIAL,
				)
			}
			// An answer given while the turn was pausing found the session still running.
			if ((yield* answersTo(args, waiting)).length > 0) {
				yield* sessions.send(new ResumeTurn({ session_id: args.session_id, turn: args.turn }))
			}
			return "paused" as const
		})

		/**
		 * Publishes what the turn did and ends it the way Pi did. A turn whose
		 * tool calls wait for a person either carries on from the answers there
		 * are, or leaves the session idle naming the calls.
		 */
		const settle = (
			args: TurnRef,
			conversation: string,
			operationId: string,
			first: PiTurnOutcome,
			timeout: Duration.Duration,
		): Effect.Effect<
			HarnessReply,
			TurnFailed | TurnInterrupted | TurnPaused | HarnessUnavailable
		> =>
			Effect.gen(function* () {
				let outcome = first
				while (true) {
					yield* record(args, outcome)
					if (outcome.ok) {
						return outcome.reply
					}
					if (!isPaused(outcome)) {
						return yield* Effect.fail(outcome.error)
					}
					const answers = yield* answersOrPause(args, outcome)
					if (answers === "paused") {
						return yield* Effect.fail<TurnPaused>({ _tag: "TurnPaused" })
					}
					const next = yield* withRetry(
						executor.resumeTurn(conversation, operationId, answers),
					).pipe(
						Effect.catchTag("HarnessCallFailed", unreachable(conversation)),
						Effect.timeoutOrElse({
							duration: timeout,
							orElse: () =>
								Effect.andThen(
									Effect.logError("Harness did not settle the turn in time", conversation),
									Effect.fail<HarnessUnavailable>({ _tag: "HarnessUnavailable" }),
								),
						}),
					)
					if (next === null) {
						return yield* Effect.fail(NOTHING_WAITING)
					}
					outcome = next
				}
			})

		return {
			runTurn: (args) =>
				Effect.gen(function* () {
					const { settleMargin } = yield* HarnessLimits
					const settleTimeout = Duration.sum(
						Duration.fromInputUnsafe(yield* HarnessTurnTimeout),
						Duration.fromInputUnsafe(settleMargin),
					)
					const conversation = conversationName(args.session_id)
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
						Effect.timeoutOrElse({
							duration: settleTimeout,
							orElse: () =>
								Effect.andThen(
									Effect.logError("Harness did not settle the turn in time", conversation),
									Effect.fail<HarnessUnavailable>({ _tag: "HarnessUnavailable" }),
								),
						}),
					)
					if (recovered !== null) {
						if (!isPaused(recovered) || recovered.carried !== true || isResume(args)) {
							return yield* settle(args, conversation, operationId, recovered, settleTimeout)
						}
						// A new message reached a conversation whose last turn still waits: the wait is over.
						yield* cancelConfirmations(args, recovered.waiting)
						yield* withRetry(executor.cancelWaiting(conversation, operationId)).pipe(
							Effect.catchTag("HarnessCallFailed", unreachable(conversation)),
						)
					} else if (isResume(args)) {
						return yield* Effect.fail(NOTHING_WAITING)
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

					// What the session bound when it was created; it never changes afterwards.
					const mcpServers = yield* sessionMcpServers(
						args.session_id,
						version.id,
						args.environment_id,
					)
					const customTools = CustomToolList.decode(
						(yield* serverSets.get(customToolSetId(version.id))).servers,
					)
					const userText = args.input.join("\n")
					if (userText.length === 0) {
						return yield* Effect.fail<TurnFailed>({
							_tag: "TurnFailed",
							error_type: "invalid_turn_input",
							message: "Turn contained no user message to send to Pi.",
							terminal: false,
						})
					}

					const request: PiTurnRequest = {
						operationId,
						turn: args.turn,
						provider: resolved.provider,
						modelId: resolved.model.id,
						system: version.system,
						text: userText,
						...(args.last_reply_turn === undefined
							? {}
							: { unpublishedOperationIds: unpublishedTurns(args.last_reply_turn, args.turn) }),
						...(mcpServers.length === 0 ? {} : { mcp_servers: mcpServers }),
						...(customTools.length === 0 ? {} : { custom_tools: customTools }),
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
						Effect.timeoutOrElse({
							duration: settleTimeout,
							orElse: () =>
								Effect.andThen(
									Effect.logError("Harness did not settle the turn in time", conversation),
									Effect.fail<HarnessUnavailable>({ _tag: "HarnessUnavailable" }),
								),
						}),
					)

					return yield* settle(args, conversation, operationId, outcome, settleTimeout)
				}),
			interrupt: (args) =>
				Effect.gen(function* () {
					const { interruptTimeout } = yield* HarnessLimits
					const conversation = conversationName(args.session_id)
					// Whatever waits for a person is given up first, so no late answer is taken for it.
					yield* Effect.gen(function* () {
						yield* cancelConfirmations(args, yield* withRetry(executor.waitingCalls(conversation)))
						yield* withRetry(executor.abortTurn(conversation, turnOperationId(args.turn)))
					}).pipe(Effect.timeout(interruptTimeout))
				}).pipe(
					Effect.tapError((error) =>
						Effect.logError("Interrupt not delivered to the harness", error),
					),
					Effect.mapError((): HarnessUnavailable => ({ _tag: "HarnessUnavailable" })),
				),
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

type WaitingCallOperations = Pick<
	PiTurnExecutorService,
	"resumeTurn" | "waitingCalls" | "cancelWaiting"
>

export const makePiTurnExecutorLayer = (
	turns: Omit<PiTurnExecutorService, "discardWorkspace" | keyof WaitingCallOperations> &
		Partial<WaitingCallOperations>,
	workspaces: Pick<PiTurnExecutorService, "discardWorkspace"> = {
		discardWorkspace: () => Effect.void,
	},
) =>
	Layer.succeed(PiTurnExecutor, {
		// A harness with no tools that ask has nothing waiting.
		resumeTurn: () => Effect.succeed(null),
		waitingCalls: () => Effect.succeed([]),
		cancelWaiting: () => Effect.void,
		...turns,
		...workspaces,
	})
