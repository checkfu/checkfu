import type {
	TurnFailed,
	HarnessReply,
	TurnInterrupted,
} from "@checkfu/domain/Session/Harness.external"
import type { ModelUsage } from "@checkfu/domain/Session/SessionTypes"
import type { AnyModel, Api, AssistantMessage } from "@earendil-works/pi-ai"
import type { Models } from "@earendil-works/pi-ai/models"
import { GenerationTask, createRegistry, defineExtension, hook } from "@earendil-works/pi-durable"
import type { EntryId } from "@earendil-works/pi-durable"

export type PiTurnOutcome =
	| { readonly ok: true; readonly reply: HarnessReply }
	| { readonly ok: false; readonly error: TurnFailed | TurnInterrupted }

export interface UnansweredSubmissionInfo {
	readonly reason: string
	readonly detail?: string
	readonly assistantMessage?: AssistantMessage
	readonly assistantEntryId?: EntryId
}

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

const rejectRefusal = (message: AssistantMessage): AssistantMessage =>
	isRefusalAssistantMessage(message) && message.stopReason !== "aborted"
		? {
				...message,
				stopReason: "error",
				errorMessage: refusalFallbackText(message),
			}
		: message

/**
 * Wraps `models.complete` / `models.completeSimple` (used by Pi's `CompactionTask`)
 * so confirmed provider refusals never pass `summaryText` as a `stopReason: "stop"`
 * summary and overwrite older conversation history. Ordinary turns stream through
 * `streamSimple` and normalize refusals in `createCheckfuRegistry`.
 */
