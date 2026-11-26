import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { CommitModelReply } from "./CommitModelReply.command.ts"
import { FailModelRequest } from "./FailModelRequest.command.ts"
import { InterruptModelRequest } from "./InterruptModelRequest.command.ts"
import { PauseTurn } from "./PauseTurn.command.ts"
import { HARNESS_UNAVAILABLE, HARNESS_UNAVAILABLE_MESSAGE, Harness } from "./Harness.external.ts"
import { RecordModelRequestStart } from "./RecordModelRequestStart.command.ts"
import {
	TurnOutcome,
	RUN_TURN_ACTIVITIES,
	StepOutcome,
	runTurnActivity,
} from "./RunTurnActivities.ts"
import { Session } from "./Session.aggregate.ts"
import { SessionId } from "./Session.id.ts"
import { MessageText, NonNegativeInt, PositiveInt, ResourceId } from "./SessionTypes.ts"

export { TurnOutcome, RUN_TURN_ACTIVITIES, StepOutcome }

export const TurnId = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("TurnId"))
export type TurnId = typeof TurnId.Type

export const turnKey = (session_id: SessionId, turn: number): TurnId =>
	TurnId.make(`${session_id}:turn:${turn}`)

export const segmentKey = (session_id: SessionId, turn: number, segment: number): TurnId =>
	segment === 1
		? turnKey(session_id, turn)
		: TurnId.make(`${session_id}:turn:${turn}:seg:${segment}`)

const PROCEED = { status: "proceed" as const }
const ABORTED = { status: "aborted" as const }

export class RunTurn extends Domain.Saga("RunTurn", {
	key: TurnId,
	input: {
		session_id: SessionId,
		agent_id: ResourceId,
		agent_version: PositiveInt,
		environment_id: ResourceId,
		turn: PositiveInt,
		input: Schema.Array(MessageText),
		last_reply_turn: Schema.optionalKey(NonNegativeInt),
		segment: Schema.optionalKey(PositiveInt),
	},
	result: {
		status: Schema.Literals(["completed", "failed", "interrupted", "paused", "aborted"]),
	},
}) {}

