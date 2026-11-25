import type {
	Api,
	Model,
	ProviderHeaders,
	ProviderStreams,
	StreamOptions,
} from "@earendil-works/pi-ai"
import * as anthropicMessages from "@earendil-works/pi-ai/api/anthropic-messages"
import * as openAICompletions from "@earendil-works/pi-ai/api/openai-completions"
import * as openAIResponses from "@earendil-works/pi-ai/api/openai-responses"
import { hasApi } from "@earendil-works/pi-ai/models"
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream"
import { createNoRedirectProviderFetch } from "./Fetch.ts"
import {
	ANTHROPIC_DEFAULT_REFUSAL_ERROR,
	ANTHROPIC_SENSITIVE_ERROR,
	OPENAI_COMPLETIONS_CONTENT_FILTER_ERROR,
	OPENAI_INCOMPLETE_CONTENT_FILTER_ERROR,
	OPENAI_REFUSAL_ERROR,
	isRefusalAssistantMessage,
} from "./Refusals.ts"
import { ownProperty } from "./Types.ts"
import type { WireFormat } from "./Types.ts"

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null

const extractMessageRefusalTexts = (item: unknown): ReadonlyArray<string> => {
	if (
		!isObject(item) ||
		!("type" in item) ||
		item.type !== "message" ||
		!("content" in item) ||
		!Array.isArray(item.content)
	) {
		return []
	}
	const texts: Array<string> = []
	for (const part of item.content) {
		if (isObject(part) && "type" in part && part.type === "refusal") {
			texts.push("refusal" in part && typeof part.refusal === "string" ? part.refusal : "")
		}
	}
	return texts
}

const completedResponseRefusalTexts = (response: unknown): ReadonlyArray<string> | null => {
	if (!isObject(response) || !("status" in response) || response.status !== "completed") {
		return []
	}
	if (!("output" in response) || !Array.isArray(response.output)) {
		return null
	}
	return response.output.flatMap(extractMessageRefusalTexts)
}

const isIncompleteContentFilterResponse = (response: unknown): boolean =>
	isObject(response) &&
	"status" in response &&
	response.status === "incomplete" &&
	"incomplete_details" in response &&
	isObject(response.incomplete_details) &&
	"reason" in response.incomplete_details &&
	response.incomplete_details.reason === "content_filter"

const expectedAnthropicRefusalMessage = (
	stopReason: string,
	stopDetails: unknown,
): string | null => {
	if (stopReason === "refusal") {
		const explanation =
			isObject(stopDetails) && "explanation" in stopDetails ? stopDetails.explanation : undefined
		return typeof explanation === "string" && explanation.length > 0
			? explanation
			: ANTHROPIC_DEFAULT_REFUSAL_ERROR
	}
	if (stopReason === "sensitive") {
		return ANTHROPIC_SENSITIVE_ERROR
	}
	return null
}

type WrappedStreamOverrides = Required<Pick<StreamOptions, "fetch" | "onProviderStreamEvent">> & {
	readonly headers?: ProviderHeaders
}

export interface WireFormatOptions {
	readonly fetch?: typeof fetch
	readonly allowedOrigins?: ReadonlyArray<string>
	readonly expectedBaseUrl?: string
	readonly isolateSdkEnvHeaders?: boolean
}

const readAmbientProcessEnv = (name: string): string | undefined => {
	if (typeof process === "undefined" || typeof process.env !== "object" || process.env === null) {
		return undefined
	}
	const value = ownProperty(process.env, name)
	return typeof value === "string" && value.length > 0 ? value : undefined
}

const parseSdkCustomHeaderNames = (raw: string | undefined): ReadonlyArray<string> => {
	if (raw === undefined || raw.length === 0) {
		return []
	}
	const names: Array<string> = []
	for (const line of raw.split("\n")) {
		const colon = line.indexOf(":")
		if (colon > 0) {
			const name = line.slice(0, colon).trim()
			if (name.length > 0) {
				names.push(name)
			}
		}
	}
	return names
}

const sdkInheritedEnvHeaderNames = (format: WireFormat): ReadonlyArray<string> => {
	if (format === "anthropic-messages") {
		return parseSdkCustomHeaderNames(readAmbientProcessEnv("ANTHROPIC_CUSTOM_HEADERS"))
	}
	return [
		"OpenAI-Organization",
		"OpenAI-Project",
		...parseSdkCustomHeaderNames(readAmbientProcessEnv("OPENAI_CUSTOM_HEADERS")),
	]
}

