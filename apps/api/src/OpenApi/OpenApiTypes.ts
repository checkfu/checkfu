import type * as JsonSchema from "effect/JsonSchema"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

export const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch"] as const
export const HttpMethod = Schema.Literals(HTTP_METHODS)
export type HttpMethod = typeof HttpMethod.Type

// Only the method can vouch for a read: a description or extension is a claim.
export const READ_ONLY_METHODS: ReadonlySet<HttpMethod> = new Set(["get", "head", "options"])

export const MAX_TOOL_NAME_LENGTH = 64
export const ToolName = Schema.String.check(
	Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
	Schema.isMaxLength(MAX_TOOL_NAME_LENGTH),
)

export const JsonSchemaObject = Schema.Record(Schema.String, Schema.Unknown)
export type JsonSchemaObject = typeof JsonSchemaObject.Type

export const ParameterStyle = Schema.Literals([
	"simple",
	"form",
	"spaceDelimited",
	"pipeDelimited",
	"deepObject",
	"json",
])
export type ParameterStyle = typeof ParameterStyle.Type

export const ParameterSpec = Schema.Struct({
	name: Schema.String,
	in: Schema.Literals(["path", "query", "header"]),
	required: Schema.Boolean,
	style: ParameterStyle,
	explode: Schema.Boolean,
})
export type ParameterSpec = typeof ParameterSpec.Type

export const OperationSummary = Schema.Struct({
	name: ToolName,
	description: Schema.String,
	method: HttpMethod,
	pathTemplate: Schema.String,
	readOnly: Schema.Boolean,
	tags: Schema.Array(Schema.String),
})
export type OperationSummary = typeof OperationSummary.Type

export const ToolDescriptor = Schema.Struct({
	name: ToolName,
	description: Schema.String,
	inputSchema: JsonSchemaObject,
	outputSchema: Schema.optionalKey(JsonSchemaObject),
	method: HttpMethod,
	pathTemplate: Schema.String,
	readOnly: Schema.Boolean,
	parameters: Schema.Array(ParameterSpec),
	body: Schema.optionalKey(
		Schema.Struct({
			contentType: Schema.String,
			required: Schema.Boolean,
		}),
	),
})
export type ToolDescriptor = typeof ToolDescriptor.Type

export const HttpRequestDescription = Schema.Struct({
	method: Schema.String,
	url: Schema.String,
	headers: Schema.Record(Schema.String, Schema.String),
	body: Schema.optionalKey(Schema.String),
})
export type HttpRequestDescription = typeof HttpRequestDescription.Type

export const SecurityScheme = Schema.Struct({
	id: Schema.String,
	type: Schema.String,
	in: Schema.optionalKey(Schema.Literals(["header", "query", "cookie"])),
	name: Schema.optionalKey(Schema.String),
	scheme: Schema.optionalKey(Schema.String),
})
export type SecurityScheme = typeof SecurityScheme.Type

export const SkippedOperation = Schema.Struct({
	method: Schema.String,
	path: Schema.String,
	reason: Schema.String,
})
export type SkippedOperation = typeof SkippedOperation.Type

export class OpenApiImportError extends Schema.TaggedError<
	OpenApiImportError,
	{ readonly brand: unique symbol }
>()("OpenApiImportError", {
	reason: Schema.Literals([
		"not_json",
		"too_large",
		"too_deep",
		"unsupported_version",
		"remote_reference",
		"invalid_document",
		"too_many_operations",
	]),
	message: Schema.String,
	pointer: Schema.optionalKey(Schema.String),
}) {}

export class OpenApiRequestError extends Schema.TaggedError<
	OpenApiRequestError,
	{ readonly brand: unique symbol }
>()("OpenApiRequestError", {
	reason: Schema.Literals([
		"invalid_arguments",
		"missing_argument",
		"unsupported_value",
		"unsafe_path",
		"invalid_base_url",
	]),
	message: Schema.String,
	parameter: Schema.optionalKey(Schema.String),
}) {}

export interface OpenApiLimits {
	readonly maxDocumentLength: number
	readonly maxNodes: number
	readonly maxDepth: number
	readonly maxOperations: number
	readonly maxDescriptionLength: number
	readonly maxSchemaDescriptionLength: number
	readonly maxDefinitionsPerTool: number
}

export const DEFAULT_OPENAPI_LIMITS: OpenApiLimits = {
	maxDocumentLength: 16 * 1024 * 1024,
	maxNodes: 4_000_000,
	maxDepth: 128,
	maxOperations: 10_000,
	maxDescriptionLength: 1024,
	maxSchemaDescriptionLength: 512,
	maxDefinitionsPerTool: 64,
}

export const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value)

export const isJsonArray = (value: Schema.Json | undefined): value is Schema.JsonArray =>
	Array.isArray(value)

export const isSchemaObject = (value: unknown): value is JsonSchema.JsonSchema =>
	Predicate.isObject(value)

export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

// A caller can never set these: the connection attaches credentials after the request is built.
export const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
])

// Set by the HTTP client or by the request body, never by a parameter.
export const TRANSPORT_HEADERS: ReadonlySet<string> = new Set([
	"host",
	"content-length",
	"content-type",
	"transfer-encoding",
	"connection",
	"accept",
])
