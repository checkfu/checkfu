import { SessionSystemContext } from "./PiDocRegistry.ts"
import type { TurnFailed } from "@checkfu/domain/Session/Harness.external"
import type { ModelUsage } from "@checkfu/domain/Session/SessionTypes"
import {
	DEFAULT_REFUSAL_TEXT,
	isRefusalAssistantMessage,
	isWireFormatRefusalStopReason,
	normalizeRefusalAssistantMessage as normalizeWireRefusalAssistantMessage,
} from "@checkfu/pi-providers/refusals"
import type { Api, AssistantMessage } from "@earendil-works/pi-ai"
import { GenerationTask, createRegistry, defineExtension, hook } from "@earendil-works/pi-durable"

import type { PiTurnOutcome } from "./PiTurn.ts"
import { resultBoundsExtension } from "./PiResultBounds.ts"
import { rejectionProvenanceExtension } from "./PiRejection.ts"

export { DEFAULT_REFUSAL_TEXT, isRefusalAssistantMessage }

export const PROVIDER_FAILURE_MESSAGE = "The model provider returned an error."

const ABORTED_ERROR: TurnFailed = {
	_tag: "TurnFailed",
	error_type: "model_request_aborted",
	message: "Model request was aborted.",
	terminal: false,
}

export const isProviderRefusalStopReason = (
	api: Api,
	_provider: string,
	rawStopReason: string | undefined,
): boolean => isWireFormatRefusalStopReason(api, rawStopReason)

const logRefusalFallback = (message: AssistantMessage): void => {
	const detail = message.errorMessage?.trim()
	if (detail !== undefined && detail.length > 0 && detail !== DEFAULT_REFUSAL_TEXT) {
		console.warn("pi refusal fallback", {
			provider: message.provider,
			model: message.model,
			rawStopReason: message.rawStopReason,
		})
	}
}

const refusalFallbackText = (message: AssistantMessage): string => {
	logRefusalFallback(message)
	return DEFAULT_REFUSAL_TEXT
}

export const normalizeRefusalAssistantMessage = (message: AssistantMessage): AssistantMessage =>
	normalizeWireRefusalAssistantMessage(message, logRefusalFallback)

export const createCheckfuRegistry = () => {
	const registry = createRegistry()
	registry.install(
		resultBoundsExtension(() =>
			registry
				.snapshot()
				.tools()
				.map(({ tool }) => tool),
		),
	)
	registry.install(rejectionProvenanceExtension)
	registry.install(
		defineExtension({
			name: "checkfu-session-system-context",
			hooks: [
				hook(GenerationTask, {
					async beforeRequest(request, api, context) {
						const stored = await api.snapshot(SessionSystemContext, context)
						if (stored === undefined || stored.text.length === 0) {
							return undefined
						}
						const messages = [...request.messages]
						const lastUser = messages.findLastIndex((message) => message.role === "user")
						messages.splice(lastUser < 0 ? messages.length : lastUser, 0, {
							role: "system",
							content: stored.text,
							timestamp: stored.updated_at,
						})
						return { messages }
					},
				}),
			],
		}),
	)

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