interface SdkHeaderIsolationPlan {
	readonly headersOverride?: ProviderHeaders
	readonly suppressedLowerNames: ReadonlySet<string>
}

const prepareSdkHeaderIsolation = (
	format: WireFormat,
	options: StreamOptions | undefined,
	wireOptions: WireFormatOptions | undefined,
): SdkHeaderIsolationPlan => {
	if (wireOptions?.isolateSdkEnvHeaders !== true) {
		return { suppressedLowerNames: new Set() }
	}
	const inherited = sdkInheritedEnvHeaderNames(format)
	if (inherited.length === 0) {
		return { suppressedLowerNames: new Set() }
	}
	const explicitActiveLower = new Set<string>()
	const existingHeaders = options?.headers
	if (existingHeaders !== undefined) {
		for (const [name, value] of Object.entries(existingHeaders)) {
			if (typeof value === "string") {
				explicitActiveLower.add(name.toLowerCase())
			}
		}
	}
	const suppressedNames: Array<string> = []
	const suppressedLowerNames = new Set<string>()
	for (const name of inherited) {
		const lower = name.toLowerCase()
		if (!explicitActiveLower.has(lower) && !suppressedLowerNames.has(lower)) {
			suppressedLowerNames.add(lower)
			suppressedNames.push(name)
		}
	}
	if (suppressedNames.length === 0) {
		return { suppressedLowerNames }
	}
	const mergedEntries: Array<readonly [string, string | null]> = []
	if (existingHeaders !== undefined) {
		for (const [name, value] of Object.entries(existingHeaders)) {
			mergedEntries.push([name, value])
		}
	}
	for (const name of suppressedNames) {
		mergedEntries.push([name, null])
	}
	return {
		headersOverride: Object.fromEntries(mergedEntries),
		suppressedLowerNames,
	}
}

const scrubHeadersFromFetch = (
	innerFetch: typeof fetch,
	suppressedLowerNames: ReadonlySet<string>,
): typeof fetch => {
	if (suppressedLowerNames.size === 0) {
		return innerFetch
	}
	const scrubbedFetch = (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	): Promise<Response> => {
		if (init?.headers === undefined) {
			return innerFetch(input, init)
		}
		const cleaned = new Headers(init.headers)
		for (const name of suppressedLowerNames) {
			cleaned.delete(name)
		}
		return innerFetch(input, { ...init, headers: cleaned })
	}
	return scrubbedFetch
}

