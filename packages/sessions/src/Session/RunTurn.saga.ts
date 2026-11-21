import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Activity } from "effect/workflow"
import { CommitModelReply } from "./CommitModelReply.command.ts"
import { FailModelRequest } from "./FailModelRequest.command.ts"
import {
	ConversationMessage,
	DEFAULT_MODEL_TIMEOUT_MS,
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
	NonNegativeInt,
	PositiveInt,
	ResourceId,
	ThinkingText,
} from "./SessionTypes.ts"

export const TurnId = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("TurnId"))
export type TurnId = typeof TurnId.Type

export const turnKey = (session_id: SessionId, turn: number): TurnId =>
	TurnId.make(`${session_id}:turn:${turn}`)

const StepOutcome = Schema.Struct({
	status: Schema.Literals(["proceed", "aborted"]),
})

export const GenerateOutcome = Schema.Union([
	Schema.Struct({
		ok: Schema.Literal(true),
		thinking: Schema.NullOr(ThinkingText),
		text: MessageText,
		input_tokens: NonNegativeInt,
		output_tokens: NonNegativeInt,
		stop_reason: ModelStopReason,
	}),
	Schema.Struct({
		ok: Schema.Literal(false),
		error_type: ErrorType,
		message: ErrorMessage,
		terminal: Schema.Boolean,
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
		messages: Schema.Array(ConversationMessage),
	},
	result: {
		status: Schema.Literals(["completed", "failed", "aborted"]),
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
						timeout_ms: DEFAULT_MODEL_TIMEOUT_MS,
						messages: payload.messages,
					})
					.pipe(
						Effect.map((reply) => ({
							ok: true as const,
							thinking: reply.thinking,
							text: reply.text,
							input_tokens: reply.input_tokens,
							output_tokens: reply.output_tokens,
							stop_reason: reply.stop_reason,
						})),
						Effect.catchTag("ModelProviderError", (err: ModelProviderError) =>
							Effect.succeed({
								ok: false as const,
								error_type: err.error_type,
								message: err.message,
								terminal: err.terminal,
							}),
						),
					),
			})

			if (!generated.ok) {
				const failed = yield* Activity.make({
					name: "fail-model-request",
					success: StepOutcome,
					execute: sessions
						.send(
							new FailModelRequest({
								session_id: payload.session_id,
								turn: payload.turn,
								request_seq: 1,
								model_request_start_id: requestId,
								error_type: generated.error_type,
								message: generated.message,
								terminal: generated.terminal,
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
