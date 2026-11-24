import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "@checkfu/domain/Agent/AgentVersionByNumberView.view"
import { Environment } from "@checkfu/domain/Environment/Environment.aggregate"
import { EnvironmentId } from "@checkfu/domain/Environment/Environment.id"
import {
	McpServerSet,
	McpServerSetId,
	RecordMcpServers,
} from "@checkfu/domain/Mcp/McpServerSet.aggregate"
import { McpServerBindingList, McpServerList } from "@checkfu/domain/Mcp/McpServers"
import { DEFAULT_TURN_TIMEOUT_MS, boundedHarness } from "@checkfu/domain/Session/Harness.external"
import type { HarnessUnavailable, TurnFailed } from "@checkfu/domain/Session/Harness.external"
import { recordToolCalls } from "@checkfu/domain/Session/RecordToolCalls"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import type { SessionId } from "@checkfu/domain/Session/Session.id"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { resolveCatalogModel } from "./PiCatalog.ts"
import { bindSessionServers } from "../Connection/McpBindings.ts"
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
	readonly abortTurn: (
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

export const PiDurableHarnessLive = boundedHarness(
	Effect.gen(function* () {
		const agentVersionsByNumber = yield* AgentVersionByNumberView
		const executor = yield* PiTurnExecutor
		const sessions = yield* Session
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

		const settled = (
			args: { readonly session_id: SessionId; readonly turn: number },
			outcome: PiTurnOutcome,
		) =>
			outcome.ok
				? Effect.as(
						recordToolCalls({
							session_id: args.session_id,
							turn: args.turn,
							calls: outcome.tool_calls ?? [],
						}).pipe(
							Effect.provideService(Session, sessions),
							// Pi kept this reply. Failing the turn any other way would leave it in a
							// conversation the session log says never answered.
							Effect.catchDefect((defect) =>
								Effect.andThen(
									Effect.logError("Tool calls not recorded", args.session_id, defect),
									Effect.fail<HarnessUnavailable>({ _tag: "HarnessUnavailable" }),
								),
							),
						),
						outcome.reply,
					)
				: Effect.fail(outcome.error)

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
						return yield* settled(args, recovered)
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

					return yield* settled(args, outcome)
				}),
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

export const makePiTurnExecutorLayer = (
	turns: Omit<PiTurnExecutorService, "discardWorkspace">,
	workspaces: Pick<PiTurnExecutorService, "discardWorkspace"> = {
		discardWorkspace: () => Effect.void,
	},
) => Layer.succeed(PiTurnExecutor, { ...turns, ...workspaces })