const normalizeEndpointUrl = (
	raw: string,
): { readonly origin: string; readonly normalized: string } | null => {
	try {
		const parsed = new URL(raw)
		if (
			(parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
			parsed.origin === "null" ||
			parsed.username.length > 0 ||
			parsed.password.length > 0
		) {
			return null
		}
		const pathname = parsed.pathname.replace(/\/+$/, "")
		return {
			origin: parsed.origin,
			normalized: `${parsed.origin}${pathname}${parsed.search}${parsed.hash}`,
		}
	} catch {
		return null
	}
}

const validateModelEndpoint = (
	model: Model<Api>,
	wireOptions: WireFormatOptions | undefined,
): string | null => {
	const allowedOrigins = wireOptions?.allowedOrigins
	const expectedBaseUrl = wireOptions?.expectedBaseUrl
	if (
		(allowedOrigins === undefined || allowedOrigins.length === 0) &&
		expectedBaseUrl === undefined
	) {
		return null
	}
	const actual = normalizeEndpointUrl(model.baseUrl)
	if (actual === null) {
		return `Refusing request for model "${model.id}": invalid base URL.`
	}
	if (
		allowedOrigins !== undefined &&
		allowedOrigins.length > 0 &&
		!allowedOrigins.includes(actual.origin)
	) {
		return `Refusing request for model "${model.id}" to disallowed origin ${actual.origin}; provider "${model.provider}" is pinned to ${allowedOrigins.join(", ")}.`
	}
	if (expectedBaseUrl !== undefined) {
		const expected = normalizeEndpointUrl(expectedBaseUrl)
		if (expected === null || actual.normalized !== expected.normalized) {
			return `Refusing request for model "${model.id}" to mismatched endpoint ${actual.normalized}; provider "${model.provider}" is registered for ${expected?.normalized ?? expectedBaseUrl}.`
		}
	}
	return null
}

const resolveGuardedFetch = (
	model: Model<Api>,
	options: StreamOptions | undefined,
	wireOptions: WireFormatOptions | undefined,
	suppressedLowerNames: ReadonlySet<string>,
): typeof fetch =>
	scrubHeadersFromFetch(
		createNoRedirectProviderFetch(
			wireOptions?.expectedBaseUrl ?? model.baseUrl,
			options?.fetch ?? wireOptions?.fetch,
		),
		suppressedLowerNames,
	)

const runOpenAIResponsesRefusalGuard = (
	model: Model<"openai-responses">,
	options: StreamOptions | undefined,
	wireOptions: WireFormatOptions | undefined,
	start: (
		overrides: WrappedStreamOverrides,
	) => ReturnType<typeof createAssistantMessageEventStream>,
) => {
	const completedRefusalTexts: Array<string> = []
	let completedWithRefusal = false
	let finalRefusalTexts: ReadonlyArray<string> = []
	let sawIncompleteContentFilter = false
	let sawStreamError = false
	const upstreamOnEvent = options?.onProviderStreamEvent
	const isolation = prepareSdkHeaderIsolation("openai-responses", options, wireOptions)
	const inner = start({
		fetch: resolveGuardedFetch(model, options, wireOptions, isolation.suppressedLowerNames),
		...(isolation.headersOverride === undefined ? {} : { headers: isolation.headersOverride }),
		onProviderStreamEvent: async (data: unknown, eventModel: Model<Api>) => {
			if (isObject(data) && "type" in data) {
				if (data.type === "response.output_item.done" && "item" in data) {
					const texts = extractMessageRefusalTexts(data.item)
					if (texts.length > 0) {
						completedRefusalTexts.push(...texts)
					}
				} else if (data.type === "response.completed" && "response" in data) {
					const texts = completedResponseRefusalTexts(data.response)
					finalRefusalTexts = texts ?? completedRefusalTexts
					completedWithRefusal = finalRefusalTexts.length > 0
					sawIncompleteContentFilter = false
				} else if (data.type === "response.incomplete" && "response" in data) {
					sawIncompleteContentFilter = isIncompleteContentFilterResponse(data.response)
				} else if (data.type === "error") {
					sawStreamError = true
				}
			}
			await upstreamOnEvent?.(data, eventModel)
		},
	})
	const outer = createAssistantMessageEventStream()
	void (async () => {
		try {
			for await (const event of inner) {
				if (event.type === "done" && completedWithRefusal && event.message.stopReason === "stop") {
					const refusalText = finalRefusalTexts.filter((text) => text.length > 0).join("")
					outer.push({
						type: "error",
						reason: "error",
						error: {
							...event.message,
							content: refusalText.length > 0 ? [{ type: "text", text: refusalText }] : [],
							stopReason: "error",
							rawStopReason: "refusal",
							errorMessage: OPENAI_REFUSAL_ERROR,
						},
					})
				} else if (event.type === "done" && isRefusalAssistantMessage(event.message)) {
					const { rawStopReason: _dropped, ...rest } = event.message
					outer.push({ ...event, message: rest })
				} else if (event.type === "error" && isRefusalAssistantMessage(event.error)) {
					const isConfirmedIncompleteRefusal =
						event.reason === "error" &&
						event.error.stopReason === "error" &&
						sawIncompleteContentFilter &&
						!sawStreamError &&
						event.error.rawStopReason === "incomplete.content_filter" &&
						event.error.errorMessage === OPENAI_INCOMPLETE_CONTENT_FILTER_ERROR
					if (isConfirmedIncompleteRefusal) {
						outer.push(event)
					} else {
						const { rawStopReason: _dropped, ...rest } = event.error
						outer.push({ ...event, error: rest })
					}
				} else {
					outer.push(event)
				}
			}
		} finally {
			outer.end()
		}
	})()
	return outer
}

const runAnthropicMessagesRefusalGuard = (
	model: Model<"anthropic-messages">,
	options: StreamOptions | undefined,
	wireOptions: WireFormatOptions | undefined,
	start: (
		overrides: WrappedStreamOverrides,
	) => ReturnType<typeof createAssistantMessageEventStream>,
) => {
	let sawMessageStop = false
	let sawStreamError = false
	let expectedRefusalErrorMessage: string | null = null
	const upstreamOnEvent = options?.onProviderStreamEvent
	const isolation = prepareSdkHeaderIsolation("anthropic-messages", options, wireOptions)
	const inner = start({
		fetch: resolveGuardedFetch(model, options, wireOptions, isolation.suppressedLowerNames),
		...(isolation.headersOverride === undefined ? {} : { headers: isolation.headersOverride }),
		onProviderStreamEvent: async (data: unknown, eventModel: Model<Api>) => {
			if (isObject(data) && "type" in data) {
				if (data.type === "message_delta" && "delta" in data && isObject(data.delta)) {
					if ("stop_reason" in data.delta && typeof data.delta.stop_reason === "string") {
						expectedRefusalErrorMessage = expectedAnthropicRefusalMessage(
							data.delta.stop_reason,
							"stop_details" in data.delta ? data.delta.stop_details : undefined,
						)
					}
				} else if (data.type === "message_stop") {
					sawMessageStop = true
				} else if (data.type === "error") {
					sawStreamError = true
				}
			}
			await upstreamOnEvent?.(data, eventModel)
		},
	})
	const outer = createAssistantMessageEventStream()
	void (async () => {
		try {
			for await (const event of inner) {
				if (event.type === "error" && isRefusalAssistantMessage(event.error)) {
					const isConfirmedRefusal =
						event.reason === "error" &&
						event.error.stopReason === "error" &&
						sawMessageStop &&
						!sawStreamError &&
						expectedRefusalErrorMessage !== null &&
						event.error.errorMessage === expectedRefusalErrorMessage
					if (isConfirmedRefusal) {
						outer.push(
							event.error.rawStopReason === "sensitive"
								? event
								: {
										...event,
										error: { ...event.error, errorMessage: ANTHROPIC_DEFAULT_REFUSAL_ERROR },
									},
						)
					} else {
						const { rawStopReason: _dropped, ...rest } = event.error
						outer.push({ ...event, error: rest })
					}
				} else if (event.type === "done" && isRefusalAssistantMessage(event.message)) {
					const { rawStopReason: _dropped, ...rest } = event.message
					outer.push({ ...event, message: rest })
				} else {
					outer.push(event)
				}
			}
		} finally {
			outer.end()
		}
	})()
	return outer
}

const runOpenAICompletionsRefusalGuard = (
	model: Model<"openai-completions">,
	options: StreamOptions | undefined,
	wireOptions: WireFormatOptions | undefined,
	start: (
		overrides: WrappedStreamOverrides,
	) => ReturnType<typeof createAssistantMessageEventStream>,
) => {
	const refusalChunks: Array<string> = []
	let sawRefusalDelta = false
	let sawContentFilter = false
	let sawStreamError = false
	const upstreamOnEvent = options?.onProviderStreamEvent
	const isolation = prepareSdkHeaderIsolation("openai-completions", options, wireOptions)
	const inner = start({
		fetch: resolveGuardedFetch(model, options, wireOptions, isolation.suppressedLowerNames),
		...(isolation.headersOverride === undefined ? {} : { headers: isolation.headersOverride }),
		onProviderStreamEvent: async (data: unknown, eventModel: Model<Api>) => {
			if (isObject(data)) {
				if ("error" in data && data.error !== null && data.error !== undefined) {
					sawStreamError = true
				}
				if ("choices" in data && Array.isArray(data.choices)) {
					const first: unknown = data.choices[0]
					if (isObject(first)) {
						if ("finish_reason" in first && typeof first.finish_reason === "string") {
							sawContentFilter = first.finish_reason === "content_filter"
						}
						if ("delta" in first && isObject(first.delta) && "refusal" in first.delta) {
							if (typeof first.delta.refusal === "string" && first.delta.refusal.length > 0) {
								sawRefusalDelta = true
								refusalChunks.push(first.delta.refusal)
							}
						}
					}
				}
			}
			await upstreamOnEvent?.(data, eventModel)
		},
	})
	const outer = createAssistantMessageEventStream()
	void (async () => {
		try {
			for await (const event of inner) {
				if (
					event.type === "done" &&
					sawRefusalDelta &&
					!sawStreamError &&
					(event.message.stopReason === "stop" || event.message.stopReason === "length")
				) {
					const refusalText = refusalChunks.join("")
					outer.push({
						type: "error",
						reason: "error",
						error: {
							...event.message,
							content: refusalText.length > 0 ? [{ type: "text", text: refusalText }] : [],
							stopReason: "error",
							rawStopReason: "refusal",
							errorMessage: OPENAI_REFUSAL_ERROR,
						},
					})
				} else if (event.type === "done" && isRefusalAssistantMessage(event.message)) {
					const { rawStopReason: _dropped, ...rest } = event.message
					outer.push({ ...event, message: rest })
				} else if (event.type === "error" && isRefusalAssistantMessage(event.error)) {
					const isConfirmedContentFilter =
						event.reason === "error" &&
						event.error.stopReason === "error" &&
						sawContentFilter &&
						!sawStreamError &&
						event.error.rawStopReason === "content_filter" &&
						event.error.errorMessage === OPENAI_COMPLETIONS_CONTENT_FILTER_ERROR
					if (isConfirmedContentFilter) {
						outer.push(event)
					} else {
						const { rawStopReason: _dropped, ...rest } = event.error
						outer.push({ ...event, error: rest })
					}
				} else {
					outer.push(event)
				}
			}
		} finally {
			outer.end()
		}
	})()
	return outer
}

const rejectedStream = (model: Model<Api>, errorMessage: string) => {
	const stream = createAssistantMessageEventStream()
	stream.push({
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage,
			timestamp: Date.now(),
		},
	})
	stream.end()
	return stream
}

