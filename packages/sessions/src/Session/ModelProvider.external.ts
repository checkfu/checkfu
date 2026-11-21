import * as Domain from "@alchemy.run/domain"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Session } from "./Session.aggregate.ts"
import { SessionId } from "./Session.id.ts"
import {
	ErrorMessage,
	ErrorType,
	MAX_ERROR_MESSAGE_LENGTH,
	MAX_ERROR_TYPE_LENGTH,
	MAX_MESSAGE_TEXT_LENGTH,
	MAX_THINKING_TEXT_LENGTH,
	MessageText,
	NonEmptyString,
	NonNegativeInt,
	PositiveInt,
	ResourceId,
	ThinkingText,
} from "./SessionTypes.ts"
import { type SessionSnapshot, SessionView } from "./SessionView.view.ts"

export const DEFAULT_MODEL_TIMEOUT_MS = 60_000
export const DEFAULT_CANCELLATION_POLL_MS = 2_000

export const ModelGenerationTimeout = Context.Reference<number>(
	"@checkfu/sessions/ModelGenerationTimeout",
	{ defaultValue: () => DEFAULT_MODEL_TIMEOUT_MS },
)

export const ModelCancellationPollInterval = Context.Reference<number>(
	"@checkfu/sessions/ModelCancellationPollInterval",
	{ defaultValue: () => DEFAULT_CANCELLATION_POLL_MS },
)

export const ModelStopReason = Schema.Struct({
	type: Schema.Literals(["end_turn", "budget_reached", "refusal"]),
})
export type ModelStopReason = typeof ModelStopReason.Type

export const ConversationMessage = Schema.Struct({
	role: Schema.Literals(["user", "assistant"]),
	text: NonEmptyString,
})
export type ConversationMessage = typeof ConversationMessage.Type

export const ModelProviderError = Schema.TaggedStruct("ModelProviderError", {
	error_type: ErrorType,
	message: ErrorMessage,
	terminal: Schema.Boolean,
})
export type ModelProviderError = typeof ModelProviderError.Type

export class ModelProvider extends Domain.ExternalSystem("ModelProvider", {
	generate: {
		args: {
			session_id: SessionId,
			agent_id: ResourceId,
			agent_version: PositiveInt,
			environment_id: ResourceId,
			turn: PositiveInt,
			timeout_ms: PositiveInt,
			messages: Schema.Array(ConversationMessage),
		},
		success: {
			thinking: Schema.NullOr(ThinkingText),
			text: MessageText,
			input_tokens: NonNegativeInt,
			output_tokens: NonNegativeInt,
			stop_reason: ModelStopReason,
		},
		error: ModelProviderError,
	},
}) {}

const clampText = (value: string, maxLength: number, fallback: string): string => {
	if (value.length === 0) return fallback
	return value.length > maxLength ? value.slice(0, maxLength) : value
}

export interface ModelProviderReply {
	readonly thinking: string | null
	readonly text: string
	readonly input_tokens: number
	readonly output_tokens: number
	readonly stop_reason: ModelStopReason
}

const EMPTY_REPLY_ERROR: ModelProviderError = {
	_tag: "ModelProviderError",
	error_type: "empty_model_reply",
	message: "Model provider returned an empty reply.",
	terminal: false,
}

export const clampModelReply = (
	reply: ModelProviderReply,
): Effect.Effect<ModelProviderReply, ModelProviderError> => {
	if (reply.text.length === 0) {
		return Effect.fail(EMPTY_REPLY_ERROR)
	}
	return Effect.succeed({
		...reply,
		thinking:
			reply.thinking === null || reply.thinking.length === 0
				? null
				: reply.thinking.length > MAX_THINKING_TEXT_LENGTH
					? reply.thinking.slice(0, MAX_THINKING_TEXT_LENGTH)
					: reply.thinking,
		text:
			reply.text.length > MAX_MESSAGE_TEXT_LENGTH
				? reply.text.slice(0, MAX_MESSAGE_TEXT_LENGTH)
				: reply.text,
	})
}

export const clampModelProviderError = (err: ModelProviderError): ModelProviderError => ({
	...err,
	error_type: clampText(err.error_type, MAX_ERROR_TYPE_LENGTH, "provider_error"),
	message: clampText(err.message, MAX_ERROR_MESSAGE_LENGTH, "Model provider failed."),
})

