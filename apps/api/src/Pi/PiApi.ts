import type { ApiServerBinding } from "@checkfu/domain/Mcp/ApiServers"
import { evaluateMcpPermission } from "@checkfu/domain/Mcp/McpServers"
import { isJsonValue } from "@earendil-works/chord/json"
import { utf8ByteLength } from "@earendil-works/chord/output"
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable"
import { compile } from "@earendil-works/pi-schema"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { MAX_API_RESPONSE_BYTES } from "../Connection/ApiUpstream.ts"
import type { ApiCallOutcome } from "../Connection/ApiUpstream.ts"
import type { McpToolDescriptor } from "../Connection/McpUpstream.ts"
import type { GatedTool } from "./PiApprovals.ts"
import { INTERRUPTED, MODEL_TOOL_NAME, withoutRemoteReferencesIn } from "./PiMcp.ts"
import type { McpCall, McpCallResult } from "./PiMcpStore.ts"
import {
	MODEL_TEXT_LIMITS,
	boundModelText,
	fitsModelText,
	jsonNote,
	looksLikeJson,
} from "./PiToolText.ts"

export const API_EXTENSION_PREFIX = "checkfu.api."

export const apiToolName = (server: string, operation: string): string =>
	`api__${server}__${operation}`

const isJsonObject = Schema.is(Schema.JsonObject)

export interface ApiServerTools {
	readonly binding: ApiServerBinding
	/** The operations the server's document gives; null while its catalog has not been reached. */
	readonly tools: ReadonlyArray<McpToolDescriptor> | null
}

/** What a call comes to: the API's answer, or why no request reached it. */
export type ApiToolOutcome = ApiCallOutcome | { readonly ok: false; readonly message: string }

export interface ApiCalls {
	readonly call: (
		binding: ApiServerBinding,
		operation: string,
		args: Schema.JsonObject,
	) => Promise<ApiToolOutcome>
	readonly began: (call: McpCall) => void
	readonly ended: (callId: string, result: McpCallResult) => void
}

/**
 * Which of the servers' operations run on their own and which ask a person
 * first, by the name the model calls them. With no policy from the agent's
 * author, an operation whose HTTP method only reads runs and every other asks.
 */
export const apiToolPermissions = (
	servers: ReadonlyArray<ApiServerTools>,
): Map<string, GatedTool> =>
	new Map(
		servers.flatMap(({ binding, tools }) =>
			(tools ?? []).map((tool): [string, GatedTool] => [
				apiToolName(binding.name, tool.name),
				{
					source: "api",
					server: binding.name,
					tool: tool.name,
					ask:
						evaluateMcpPermission(binding.permissions, tool.name, tool.readOnly === true) === "ask",
				},
			]),
		),
	)

const RESULT_FIELDS = {
	status: { type: "integer", description: "The HTTP status of the response" },
	text: {
		type: "string",
		description: "The response body as text, when it is not JSON of the documented shape",
	},
} as const

/**
 * What a script gets from an API tool: the status, and the body parsed when
 * it is JSON of the shape the document promises. An API that answers
 * otherwise still answers, so `body` is never required: a call that reached
 * the API is not turned into a failure by its document being wrong.
 */
export const apiResultSchema = (outputSchema: Schema.JsonObject | undefined): Schema.JsonObject => {
	const open: Schema.JsonObject = {
		type: "object",
		properties: { ...RESULT_FIELDS, body: { description: "The response body, parsed from JSON" } },
		required: ["status"],
	}
	if (outputSchema === undefined) {
		return open
	}
	const { $defs: definitions, ...body } = withoutRemoteReferencesIn(outputSchema)
	const typed: Schema.JsonObject = {
		type: "object",
		properties: { ...RESULT_FIELDS, body },
		required: ["status"],
		...(definitions === undefined ? {} : { $defs: definitions }),
	}
	try {
		compile(typed)
		return typed
	} catch {
		return open
	}
}

const CUT_NOTE = "\n[The response was longer and has been cut.]"

const isJsonResponse = (outcome: Extract<ApiCallOutcome, { readonly ok: true }>): boolean =>
	/\bjson\b/iu.test(outcome.contentType ?? "") || looksLikeJson(outcome.body)

/**
 * What the model reads of a response, within what Pi keeps of a result, so Pi never cuts it:
 * a JSON body that does not fit, or that was cut when it was read, is left out with a note
 * asking for less; other text keeps its first lines.
 */