const mismatchedApiStream = (model: Model<Api>, expected: WireFormat) =>
	rejectedStream(model, `Model "${model.id}" uses API "${model.api}", expected "${expected}".`)

export const createAnthropicMessagesWire = (wireOptions?: WireFormatOptions): ProviderStreams => ({
	stream: (model, context, options) => {
		if (!hasApi(model, "anthropic-messages")) {
			return mismatchedApiStream(model, "anthropic-messages")
		}
		const endpointError = validateModelEndpoint(model, wireOptions)
		if (endpointError !== null) {
			return rejectedStream(model, endpointError)
		}
		return runAnthropicMessagesRefusalGuard(model, options, wireOptions, (overrides) =>
			anthropicMessages.stream(model, context, { ...options, ...overrides }),
		)
	},
	streamSimple: (model, context, options) => {
		if (!hasApi(model, "anthropic-messages")) {
			return mismatchedApiStream(model, "anthropic-messages")
		}
		const endpointError = validateModelEndpoint(model, wireOptions)
		if (endpointError !== null) {
			return rejectedStream(model, endpointError)
		}
		return runAnthropicMessagesRefusalGuard(model, options, wireOptions, (overrides) =>
			anthropicMessages.streamSimple(model, context, { ...options, ...overrides }),
		)
	},
})

