import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Activity } from "effect/workflow"
import { CommitModelReply } from "./CommitModelReply.command.ts"
import { FailModelRequest, RequestFailureDisposition } from "./FailModelRequest.command.ts"
import { InterruptModelRequest } from "./InterruptModelRequest.command.ts"
import {
	HARNESS_UNAVAILABLE,
	HARNESS_UNAVAILABLE_MESSAGE,
	ModelProvider,
	type ModelProviderError,
	ModelStopReason,
} from "./ModelProvider.external.ts"
import { RecordModelRequestStart } from "./RecordModelRequestStart.command.ts"
import { Session } from "./Session.aggregate.ts"
import { SessionId } from "./Session.id.ts"
import {
	ErrorMessage,
	ErrorType,
	MessageText,
	ModelUsage,
	NonNegativeInt,
	PositiveInt,
	ResourceId,
	ThinkingText,
} from "./SessionTypes.ts"

export const TurnId = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("TurnId"))
export type TurnId = typeof TurnId.Type

export const turnKey = (session_id: SessionId, turn: number): TurnId =>
	TurnId.make(`${session_id}:turn:${turn}`)

export const StepOutcome = Schema.Struct({
	status: Schema.Literals(["proceed", "aborted"]),
})

export const GenerateOutcome = Schema.Union([
	Schema.Struct({
		ok: Schema.Literal(true),
		thinking: Schema.NullOr(ThinkingText),
		text: MessageText,
		truncated: Schema.optional(Schema.Literal(true)),
		input_tokens: NonNegativeInt,
		output_tokens: NonNegativeInt,
		stop_reason: ModelStopReason,
	}),
	Schema.Struct({
		ok: Schema.Literal(false),
		interrupted: Schema.Literal(true),
		model_usage: ModelUsage,
	}),
	Schema.Struct({
		ok: Schema.Literal(false),
		interrupted: Schema.Literal(false),
		model_usage: ModelUsage,
		error_type: ErrorType,
		message: ErrorMessage,
		disposition: RequestFailureDisposition,
	}),
])

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
		generation: NonNegativeInt,
		input: Schema.Array(MessageText),
	},
	result: {
		status: Schema.Literals(["completed", "failed", "interrupted", "aborted"]),
	},
}) {}

export const RunTurnLive = RunTurn.toLayer(
	Effect.gen(function* () {
		const sessions = yield* Session
		const provider = yield* ModelProvider

		return Effect.fn(function* (payload) {
			const requestId = `${payload.key}:req:1`

			const started = yield* Activity.make({
				name: "start-model-request",
				success: StepOutcome,
				execute: sessions
					.send(
						new RecordModelRequestStart({
							session_id: payload.session_id,
							turn: payload.turn,
							request_seq: 1,
							model_request_start_id: requestId,
						}),
					)
					.pipe(
						Effect.map(() => PROCEED),
						Effect.catchTag("DuplicateModelRequest", () => Effect.succeed(ABORTED)),
						Effect.catchTag("SessionNotFound", () => Effect.succeed(ABORTED)),
						Effect.catchTag("SessionNotRunning", () => Effect.succeed(ABORTED)),
						Effect.catchTag("StaleTurn", () => Effect.succeed(ABORTED)),
						Effect.catchTag("OutOfOrderModelRequest", () => Effect.succeed(ABORTED)),
					),
			})

			if (started.status === "aborted") {
				return { status: "aborted" as const }
			}

			const generated = yield* Activity.make({
				name: "generate-model-reply",
				success: GenerateOutcome,
				execute: provider
					.generate({
						session_id: payload.session_id,
						agent_id: payload.agent_id,
						agent_version: payload.agent_version,
						environment_id: payload.environment_id,
						turn: payload.turn,
						generation: payload.generation,
						input: payload.input,
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
						Effect.catchTag("ModelProviderError", (err: ModelProviderError) =>
							Effect.succeed({
								ok: false as const,
								interrupted: false as const,
								model_usage: err.model_usage ?? { input_tokens: 0, output_tokens: 0 },
								error_type: err.error_type,
								message: err.message,
								disposition: err.terminal ? ("terminal" as const) : ("exhausted" as const),
							}),
						),
						Effect.catchTag("HarnessUnavailable", () =>
							Effect.succeed({
								ok: false as const,
								interrupted: false as const,
								model_usage: { input_tokens: 0, output_tokens: 0 },
								error_type: HARNESS_UNAVAILABLE,
								message: HARNESS_UNAVAILABLE_MESSAGE,
								disposition: "abandoned" as const,
							}),
						),
						Effect.catchTag("ModelRequestInterrupted", (err) =>
							Effect.succeed({
								ok: false as const,
								interrupted: true as const,
								model_usage: err.model_usage ?? { input_tokens: 0, output_tokens: 0 },
							}),
						),
					),
			})

			if (!generated.ok && generated.interrupted) {
				const interrupted = yield* Activity.make({
					name: "interrupt-model-request",
					success: StepOutcome,
					execute: sessions
						.send(
							new InterruptModelRequest({
								model_usage: generated.model_usage,
								session_id: payload.session_id,
								turn: payload.turn,
								request_seq: 1,
								model_request_start_id: requestId,
							}),
						)
						.pipe(
							Effect.map(() => PROCEED),
							Effect.catchTag("UnknownModelRequest", () => Effect.succeed(ABORTED)),
							Effect.catchTag("SessionNotFound", () => Effect.succeed(ABORTED)),
							Effect.catchTag("SessionNotRunning", () => Effect.succeed(ABORTED)),
							Effect.catchTag("StaleTurn", () => Effect.succeed(ABORTED)),
						),
				})

				return interrupted.status === "aborted"
					? { status: "aborted" as const }
					: { status: "interrupted" as const }
			}

			if (!generated.ok) {
				const failed = yield* Activity.make({
					name: "fail-model-request",
					success: StepOutcome,
					execute: sessions
						.send(
							new FailModelRequest({
								model_usage: generated.model_usage,
								session_id: payload.session_id,
								turn: payload.turn,
								request_seq: 1,
								model_request_start_id: requestId,
								error_type: generated.error_type,
								message: generated.message,
								disposition: generated.disposition,
							}),
						)
						.pipe(
							Effect.map(() => PROCEED),
							Effect.catchTag("UnknownModelRequest", () => Effect.succeed(ABORTED)),
							Effect.catchTag("SessionNotFound", () => Effect.succeed(ABORTED)),
							Effect.catchTag("SessionNotRunning", () => Effect.succeed(ABORTED)),
							Effect.catchTag("StaleTurn", () => Effect.succeed(ABORTED)),
						),
				})

				return failed.status === "aborted"
					? { status: "aborted" as const }
					: { status: "failed" as const }
			}

			const committed = yield* Activity.make({
				name: "commit-model-reply",
				success: StepOutcome,
				execute: sessions
					.send(
						new CommitModelReply({
							session_id: payload.session_id,
							turn: payload.turn,
							request_seq: 1,
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
						Effect.map(() => PROCEED),
						Effect.catchTag("UnknownModelRequest", () => Effect.succeed(ABORTED)),
						Effect.catchTag("SessionNotFound", () => Effect.succeed(ABORTED)),
						Effect.catchTag("SessionNotRunning", () => Effect.succeed(ABORTED)),
						Effect.catchTag("StaleTurn", () => Effect.succeed(ABORTED)),
					),
			})

			return committed.status === "aborted"
				? { status: "aborted" as const }
				: { status: "completed" as const }
		})
	}),
)