const modelText = (outcome: Extract<ApiCallOutcome, { readonly ok: true }>, failed: boolean) => {
	const status = `HTTP ${outcome.status}`
	if (outcome.body === "") {
		return failed ? status : `${status} with no body`
	}
	const json = isJsonResponse(outcome)
	const head = failed ? `${status}\n` : ""
	const whole = `${head}${outcome.body}${outcome.truncated && !json ? CUT_NOTE : ""}`
	if (!json) {
		return boundModelText(whole, "The response", false)
	}
	if (!outcome.truncated && fitsModelText(whole)) {
		return whole
	}
	const size = outcome.truncated
		? `more than the ${MAX_API_RESPONSE_BYTES} bytes read from it`
		: `${utf8ByteLength(outcome.body)} bytes`
	return `${status}\n${jsonNote("The response", size)}`
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const parsed = (outcome: Extract<ApiCallOutcome, { readonly ok: true }>): Schema.Json | undefined =>
	outcome.truncated || outcome.body === ""
		? undefined
		: Option.getOrUndefined(decodeJson(outcome.body))

/**
 * One API server's operations as a Pi extension. Scripts find and call them
 * by namespace; the model is offered one only after tool search loads it, and
 * never one whose name a provider would refuse.
 */
export const apiExtension = ({ binding, tools }: ApiServerTools, calls: ApiCalls): Extension => {
	const { host } = new URL(binding.base_url)
	const registrations = (tools ?? []).map((tool): ToolRegistration => {
		const name = apiToolName(binding.name, tool.name)
		const resultSchema = apiResultSchema(tool.outputSchema)
		let check: ((value: unknown) => boolean) | undefined
		return {
			name,
			description: tool.description,
			parameters: withoutRemoteReferencesIn(tool.inputSchema),
			structuredOutputSchema: resultSchema,
			deferred: true,
			outputLimits: MODEL_TEXT_LIMITS,
			...(MODEL_TOOL_NAME.test(name) ? {} : { callers: ["tools"] as const }),
			execute: async (args, api, context) => {
				// An interrupted turn sends nothing more to the API.
				if (context.abortSignal?.aborted === true) {
					return INTERRUPTED
				}
				const input = isJsonObject(args) ? args : {}
				// A call that had to ask is already in the ledger, marked so; this leaves it as it is.
				calls.began({
					call_id: api.callId,
					source: "api",
					server: binding.name,
					tool: tool.name,
					input,
					permission: "allow",
				})
				const outcome = await calls
					.call(binding, tool.name, input)
					.catch((): ApiToolOutcome => ({ ok: false, message: "The API could not be reached." }))
				if (!outcome.ok) {
					const content = [{ type: "text" as const, text: outcome.message }]
					calls.ended(api.callId, { content, is_error: true })
					return { output: content, isError: true }
				}
				const failed = outcome.status < 200 || outcome.status >= 300
				const body = `${outcome.body}${outcome.truncated ? CUT_NOTE : ""}`
				const text = modelText(outcome, failed)
				const content = [{ type: "text" as const, text }]
				calls.ended(api.callId, { content, is_error: failed })
				check ??= compile(resultSchema).check
				const value = parsed(outcome)
				const typed = { status: outcome.status, body: value }
				return {
					output: content,
					isError: failed,
					structuredOutput:
						value !== undefined && isJsonValue(typed) && check(typed)
							? typed
							: { status: outcome.status, ...(outcome.body === "" ? {} : { text: body }) },
				}
			},
		}
	})
	return {
		name: `${API_EXTENSION_PREFIX}${binding.name}`,
		namespace: {
			name: binding.name,
			description:
				tools === null
					? `HTTP API at ${host}. Its description could not be read, so its tools are not available yet.`
					: `HTTP API at ${host}.`,
		},
		tools: registrations,
	}
}

const SUPERSEDED: ApiToolOutcome = {
	ok: false,
	message: "This turn is no longer the session's current one, so the request was not sent.",
}

/** As `fencedMcpCall`: a superseded turn's call is answered here and never reaches the API. */
export const fencedApiCall =
	(admitted: () => Promise<boolean>, call: ApiCalls["call"]): ApiCalls["call"] =>
	async (binding, operation, args) =>
		(await admitted()) ? call(binding, operation, args) : SUPERSEDED