/**
 * Wraps a raw model adapter so oversized reasoning traces, replies, or error
 * metadata are truncated before ExternalSystem schema validation and workflow
 * checkpointing, and empty replies are rejected as provider errors.
 */
export const boundedModelProvider = <R = never>(
	impl: Effect.Effect<
		{
			readonly generate: (args: {
				readonly session_id: SessionId
				readonly agent_id: string
				readonly agent_version: number
				readonly environment_id: string
				readonly turn: number
				readonly timeout_ms: number
				readonly messages: ReadonlyArray<ConversationMessage>
			}) => Effect.Effect<ModelProviderReply, ModelProviderError>
		},
		never,
		R
	>,
) =>
	ModelProvider.toLayer(
		Effect.map(impl, (adapter) => ({
			generate: (args) =>
				adapter
					.generate(args)
					.pipe(Effect.mapError(clampModelProviderError), Effect.flatMap(clampModelReply)),
		})),
	)

const INTERNAL_PROVIDER_ERROR: ModelProviderError = {
	_tag: "ModelProviderError",
	error_type: "provider_internal_error",
	message: "Model provider failed unexpectedly.",
	terminal: false,
}

const TURN_CANCELLED_ERROR: ModelProviderError = {
	_tag: "ModelProviderError",
	error_type: "turn_cancelled",
	message: "Turn was cancelled.",
	terminal: false,
}

export const TimeoutModelProvider = ModelProvider.toLayer(
	Effect.gen(function* () {
		const inner = yield* ModelProvider
		const views = yield* SessionView
		return {
			generate: (args) =>
				Effect.gen(function* () {
					const configuredMs = yield* ModelGenerationTimeout
					const pollIntervalMs = yield* ModelCancellationPollInterval
					const effectiveMs = Math.min(args.timeout_ms, configuredMs)
					const fiber = yield* Effect.forkDetach(inner.generate(args))

					const isCancelledSnapshot = (opt: Option.Option<SessionSnapshot | null>): boolean =>
						Option.isSome(opt) &&
						opt.value !== null &&
						(opt.value.status === "terminated" ||
							opt.value.turn > args.turn ||
							(opt.value.turn === args.turn && opt.value.status === "idle"))

					const waitForCancellation = Effect.gen(function* () {
						while (true) {
							yield* Effect.sleep(`${pollIntervalMs} millis`)
							const snapshot = yield* views
								.get(Session.ref(args.session_id))
								.pipe(
									Effect.catchCause((cause) =>
										Cause.hasInterruptsOnly(cause)
											? Effect.interrupt
											: Effect.logError(
													"SessionView.get failed during cancellation check",
													cause,
												).pipe(Effect.as(Option.none<SessionSnapshot | null>())),
									),
								)
							if (isCancelledSnapshot(snapshot)) {
								return { _tag: "Cancelled" as const }
							}
						}
					})

					const waitForProvider = Fiber.await(fiber).pipe(
						Effect.map((exit) => ({ _tag: "Done" as const, exit })),
					)

					const raceOutcome = yield* Effect.raceFirst(waitForProvider, waitForCancellation).pipe(
						Effect.timeoutOption(`${effectiveMs} millis`),
						Effect.onExit((exit) =>
							Exit.isFailure(exit)
								? Effect.forkDetach(Fiber.interrupt(fiber)).pipe(Effect.asVoid)
								: Effect.void,
						),
					)

					if (Option.isNone(raceOutcome)) {
						yield* Effect.forkDetach(Fiber.interrupt(fiber))
						return yield* Effect.fail({
							_tag: "ModelProviderError" as const,
							error_type: "model_request_timeout",
							message: "Model request timed out.",
							terminal: false,
						})
					}

					if (raceOutcome.value._tag === "Cancelled") {
						yield* Effect.forkDetach(Fiber.interrupt(fiber))
						return yield* Effect.fail(TURN_CANCELLED_ERROR)
					}

					const exit = raceOutcome.value.exit
					if (Exit.isSuccess(exit)) {
						return yield* clampModelReply(exit.value)
					}
					const typedError = Cause.findErrorOption(exit.cause)
					if (Option.isSome(typedError)) {
						return yield* Effect.fail(clampModelProviderError(typedError.value))
					}
					yield* Effect.logError("ModelProvider failed unexpectedly", exit.cause)
					return yield* Effect.fail(INTERNAL_PROVIDER_ERROR)
				}),
		}
	}),
)