export const rejectRefusalCompactions = (models: Models): Models => ({
	getProviders: () => models.getProviders(),
	getProvider: (id) => models.getProvider(id),
	getModels: (provider) => models.getModels(provider),
	getModel: (provider, id) => models.getModel(provider, id),
	getModelsOfType: (type, provider) => models.getModelsOfType(type, provider),
	getModelOfType: (type, provider, id) => models.getModelOfType(type, provider, id),
	getAllModels: (provider) => models.getAllModels(provider),
	refresh: (options) => models.refresh(options),
	checkAuth: (providerId, options) => models.checkAuth(providerId, options),
	getAvailable: (providerId, options) => models.getAvailable(providerId, options),
	getAvailableOfType: (type, providerId, options) =>
		models.getAvailableOfType(type, providerId, options),
	getAllAvailable: (providerId, options) => models.getAllAvailable(providerId, options),
	getAuth: (target: string | AnyModel, overrides?: Parameters<Models["getAuth"]>[1]) =>
		typeof target === "string"
			? models.getAuth(target, overrides)
			: models.getAuth(target, overrides),
	login: (providerId, type, interaction, options) =>
		models.login(providerId, type, interaction, options),
	logout: (providerId, options) => models.logout(providerId, options),
	stream: (model, context, options) => models.stream(model, context, options),
	complete: async (model, context, options) =>
		rejectRefusal(await models.complete(model, context, options)),
	streamSimple: (model, context, options) => models.streamSimple(model, context, options),
	completeSimple: async (model, context, options) =>
		rejectRefusal(await models.completeSimple(model, context, options)),
	streamDeferred: (model, handle, options) => models.streamDeferred(model, handle, options),
	fetchDeferred: (model, handle, options) => models.fetchDeferred(model, handle, options),
	cancelDeferred: (model, handle, options) => models.cancelDeferred(model, handle, options),
	generateImages: (model, context, options) => models.generateImages(model, context, options),
	classify: (model, context, options) => models.classify(model, context, options),
})

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

	if (!refusal && message.stopReason === "error") {
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

export const mapUnansweredToError = (
	reason: string | undefined,
	submissionInfo: UnansweredSubmissionInfo | null,
): TurnFailed => {
	const effectiveReason = submissionInfo?.reason ?? reason ?? "model_error"
	if (effectiveReason === "no_model") {
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

interface ParsedProviderErrorFields {
	readonly code: string | undefined
	readonly type: string | undefined
	readonly status: number | string | undefined
	readonly statusCode: number | string | undefined
	readonly status_code: number | string | undefined
}

interface ParsedProviderErrorJson extends ParsedProviderErrorFields {
	readonly error: ParsedProviderErrorFields | null
}

const isPlainObject = (value: unknown): value is object =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const readStringField = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined

const readStatusField = (value: unknown): number | string | undefined =>
	typeof value === "number" || typeof value === "string" ? value : undefined

const parseProviderErrorFields = (value: unknown): ParsedProviderErrorFields | null => {
	if (!isPlainObject(value)) {
		return null
	}
	return {
		code: "code" in value ? readStringField(value.code) : undefined,
		type: "type" in value ? readStringField(value.type) : undefined,
		status: "status" in value ? readStatusField(value.status) : undefined,
		statusCode: "statusCode" in value ? readStatusField(value.statusCode) : undefined,
		status_code: "status_code" in value ? readStatusField(value.status_code) : undefined,
	}
}

const parseEmbeddedJson = (detail: string): ParsedProviderErrorJson | null => {
	const braceIndex = detail.indexOf("{")
	if (braceIndex < 0) {
		return null
	}
	try {
		const parsed: unknown = JSON.parse(detail.slice(braceIndex))
		const fields = parseProviderErrorFields(parsed)
		if (fields === null || !isPlainObject(parsed)) {
			return null
		}
		return {
			...fields,
			error: "error" in parsed ? parseProviderErrorFields(parsed.error) : null,
		}
	} catch {
		return null
	}
}

const extractProviderErrorCodes = (
	detail: string,
	json: ParsedProviderErrorJson | null,
): ReadonlyArray<string> => {
	const codes: Array<string> = []
	const pushCode = (value: string | undefined) => {
		if (value !== undefined && value.trim().length > 0) {
			codes.push(value.trim().toLowerCase())
		}
	}
	if (json !== null) {
		if (json.error !== null) {
			pushCode(json.error.code)
			pushCode(json.error.type)
		}
		pushCode(json.code)
		if (json.type !== "error") {
			pushCode(json.type)
		}
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

const parseHttpStatusCode = (value: unknown): number | null => {
	const num =
		typeof value === "number"
			? value
			: typeof value === "string" && /^[45]\d\d$/.test(value.trim())
				? Number(value.trim())
				: Number.NaN
	return Number.isInteger(num) && num >= 400 && num <= 599 ? num : null
}

const extractHttpStatus = (detail: string, json: ParsedProviderErrorJson | null): number | null => {
	if (json !== null) {
		for (const candidate of [
			json.status,
			json.statusCode,
			json.status_code,
			json.error?.status,
			json.error?.statusCode,
			json.error?.status_code,
		]) {
			const status = parseHttpStatusCode(candidate)
			if (status !== null) {
				return status
			}
		}
	}
	for (const pattern of [
		/^\s*(?:http(?:\/\d(?:\.\d)?)?\s+)?([45]\d\d)\b/i,
		/^\s*error code\s+([45]\d\d)\b/i,
		/\b(?:status(?:[\s_]?code)?\s*[:=]\s*|http(?:[\s/]+status)?\s+)([45]\d\d)\b/i,
	]) {
		const match = pattern.exec(detail)
		if (match?.[1] !== undefined) {
			const status = parseHttpStatusCode(match[1])
			if (status !== null) {
				return status
			}
		}
	}
	return null
}

const classifyHttpStatus = (status: number): string | null => {
	if (status === 401 || status === 403) {
		return "auth_error"
	}
	if (status === 429) {
		return "rate_limit"
	}
	if (status === 400 || status === 422) {
		return "invalid_request"
	}
	if (status >= 500 && status <= 599) {
		return "provider_5xx"
	}
	return null
}

export const classifyUnansweredCategory = (
	reason: string | undefined,
	submissionInfo: UnansweredSubmissionInfo | null,
): string => {
	const effectiveReason = submissionInfo?.reason ?? reason ?? "model_error"
	if (effectiveReason !== "model_error") {
		return effectiveReason
	}
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
		if (category !== null) {
			return category
		}
	}
	const httpStatus = extractHttpStatus(rawDetail, json)
	if (httpStatus !== null) {
		const category = classifyHttpStatus(httpStatus)
		if (category !== null) {
			return category
		}
	}
	const detail = rawDetail.toLowerCase()
	if (/\b(rate[_ ]limit|too many requests)\b/.test(detail)) {
		return "rate_limit"
	}
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