export const createOpenAIResponsesWire = (wireOptions?: WireFormatOptions): ProviderStreams => ({
	stream: (model, context, options) => {
		if (!hasApi(model, "openai-responses")) {
			return mismatchedApiStream(model, "openai-responses")
		}
		const endpointError = validateModelEndpoint(model, wireOptions)
		if (endpointError !== null) {
			return rejectedStream(model, endpointError)
		}
		return runOpenAIResponsesRefusalGuard(model, options, wireOptions, (overrides) =>
			openAIResponses.stream(model, context, { ...options, ...overrides }),
		)
	},
	streamSimple: (model, context, options) => {
		if (!hasApi(model, "openai-responses")) {
			return mismatchedApiStream(model, "openai-responses")
		}
		const endpointError = validateModelEndpoint(model, wireOptions)
		if (endpointError !== null) {
			return rejectedStream(model, endpointError)
		}
		return runOpenAIResponsesRefusalGuard(model, options, wireOptions, (overrides) =>
			openAIResponses.streamSimple(model, context, { ...options, ...overrides }),
		)
	},
})

export const createOpenAICompletionsWire = (wireOptions?: WireFormatOptions): ProviderStreams => ({
	stream: (model, context, options) => {
		if (!hasApi(model, "openai-completions")) {
			return mismatchedApiStream(model, "openai-completions")
		}
		const endpointError = validateModelEndpoint(model, wireOptions)
		if (endpointError !== null) {
			return rejectedStream(model, endpointError)
		}
		return runOpenAICompletionsRefusalGuard(model, options, wireOptions, (overrides) =>
			openAICompletions.stream(model, context, { ...options, ...overrides }),
		)
	},
	streamSimple: (model, context, options) => {
		if (!hasApi(model, "openai-completions")) {
			return mismatchedApiStream(model, "openai-completions")
		}
		const endpointError = validateModelEndpoint(model, wireOptions)
		if (endpointError !== null) {
			return rejectedStream(model, endpointError)
		}
		return runOpenAICompletionsRefusalGuard(model, options, wireOptions, (overrides) =>
			openAICompletions.streamSimple(model, context, { ...options, ...overrides }),
		)
	},
})

export const createWireFormatStreams = (
	format: WireFormat,
	wireOptions?: WireFormatOptions,
): ProviderStreams => {
	switch (format) {
		case "anthropic-messages":
			return createAnthropicMessagesWire(wireOptions)
		case "openai-responses":
			return createOpenAIResponsesWire(wireOptions)
		case "openai-completions":
			return createOpenAICompletionsWire(wireOptions)
	}
}