export const RunTurnLive = RunTurn.toLayer(
	Effect.gen(function* () {
		const sessions = yield* Session
		const harness = yield* Harness

		return Effect.fn(function* (payload: typeof RunTurn.workflow.payloadSchema.Type) {
			const segment = payload.segment ?? 1
			const requestId = `${payload.key}:req:${segment}`

			const started = yield* runTurnActivity(
				"startModelRequest",
				sessions
					.send(
						new RecordModelRequestStart({
							session_id: payload.session_id,
							turn: payload.turn,
							request_seq: segment,
							model_request_start_id: requestId,
						}),
					)
					.pipe(
						Effect.andThen(Effect.succeed(PROCEED)),
						Effect.catchTag(
							[
								"DuplicateModelRequest",
								"SessionNotFound",
								"SessionNotRunning",
								"StaleTurn",
								"OutOfOrderModelRequest",
							],
							() => Effect.succeed(ABORTED),
						),
					),
			)

			if (started.status === "aborted") {
				return { status: "aborted" as const }
			}

			const generated = yield* runTurnActivity(
				"runHarnessTurn",
				harness
					.runTurn({
						session_id: payload.session_id,
						agent_id: payload.agent_id,
						agent_version: payload.agent_version,
						environment_id: payload.environment_id,
						turn: payload.turn,
						input: payload.input,
						...(payload.last_reply_turn === undefined
							? {}
							: { last_reply_turn: payload.last_reply_turn }),
						...(segment === 1 ? {} : { segment }),
					})
					.pipe(
						Effect.map((reply) => ({
							ok: true as const,
							thinking: reply.thinking,
							text: reply.text,
							truncated: reply.truncated,
							input_tokens: reply.input_tokens,
							output_tokens: reply.output_tokens,
							stop_reason: reply.stop_reason,
						})),
						Effect.catchTag(
							["TurnFailed", "HarnessUnavailable", "TurnInterrupted", "TurnPaused"],
							(err): Effect.Effect<typeof TurnOutcome.Type> => {
								if (err._tag === "TurnPaused") {
									return Effect.succeed({
										ok: "paused" as const,
										model_usage: err.model_usage,
									})
								}
								if (err._tag === "TurnFailed") {
									return Effect.succeed({
										ok: false,
										interrupted: false,
										model_usage: err.model_usage ?? { input_tokens: 0, output_tokens: 0 },
										error_type: err.error_type,
										message: err.message,
										disposition: err.terminal ? "terminal" : "exhausted",
									})
								}
								if (err._tag === "HarnessUnavailable") {
									return Effect.succeed({
										ok: false,
										interrupted: false,
										model_usage: { input_tokens: 0, output_tokens: 0 },
										error_type: HARNESS_UNAVAILABLE,
										message: HARNESS_UNAVAILABLE_MESSAGE,
										disposition: "abandoned",
									})
								}
								return Effect.succeed({
									ok: false,
									interrupted: true,
									model_usage: err.model_usage ?? { input_tokens: 0, output_tokens: 0 },
								})
							},
						),
					),
			)

			if (generated.ok === "paused") {
				const paused = yield* runTurnActivity(
					"pauseTurn",
					sessions
						.send(
							new PauseTurn({
								session_id: payload.session_id,
								turn: payload.turn,
								request_seq: segment,
								model_request_start_id: requestId,
								model_usage: generated.model_usage,
							}),
						)
						.pipe(
							Effect.andThen(Effect.succeed(PROCEED)),
							Effect.catchTag(
								["UnknownModelRequest", "SessionNotFound", "SessionNotRunning", "StaleTurn"],
								() => Effect.succeed(ABORTED),
							),
						),
				)
				return paused.status === "aborted"
					? { status: "aborted" as const }
					: { status: "paused" as const }
			}

			if (!generated.ok && generated.interrupted) {
				const interrupted = yield* runTurnActivity(
					"interruptModelRequest",
					sessions
						.send(
							new InterruptModelRequest({
								model_usage: generated.model_usage,
								session_id: payload.session_id,
								turn: payload.turn,
								request_seq: segment,
								model_request_start_id: requestId,
							}),
						)
						.pipe(
							Effect.andThen(Effect.succeed(PROCEED)),
							Effect.catchTag(
								["UnknownModelRequest", "SessionNotFound", "SessionNotRunning", "StaleTurn"],
								() => Effect.succeed(ABORTED),
							),
						),
				)

				return interrupted.status === "aborted"
					? { status: "aborted" as const }
					: { status: "interrupted" as const }
			}

			if (!generated.ok) {
				const failed = yield* runTurnActivity(
					"failModelRequest",
					sessions
						.send(
							new FailModelRequest({
								model_usage: generated.model_usage,
								session_id: payload.session_id,
								turn: payload.turn,
								request_seq: segment,
								model_request_start_id: requestId,
								error_type: generated.error_type,
								message: generated.message,
								disposition: generated.disposition,
							}),
						)
						.pipe(
							Effect.andThen(Effect.succeed(PROCEED)),
							Effect.catchTag(
								["UnknownModelRequest", "SessionNotFound", "SessionNotRunning", "StaleTurn"],
								() => Effect.succeed(ABORTED),
							),
						),
				)

				return failed.status === "aborted"
					? { status: "aborted" as const }
					: { status: "failed" as const }
			}

			const committed = yield* runTurnActivity(
				"commitModelReply",
				sessions
					.send(
						new CommitModelReply({
							session_id: payload.session_id,
							turn: payload.turn,
							request_seq: segment,
							model_request_start_id: requestId,
							thinking: generated.thinking,
							text: generated.text,
							truncated: generated.truncated,
							model_usage: {
								input_tokens: generated.input_tokens,
								output_tokens: generated.output_tokens,
							},
							stop_reason: generated.stop_reason,
						}),
					)
					.pipe(
						Effect.andThen(Effect.succeed(PROCEED)),
						Effect.catchTag(
							["UnknownModelRequest", "SessionNotFound", "SessionNotRunning", "StaleTurn"],
							() => Effect.succeed(ABORTED),
						),
					),
			)

			return committed.status === "aborted"
				? { status: "aborted" as const }
				: { status: "completed" as const }
		})
	}),
)
