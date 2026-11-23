import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpMethod from "effect/http/HttpMethod"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import type * as JsonSchema from "effect/JsonSchema"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"

export interface GeneratedToolDescriptor {
	readonly name: string
	readonly title: string
	readonly description: string
	readonly method: HttpMethod.HttpMethod
	readonly path: string
	readonly readOnly: boolean
	readonly destructive: boolean
	readonly inputSchema: JsonSchema.JsonSchema
}

export class CheckfuApiClient extends Context.Service<CheckfuApiClient, HttpClient.HttpClient>()(
	"@checkfu/mcp/CheckfuApiClient",
) {}

// The API as the current request reaches it: on Cloudflare, the Worker's service binding.
export class ApiBinding extends Context.Service<
	ApiBinding,
	{ readonly fetch: typeof globalThis.fetch }
>()("@checkfu/mcp/ApiBinding") {}

export const CREDENTIAL_HEADERS = ["authorization", "x-api-key"] as const

// A scheme with no token, as an unset variable in "Bearer $KEY" produces, is no credential.
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

// Every key the API accepts that an HTTP header carries unchanged from any client: printable
// ASCII and tab, with no outer whitespace. Headers trim outer whitespace, servers refuse other
// control characters, and a non-ASCII character arrives as different bytes from different clients.
export const IDEMPOTENCY_KEY_PATTERN = String.raw`^[!-~](?:[\t -~]*[!-~])?$`

// A value that is one URL path segment: "/" and "\" would add segments and "." and ".." are
// resolved away, so none of them can name a resource.
export const PATH_SEGMENT_PATTERN = String.raw`^(?!\.{1,2}$)[^/\\]+$`

const decodeDefinitions = Schema.decodeUnknownSync(
	Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
)

// The schema a tool publishes is the schema its calls are checked against, so the two cannot
// drift. Throws when the schema uses a JSON Schema feature that cannot be enforced.
export const importInputSchema = (inputSchema: JsonSchema.JsonSchema) => {
	const { $defs, ...schema } = inputSchema
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a schema imported from JSON Schema decodes JSON values and needs no services
	return SchemaRepresentation.fromJsonSchemaDocument(
		{ dialect: "draft-2020-12", schema, definitions: decodeDefinitions($defs ?? {}) },
		{ patterns: "apply" },
	) as Schema.Codec<unknown>
}

// A string with an unpaired surrogate cannot be URL-encoded: the path encoder throws on it and
// the query encoder silently replaces it.
const WellFormedString = Schema.String.check(
	Schema.makeFilter((value) => (value.isWellFormed() ? undefined : "Expected well-formed Unicode")),
)

// Applied after the published schema: the parts this adapter places into the request itself.
// Well-formedness is the one rule a JSON Schema pattern cannot state.
const Envelope = Schema.Struct({
	path: Schema.optionalKey(Schema.Record(Schema.String, WellFormedString)),
	query: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Union([WellFormedString, Schema.Finite, Schema.Boolean])),
	),
	body: Schema.optionalKey(Schema.Unknown),
	idempotency_key: Schema.optionalKey(Schema.String),
})

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

// Anything but a JSON object from the API: no connection, a body that could not be read, or one
// that is not the API's. For a write, none of these says whether the write happened.
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
	return (input: unknown): Effect.Effect<Schema.JsonObject, Schema.Json> =>
		Effect.gen(function* () {
			const args = yield* decodePublished(input, { onExcessProperty: "error" }).pipe(
				Effect.flatMap((published) => decodeEnvelope(published)),
				Effect.mapError((error) => toolError("invalid_request_error", error.message)),
			)
			const path = Object.entries(args.path ?? {}).reduce(
				(resolved, [name, value]) => resolved.replace(`{${name}}`, () => encodeURIComponent(value)),
				tool.path,
			)
			const request = HttpClientRequest.make(tool.method)(path).pipe(
				HttpClientRequest.setUrlParams(
					Object.entries(args.query ?? {}).map(([name, value]) => [name, String(value)] as const),
				),
				HttpClientRequest.setHeaders(yield* callerCredentials),
				args.idempotency_key === undefined
					? (self) => self
					: HttpClientRequest.setHeader("idempotency-key", args.idempotency_key),
				args.body === undefined ? (self) => self : HttpClientRequest.bodyJsonUnsafe(args.body),
			)
			const response = yield* Effect.mapError(client.execute(request), () => noUsableReply(tool))
			const body = yield* response.text.pipe(
				Effect.map((text) => Option.getOrUndefined(decodeJsonObject(text))),
				Effect.orElseSucceed(() => undefined),
			)
			if (body !== undefined && response.status >= 200 && response.status < 300) {
				return body
			}
			return yield* Effect.fail(isApiError(body) ? body : noUsableReply(tool))
		})
}
