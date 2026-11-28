import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import type * as HttpMethod from "effect/http/HttpMethod"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import type * as JsonSchema from "effect/JsonSchema"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { importInputSchema } from "./JsonSchemaCodec.ts"

export { importInputSchema }

export interface GeneratedToolDescriptor {
	readonly name: string
	readonly title: string
	readonly description: string
	readonly method: HttpMethod.HttpMethod
	readonly path: string
	readonly readOnly: boolean
	readonly idempotent: boolean
	readonly destructive: boolean
	readonly inputSchema: JsonSchema.JsonSchema
}

export class CheckfuApiClient extends Context.Service<CheckfuApiClient, HttpClient.HttpClient>()(
	"@checkfu/mcp/CheckfuApiClient",
) {}

export class ApiBinding extends Context.Service<
	ApiBinding,
	{ readonly fetch: typeof globalThis.fetch }
>()("@checkfu/mcp/ApiBinding") {}

export const CREDENTIAL_HEADERS = ["authorization", "x-api-key"] as const

export const hasCredential = (headers: Readonly<Record<string, string | undefined>>): boolean =>
	(headers["x-api-key"] ?? "").length > 0 ||
	!/^(?:bearer)?\s*$/iu.test(headers["authorization"] ?? "")

export const credentialHeaders = (
	headers: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
	Object.fromEntries(
		CREDENTIAL_HEADERS.flatMap((name) => {
			const value = headers[name]
			return value === undefined ? [] : [[name, value]]
		}),
	)

export const IDEMPOTENCY_KEY_PATTERN = String.raw`^[!-~](?:[\t -~]*[!-~])?$`

export const PATH_SEGMENT_PATTERN = String.raw`^(?:[^/\\.][^/\\]*|\.[^/\\.][^/\\]*|\.\.[^/\\]+)$`

const WellFormedString = Schema.String.check(
	Schema.makeFilter((value) => (value.isWellFormed() ? undefined : "Expected well-formed Unicode")),
)

const QueryValue = Schema.Union([WellFormedString, Schema.Finite, Schema.Boolean])

const Envelope = Schema.Struct({
	path: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Union([WellFormedString, Schema.Int])),
	),
	query: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Union([QueryValue, Schema.Array(QueryValue)])),
	),
	body: Schema.optionalKey(Schema.Unknown),
	idempotency_key: Schema.optionalKey(Schema.String),
})

const MAX_TOOL_RESULT_CHARACTERS = 200_000
const DECODE_SLICE_BYTES = 16_384
const oversizedToolResult = Symbol("oversized tool result")
const unreadableToolResult = Symbol("unreadable tool result")

const readToolBody = Effect.fn(function* (response: HttpClientResponse.HttpClientResponse) {
	const reader = yield* Effect.acquireRelease(
		Effect.try({
			try: () => Option.getOrUndefined(HttpClientResponse.toWeb(response))?.body?.getReader(),
			catch: () => unreadableToolResult,
		}),
		(reader) =>
			reader === undefined
				? Effect.void
				: Effect.sync(() => {
						void reader.cancel().catch(() => undefined)
						reader.releaseLock()
					}),
	)
	if (reader === undefined) {
		return undefined
	}
	const read = Effect.tryPromise({ try: () => reader.read(), catch: () => unreadableToolResult })
	const decoder = new TextDecoder()
	let text = ""
	const append = (decoded: string) => {
		if (text.length + decoded.length > MAX_TOOL_RESULT_CHARACTERS) {
			return false
		}
		text += decoded
		return true
	}
	for (;;) {
		const next = yield* read
		if (next.done) {
			break
		}
		const chunk = next.value
		for (let offset = 0; offset < chunk.length; offset += DECODE_SLICE_BYTES) {
			const slice = chunk.subarray(offset, offset + DECODE_SLICE_BYTES)
			if (!append(decoder.decode(slice, { stream: true }))) {
				return yield* Effect.fail(oversizedToolResult)
			}
		}
	}
	return append(decoder.decode()) ? text : yield* Effect.fail(oversizedToolResult)
})

