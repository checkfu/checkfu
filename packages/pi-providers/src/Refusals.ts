import type { Api, AssistantMessage } from "@earendil-works/pi-ai"

export const DEFAULT_REFUSAL_TEXT = "The model refused to complete the request."
export const OPENAI_INCOMPLETE_CONTENT_FILTER_ERROR = "Response incomplete: content_filter"
export const OPENAI_COMPLETIONS_CONTENT_FILTER_ERROR = "Provider finish_reason: content_filter"
export const OPENAI_REFUSAL_ERROR = DEFAULT_REFUSAL_TEXT
export const ANTHROPIC_DEFAULT_REFUSAL_ERROR = "The model refused to complete the request"
export const ANTHROPIC_SENSITIVE_ERROR = "Provider stopped with: sensitive"

export const isWireFormatRefusalStopReason = (
	api: Api,
	rawStopReason: string | undefined,
): boolean => {
	if (rawStopReason === undefined) {
		return false
	}
	if (api === "anthropic-messages") {
		return rawStopReason === "refusal" || rawStopReason === "sensitive"
	}
	if (api === "openai-responses") {
		return rawStopReason === "refusal" || rawStopReason === "incomplete.content_filter"
	}
	if (api === "openai-completions") {
		return rawStopReason === "refusal" || rawStopReason === "content_filter"
	}
	return false
}

export const isRefusalAssistantMessage = (message: AssistantMessage): boolean =>
	isWireFormatRefusalStopReason(message.api, message.rawStopReason)

export const preservesExplicitRefusalContent = (message: AssistantMessage): boolean =>
	(message.api === "openai-responses" || message.api === "openai-completions") &&
	message.rawStopReason === "refusal"

export const normalizeRefusalAssistantMessage = (
	message: AssistantMessage,
	onFallback?: (message: AssistantMessage) => void,
): AssistantMessage => {
	const explicitText = preservesExplicitRefusalContent(message)
		? message.content.filter((block) => block.type === "text" && block.text.length > 0)
		: []
	let content: AssistantMessage["content"]
	if (explicitText.length > 0) {
		content = explicitText
	} else {
		onFallback?.(message)
		content = [{ type: "text" as const, text: DEFAULT_REFUSAL_TEXT }]
	}
	const { errorMessage: _cleared, ...rest } = message
	return {
		...rest,
		content,
		stopReason: "stop",
	}
}
