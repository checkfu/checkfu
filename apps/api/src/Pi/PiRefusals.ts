import type {
	ModelProviderError,
	ModelProviderReply,
	ModelRequestInterrupted,
} from "@checkfu/sessions/Session/ModelProvider.external"
import type { ModelUsage } from "@checkfu/sessions/Session/SessionTypes"
import type { Api, AssistantMessage } from "@earendil-works/pi-ai"
import type { Models } from "@earendil-works/pi-ai/models"
import {
	type EntryId,
	GenerationTask,
	createRegistry,
	defineExtension,
	hook,
} from "@earendil-works/pi-durable"

export type PiTurnOutcome =
	| { readonly ok: true; readonly reply: ModelProviderReply }
	| { readonly ok: false; readonly error: ModelProviderError | ModelRequestInterrupted }

export interface UnansweredSubmissionInfo {
	readonly reason: string
	readonly detail?: string
	readonly assistantMessage?: AssistantMessage
	readonly assistantEntryId?: EntryId
}

export const PROVIDER_FAILURE_MESSAGE = "The model provider returned an error."
export const DEFAULT_REFUSAL_TEXT = "The model refused to complete the request."

const ABORTED_ERROR: ModelProviderError = {
	_tag: "ModelProviderError",
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
	if (rawStopReason === undefined) return false
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
 * Wraps `models.complete` / `models.completeSimple` (used by Pi's `CompactionTask`)
 * so confirmed provider refusals never pass `summaryText` as a `stopReason: "stop"`
 * summary and overwrite older conversation history. Ordinary turns stream through
 * `streamSimple` and normalize refusals in `createCheckfuRegistry`.
 */
export const rejectRefusalCompactions = <M extends Models>(models: M): M => {
	const rejectRefusal = (message: AssistantMessage): AssistantMessage =>
		isRefusalAssistantMessage(message) && message.stopReason !== "aborted"
			? {
					...message,
					stopReason: "error",
					errorMessage: refusalFallbackText(message),
				}
			: message
	return new Proxy(models, {
		get(target, prop, receiver) {
			if (prop === "completeSimple") {
				return async (...args: Parameters<Models["completeSimple"]>) =>
					rejectRefusal(await target.completeSimple(...args))
			}
			if (prop === "complete") {
				return async (...args: Parameters<Models["complete"]>) =>
					rejectRefusal(await target.complete(...args))
			}
			const value = Reflect.get(target, prop, receiver) as unknown
			return typeof value === "function" ? value.bind(target) : value
		},
	})
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
						if (!isRefusalAssistantMessage(message)) return
						if (message.stopReason !== "error" && message.stopReason !== "stop") return
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

	if (!refusal && message.stopReason === "error") {
		return {
			ok: false,
			error: {
				_tag: "ModelProviderError",
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

	const effective =
		refusal && message.stopReason === "error" ? normalizeRefusalAssistantMessage(message) : message

	const thinkingParts: Array<string> = []
	const textParts: Array<string> = []
	for (const block of effective.content) {
		if (block.type === "thinking" && block.thinking.length > 0) {
			thinkingParts.push(block.thinking)
		} else if (block.type === "text" && block.text.length > 0) {
			textParts.push(block.text)
		}
	}

	const rawText = textParts.join("")
	const text = rawText.length > 0 ? rawText : refusal ? refusalFallbackText(effective) : ""

	if (text.length === 0) {
		return {
			ok: false,
			error: {
				_tag: "ModelProviderError",
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

export const mapUnansweredToError = (
	reason: string | undefined,
	submissionInfo: UnansweredSubmissionInfo | null,
): ModelProviderError => {
	const effectiveReason = submissionInfo?.reason ?? reason ?? "model_error"
	if (effectiveReason === "no_model") {
		return {
			_tag: "ModelProviderError",
			error_type: "unknown_model_error",
			message: "The agent's model is not available.",
			terminal: true,
		}
	}
	return {
		_tag: "ModelProviderError",
		error_type: "model_request_failed_error",
		message: PROVIDER_FAILURE_MESSAGE,
		terminal: false,
	}
}

const parseEmbeddedJson = (detail: string): Record<string, unknown> | null => {
	const braceIndex = detail.indexOf("{")
	if (braceIndex < 0) return null
	try {
		const parsed: unknown = JSON.parse(detail.slice(braceIndex))
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null
	} catch {
		return null
	}
}

const extractProviderErrorCodes = (
	detail: string,
	json: Record<string, unknown> | null,
): ReadonlyArray<string> => {
	const codes: Array<string> = []
	const pushCode = (value: unknown) => {
		if (typeof value === "string" && value.trim().length > 0) {
			codes.push(value.trim().toLowerCase())
		}
	}
	if (json !== null) {
		const nested =
			typeof json.error === "object" && json.error !== null && !Array.isArray(json.error)
				? (json.error as Record<string, unknown>)
				: null
		if (nested !== null) {
			pushCode(nested.code)
			pushCode(nested.type)
		}
		pushCode(json.code)
		if (json.type !== "error") pushCode(json.type)
	}
	const errorCodePrefix = /^\s*error code\s+([a-z0-9._-]+)\s*:/i.exec(detail)
	if (errorCodePrefix?.[1] !== undefined) {
		codes.push(errorCodePrefix[1].toLowerCase())
	}
	return codes
}

const classifyErrorCode = (code: string): string | null => {
	if (
		code === "authentication_error" ||
		code === "permission_error" ||
		code === "invalid_api_key" ||
		code === "unauthorized" ||
		code === "forbidden"
	) {
		return "auth_error"
	}
	if (
		code === "rate_limit_error" ||
		code === "rate_limit_exceeded" ||
		code === "too_many_requests"
	) {
		return "rate_limit"
	}
	if (
		code === "invalid_request_error" ||
		code === "context_length_exceeded" ||
		code === "request_too_large" ||
		code === "unprocessable_entity"
	) {
		return "invalid_request"
	}
	if (
		code === "overloaded_error" ||
		code === "api_error" ||
		code === "server_error" ||
		code === "internal_server_error" ||
		code === "service_unavailable"
	) {
		return "provider_5xx"
	}
	return null
}

const extractHttpStatus = (detail: string, json: Record<string, unknown> | null): number | null => {
	const parseStatus = (value: unknown): number | null => {
		const num =
			typeof value === "number"
				? value
				: typeof value === "string" && /^[45]\d\d$/.test(value.trim())
					? Number(value.trim())
					: Number.NaN
		return Number.isInteger(num) && num >= 400 && num <= 599 ? num : null
	}
	if (json !== null) {
		const nested =
			typeof json.error === "object" && json.error !== null && !Array.isArray(json.error)
				? (json.error as Record<string, unknown>)
				: null
		for (const candidate of [
			json.status,
			json.statusCode,
			json.status_code,
			nested?.status,
			nested?.statusCode,
			nested?.status_code,
		]) {
			const status = parseStatus(candidate)
			if (status !== null) return status
		}
	}
	for (const pattern of [
		/^\s*(?:http(?:\/\d(?:\.\d)?)?\s+)?([45]\d\d)\b/i,
		/^\s*error code\s+([45]\d\d)\b/i,
		/\b(?:status(?:[\s_]?code)?\s*[:=]\s*|http(?:[\s/]+status)?\s+)([45]\d\d)\b/i,
	]) {
		const match = pattern.exec(detail)
		if (match?.[1] !== undefined) {
			const status = parseStatus(match[1])
			if (status !== null) return status
		}
	}
	return null
}

const classifyHttpStatus = (status: number): string | null => {
	if (status === 401 || status === 403) return "auth_error"
	if (status === 429) return "rate_limit"
	if (status === 400 || status === 422) return "invalid_request"
	if (status >= 500 && status <= 599) return "provider_5xx"
	return null
}

export const classifyUnansweredCategory = (
	reason: string | undefined,
	submissionInfo: UnansweredSubmissionInfo | null,
): string => {
	const effectiveReason = submissionInfo?.reason ?? reason ?? "model_error"
	if (effectiveReason !== "model_error") return effectiveReason
	const rawStop = submissionInfo?.assistantMessage?.rawStopReason?.toLowerCase()
	if (
		rawStop !== undefined &&
		rawStop.length > 0 &&
		rawStop.length <= 48 &&
		/^[a-z0-9._-]+$/.test(rawStop)
	) {
		return `model_error:${rawStop}`
	}
	const rawDetail = submissionInfo?.detail ?? ""
	const json = parseEmbeddedJson(rawDetail)
	for (const code of extractProviderErrorCodes(rawDetail, json)) {
		const category = classifyErrorCode(code)
		if (category !== null) return category
	}
	const httpStatus = extractHttpStatus(rawDetail, json)
	if (httpStatus !== null) {
		const category = classifyHttpStatus(httpStatus)
		if (category !== null) return category
	}
	const detail = rawDetail.toLowerCase()
	if (/\b(rate[_ ]limit|too many requests)\b/.test(detail)) return "rate_limit"
	if (/\b(unauthorized|forbidden|authentication|invalid[_ ]api[_ ]key)\b/.test(detail)) {
		return "auth_error"
	}
	if (/\b(invalid[_ ]request|context[_ ]length|too long)\b/.test(detail)) {
		return "invalid_request"
	}
	if (/\b(overloaded|unavailable|internal server|bad gateway|gateway timeout)\b/.test(detail)) {
		return "provider_5xx"
	}
	if (/\b(timeout|timed out|abort|network|fetch|socket|econn)\b/.test(detail)) {
		return "transport_error"
	}
	return "model_error"
}