const hasLimitQuery = Schema.is(
	Schema.Struct({
		properties: Schema.Struct({
			query: Schema.Struct({
				properties: Schema.Struct({ limit: Schema.Record(Schema.String, Schema.Unknown) }),
			}),
		}),
	}),
)

const decodeEnvelope = Schema.decodeUnknownEffect(Envelope)

const decodeJsonObject = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
)

const isApiError = Schema.is(
	Schema.Struct({
		type: Schema.Literal("error"),
		error: Schema.Struct({ type: Schema.String, message: Schema.String }),
	}),
)

const toolError = (type: string, message: string) => ({
	type: "error" as const,
	error: { type, message },
})

const noUsableReply = (tool: GeneratedToolDescriptor) =>
	toolError(
		"service_unavailable",
		tool.readOnly
			? "The Checkfu API did not return a usable response. Retrying is safe."
			: "The Checkfu API did not return a usable response, so whether this call took effect is unknown. Check the resource before retrying.",
	)

const callerCredentials = Effect.map(
	Effect.serviceOption(HttpServerRequest.HttpServerRequest),
	Option.match({ onNone: () => ({}), onSome: (request) => credentialHeaders(request.headers) }),
)

export const makeToolHandler = (client: HttpClient.HttpClient, tool: GeneratedToolDescriptor) => {
	const decodePublished = Schema.decodeUnknownEffect(importInputSchema(tool.inputSchema))
	const sizeHint = !tool.readOnly
		? "The API accepted the request. Read the resource to confirm the result before retrying."
		: hasLimitQuery(tool.inputSchema)
			? "Call again with a smaller limit."
			: "Use a narrower request."
	return (input: unknown): Effect.Effect<Schema.JsonObject, Schema.Json> =>
		Effect.gen(function* () {
			const args = yield* decodePublished(input, { onExcessProperty: "error" }).pipe(
				Effect.flatMap((published) => decodeEnvelope(published)),
				Effect.mapError((error) => toolError("invalid_request_error", error.message)),
			)
			const path = Object.entries(args.path ?? {}).reduce(
				(resolved, [name, value]) =>
					resolved.replace(`{${name}}`, () => encodeURIComponent(String(value))),
				tool.path,
			)
			const request = HttpClientRequest.make(tool.method)(path).pipe(
				HttpClientRequest.setUrlParams(
					Object.entries(args.query ?? {}).flatMap(([name, value]) =>
						(Array.isArray(value) ? value : [value]).map((item) => [name, String(item)] as const),
					),
				),
				HttpClientRequest.setHeaders(yield* callerCredentials),
				args.idempotency_key === undefined
					? (self) => self
					: HttpClientRequest.setHeader("idempotency-key", args.idempotency_key),
				args.body === undefined ? (self) => self : HttpClientRequest.bodyJsonUnsafe(args.body),
			)
			const response = yield* Effect.mapError(client.execute(request), () => noUsableReply(tool))
			const text = yield* readToolBody(response).pipe(
				Effect.scoped,
				Effect.catch((error) => Effect.succeed(error === oversizedToolResult ? error : undefined)),
			)
			const successful = response.status >= 200 && response.status < 300
			if (text === oversizedToolResult) {
				return yield* Effect.fail(
					successful
						? toolError(
								tool.readOnly ? "invalid_request_error" : "response_too_large",
								`The result exceeds the ${MAX_TOOL_RESULT_CHARACTERS}-character limit for tool results. ${sizeHint}`,
							)
						: noUsableReply(tool),
				)
			}
			const body = text === undefined ? undefined : Option.getOrUndefined(decodeJsonObject(text))
			if (successful && body !== undefined) {
				return body
			}
			return yield* Effect.fail(isApiError(body) ? body : noUsableReply(tool))
		})
}
