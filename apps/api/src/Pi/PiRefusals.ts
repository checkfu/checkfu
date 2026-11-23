import type { TurnFailed } from "@checkfu/domain/Session/Harness.external"
import type { ModelUsage } from "@checkfu/domain/Session/SessionTypes"
import type { Api, AssistantMessage } from "@earendil-works/pi-ai"
import { GenerationTask, createRegistry, defineExtension, hook } from "@earendil-works/pi-durable"

import type { PiTurnOutcome } from "./PiTurn.ts"

export const PROVIDER_FAILURE_MESSAGE = "The model provider returned an error."
export const DEFAULT_REFUSAL_TEXT = "The model refused to complete the request."

const ABORTED_ERROR: TurnFailed = {
	_tag: "TurnFailed",
	error_type: "model_request_aborted",
	message: "Model request was aborted.",
	terminal: false,
}

/**
 * Single provider-specific, case-sensitive predicate for confirmed provider
 * refusal stop reasons. Shared by the stream wrappers in `PiModels.ts` and the
 * downstream refusal hooks/recovery logic so unconfirmed stop reasons (such as
 * an Anthropic `content_filter` or case-mismatched value) stay on the error path.
 */
export const isProviderRefusalStopReason = (
	api: Api,
	provider: string,
	rawStopReason: string | undefined,
): boolean => {
	if (rawStopReason === undefined) {
		return false
	}
	if (api === "anthropic-messages" && provider === "anthropic") {
		return rawStopReason === "refusal" || rawStopReason === "sensitive"
	}
	if (api === "openai-responses" && provider === "openai") {
		return rawStopReason === "refusal" || rawStopReason === "incomplete.content_filter"
	}
	return false
}

export const isRefusalAssistantMessage = (message: AssistantMessage): boolean =>
	isProviderRefusalStopReason(message.api, message.provider, message.rawStopReason)

const refusalFallbackText = (message: AssistantMessage): string => {
	const detail = message.errorMessage?.trim()
	if (detail !== undefined && detail.length > 0 && detail !== DEFAULT_REFUSAL_TEXT) {
		console.warn("pi refusal fallback", {
			provider: message.provider,
			model: message.model,
			rawStopReason: message.rawStopReason,
		})
	}
	return DEFAULT_REFUSAL_TEXT
}

/**
 * Only completed OpenAI Responses `refusal` parts contain provider-authored
 * refusal text in `message.content`. Filter stops (`incomplete.content_filter`,
 * Anthropic `sensitive`, Anthropic `refusal`) can contain partial generated
 * output streamed before the safety filter cut off the response and must have
 * their partial content discarded in favor of a refusal notice.
 */
const preservesExplicitRefusalContent = (message: AssistantMessage): boolean =>
	message.api === "openai-responses" &&
	message.provider === "openai" &&
	message.rawStopReason === "refusal"

/**
 * Returns a model-context-eligible (`stopReason: "stop"`) copy of a confirmed
 * refusal message carrying the published refusal text, with `errorMessage`
 * cleared so Pi includes it in subsequent turns' conversation context.
 * Discards partial generated text/thinking for filter stops and preserves
 * provider-authored text only for explicit OpenAI `refusal` parts.
 */
export const normalizeRefusalAssistantMessage = (message: AssistantMessage): AssistantMessage => {
	const explicitText = preservesExplicitRefusalContent(message)
		? message.content.filter((block) => block.type === "text" && block.text.length > 0)
		: []
	const content =
		explicitText.length > 0
			? explicitText
			: [{ type: "text" as const, text: refusalFallbackText(message) }]
	const { errorMessage: _cleared, ...rest } = message
	return {
		...rest,
		content,
		stopReason: "stop",
	}
}

/**
 * Normalizes confirmed provider refusals (Anthropic `refusal`/`sensitive` and
 * OpenAI `incomplete.content_filter` or textless completed refusals) into
 * completed `stopReason: "stop"` answers with published text before Pi
 * classifies or persists them. Keeps the published refusal in Pi's live
 * conversation history and avoids retrying refusals as provider errors.
 */
export const createCheckfuRegistry = () => {
	const registry = createRegistry()
	registry.install(
		defineExtension({
			name: "checkfu-refusal-normalization",
			hooks: [
				hook(GenerationTask, {
					afterResponse(message) {
						if (!isRefusalAssistantMessage(message)) {
							return
						}
						if (message.stopReason !== "error" && message.stopReason !== "stop") {
							return
						}
						const normalized = normalizeRefusalAssistantMessage(message)
						message.content = normalized.content
						message.stopReason = normalized.stopReason
						delete message.errorMessage
					},
				}),
			],
		}),
	)
	return registry
}

export const mapAssistantMessageToOutcome = (
	message: AssistantMessage,
	modelUsage: ModelUsage,
): PiTurnOutcome => {
	const refusal = isRefusalAssistantMessage(message)

	if (message.stopReason === "error") {
		return {
			ok: false,
			error: {
				_tag: "TurnFailed",
				error_type: "model_request_failed_error",
				model_usage: modelUsage,
				message: PROVIDER_FAILURE_MESSAGE,
				terminal: false,
			},
		}
	}
	if (message.stopReason === "aborted") {
		return { ok: false, error: { ...ABORTED_ERROR, model_usage: modelUsage } }
	}

	const thinkingParts: Array<string> = []
	const textParts: Array<string> = []
	for (const block of message.content) {
		if (block.type === "thinking" && block.thinking.length > 0) {
			thinkingParts.push(block.thinking)
		} else if (block.type === "text" && block.text.length > 0) {
			textParts.push(block.text)
		}
	}

	const rawText = textParts.join("")
	const text = rawText.length > 0 ? rawText : refusal ? refusalFallbackText(message) : ""

	if (text.length === 0) {
		return {
			ok: false,
			error: {
				_tag: "TurnFailed",
				error_type: "empty_model_reply",
				model_usage: modelUsage,
				message: "Model provider returned an empty reply.",
				terminal: false,
			},
		}
	}

	const thinking = thinkingParts.length > 0 ? thinkingParts.join("\n") : null
	const stopReason = refusal
		? ({ type: "refusal" } as const)
		: message.stopReason === "length"
			? ({ type: "budget_reached" } as const)
			: ({ type: "end_turn" } as const)

	return {
		ok: true,
		reply: {
			thinking,
			text,
			...modelUsage,
			stop_reason: stopReason,
		},
	}
}

export const mapUnansweredToError = (reason: string | undefined): TurnFailed => {
	if (reason === "no_model") {
		return {
			_tag: "TurnFailed",
			error_type: "unknown_model_error",
			message: "The agent's model is not available.",
			terminal: true,
		}
	}
	return {
		_tag: "TurnFailed",
		error_type: "model_request_failed_error",
		message: PROVIDER_FAILURE_MESSAGE,
		terminal: false,
	}
}
