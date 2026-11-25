import type { Forge, Json, Method, Type } from "@cloudflare/forge"
import {
	IDEMPOTENCY_KEY_PATTERN,
	PATH_SEGMENT_PATTERN,
	importInputSchema,
} from "@checkfu/mcp/GeneratedRuntime"
import * as Schema from "effect/Schema"
import { buildSurfaceCatalog } from "./SurfaceCatalog.ts"
import type { GeneratedFile, SurfaceOperation } from "./SurfaceCatalog.ts"

type JsonRecord = Readonly<Record<string, Json>>

interface McpTool {
	readonly name: string
	readonly title: string
	readonly description: string
	readonly method: string
	readonly path: string
	readonly readOnly: boolean
	readonly idempotent: boolean
	readonly destructive: boolean
	readonly inputSchema: JsonRecord
}

const MCP_EXTENSION = "x-checkfu-mcp"
const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u
const SCHEMA_REF_PREFIX = "#/components/schemas/"
const JSON_MEDIA_TYPE = "application/json"
const IDEMPOTENCY_HEADER = "idempotency-key"
const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean"])

const isJsonRecord = (value: Json | undefined): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const parseDocument = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
)

const recordAt = (value: Json | undefined, key: string): JsonRecord | undefined => {
	if (!isJsonRecord(value)) {
		return undefined
	}
	const child = value[key]
	return isJsonRecord(child) ? child : undefined
}

const rewriteRefs = (value: Json, referenced: Set<string>): Json => {
	if (Array.isArray(value)) {
		return value.map((item: Json) => rewriteRefs(item, referenced))
	}
	if (!isJsonRecord(value)) {
		return value
	}
	const out: Record<string, Json> = {}
	for (const [key, child] of Object.entries(value)) {
		if (key === "$ref" && typeof child === "string" && child.startsWith(SCHEMA_REF_PREFIX)) {
			const name = child.slice(SCHEMA_REF_PREFIX.length)
			referenced.add(name)
			out[key] = `#/$defs/${name}`
		} else {
			out[key] = rewriteRefs(child, referenced)
		}
	}
	return out
}

const withDefinitions = (schema: JsonRecord, components: JsonRecord, label: string): JsonRecord => {
	const referenced = new Set<string>()
	const rewritten = rewriteRefs(schema, referenced)
	const definitions: Record<string, Json> = {}
	for (const name of referenced) {
		const component = components[name]
		if (component === undefined) {
			throw new Error(`${label}: unresolved schema reference ${SCHEMA_REF_PREFIX}${name}.`)
		}
		// Rewriting a definition may reference more components; the Set keeps iterating over them.
		definitions[name] = rewriteRefs(component, referenced)
	}
	if (!isJsonRecord(rewritten)) {
		throw new Error(`${label}: input schema is not an object.`)
	}
	return referenced.size === 0 ? rewritten : { ...rewritten, $defs: definitions }
}

interface Parameter {
	readonly name: string
	readonly in: string
	readonly required: boolean
	readonly schema: JsonRecord
}

const readParameters = (
	pathItem: JsonRecord,
	operation: JsonRecord,
	label: string,
): Array<Parameter> => {
	// The document is always the one Effect exports from CheckfuApi, which declares parameters
	// on the operation. Anything else is refused rather than interpreted.
	if (pathItem["parameters"] !== undefined) {
		throw new Error(`${label}: parameters declared on the path item are not supported.`)
	}
	const source = operation["parameters"] ?? []
	if (!Array.isArray(source)) {
		throw new Error(`${label}: parameters must be an array.`)
	}
	return (source as ReadonlyArray<Json>).map((raw) => {
		if (!isJsonRecord(raw) || typeof raw["name"] !== "string" || typeof raw["in"] !== "string") {
			throw new Error(`${label}: unsupported parameter ${JSON.stringify(raw)}.`)
		}
		const schema = raw["schema"]
		return {
			name: raw["name"],
			in: raw["in"],
			required: raw["required"] === true,
			schema: {
				...(isJsonRecord(schema) ? schema : {}),
				...(typeof raw["description"] === "string" ? { description: raw["description"] } : {}),
			},
		}
	})
}

const parameterObject = (parameters: ReadonlyArray<Parameter>) => ({
	type: "object",
	properties: Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter.schema])),
	required: parameters.flatMap((parameter) => (parameter.required ? [parameter.name] : [])),
	additionalProperties: false,
})

const readExposure = (
	method: Method,
	label: string,
): { readonly name: string; readonly destructive: boolean | undefined } | undefined => {
	const raw = method.extension(MCP_EXTENSION)
	if (raw === false) {
		return undefined
	}
	if (!isJsonRecord(raw) || typeof raw["name"] !== "string") {
		throw new Error(
			`${label}: declare "${MCP_EXTENSION}" as { name } to expose this operation as an MCP tool, or false to leave it out.`,
		)
	}
	if (!MCP_TOOL_NAME_PATTERN.test(raw["name"])) {
		throw new Error(`${label}: MCP tool name ${JSON.stringify(raw["name"])} is not valid.`)
	}
	return {
		name: raw["name"],
		destructive: typeof raw["destructive"] === "boolean" ? raw["destructive"] : undefined,
	}
}

const isObjectType = (type: Type): boolean => {
	switch (type.kind) {
		case "object":
			return true
		case "model":
			return isObjectType(type.model.type)
		case "union":
		case "intersection":
			return type.members.every((member) => isObjectType(member))
		default:
			return false
	}
}

const projectOperation = (
	operation: SurfaceOperation,
	paths: JsonRecord,
	components: JsonRecord,
): McpTool | undefined => {
	const { method, httpMethod } = operation
	const label = `${httpMethod} ${method.path}`
	const exposure = readExposure(method, label)
	if (exposure === undefined) {
		return undefined
	}
	// A tool result is a JSON object, so every success response has to be one.
	if (
		!method.responses.every(
			(response) =>
				response.contents.every((content) => content.isJson) &&
				response.json !== undefined &&
				isObjectType(response.json.type),
		)
	) {
		throw new Error(
			`${label}: MCP tools return a JSON object. Set "${MCP_EXTENSION}" to false for this operation.`,
		)
	}
	const pathItem = recordAt(paths, method.path)
	const rawOperation = recordAt(pathItem, httpMethod.toLowerCase())
	if (pathItem === undefined || rawOperation === undefined) {
		throw new Error(`${label}: operation is missing from the OpenAPI document.`)
	}

	const parameters = readParameters(pathItem, rawOperation, label)
	// A parameter the runtime does not forward would be dropped from the tool without a trace,
	// so every parameter has to be one of the kinds it does.
	for (const parameter of parameters) {
		const type = parameter.schema["type"]
		const forwarded =
			parameter.in === "path"
				? type === "string"
				: parameter.in === "query"
					? typeof type === "string" && SCALAR_TYPES.has(type)
					: parameter.in === "header" && parameter.name.toLowerCase() === IDEMPOTENCY_HEADER
		if (!forwarded) {
			throw new Error(
				`${label}: MCP tools cannot send the ${parameter.in} parameter ${JSON.stringify(parameter.name)}. Set "${MCP_EXTENSION}" to false for this operation.`,
			)
		}
	}
	const pathParameters = parameters.filter((parameter) => parameter.in === "path")
	const queryParameters = parameters.filter((parameter) => parameter.in === "query")
	const readOnly = httpMethod === "GET"
	const idempotencyHeader = parameters.find((parameter) => parameter.in === "header")

	const properties: Record<string, Json> = {}
	const required: Array<string> = []
	if (pathParameters.length > 0) {
		properties["path"] = parameterObject(
			pathParameters.map((parameter) => {
				const own = parameter.schema["pattern"]
				// One segment always; a parameter's own pattern too, since a schema has one `pattern`.
				return {
					...parameter,
					schema: {
						...parameter.schema,
						pattern: PATH_SEGMENT_PATTERN,
						...(own === undefined ? {} : { allOf: [{ pattern: own }] }),
					},
				}
			}),
		)
		required.push("path")
	}
	if (queryParameters.length > 0) {
		properties["query"] = parameterObject(queryParameters)
		if (queryParameters.some((parameter) => parameter.required)) {
			required.push("query")
		}
	}
	const requestBody = recordAt(rawOperation, "requestBody")
	if (requestBody !== undefined) {
		if (readOnly) {
			throw new Error(`${label}: MCP tools cannot send a request body with GET.`)
		}
		const schema = recordAt(recordAt(recordAt(requestBody, "content"), JSON_MEDIA_TYPE), "schema")
		if (schema === undefined) {
			throw new Error(`${label}: MCP tools send ${JSON_MEDIA_TYPE} request bodies.`)
		}
		properties["body"] = schema
		if (requestBody["required"] === true) {
			required.push("body")
		}
	}
	if (idempotencyHeader !== undefined) {
		properties["idempotency_key"] = {
			...idempotencyHeader.schema,
			pattern: IDEMPOTENCY_KEY_PATTERN,
			description:
				"Stable retry key of printable ASCII characters; reuse the same key and request body for every retry.",
		}
		if (idempotencyHeader.required) {
			required.push("idempotency_key")
		}
	}

	const inputSchema = withDefinitions(
		{ type: "object", properties, required, additionalProperties: false },
		components,
		label,
	)
	// The server checks every call against this schema, so it has to be one it can enforce.
	try {
		importInputSchema(inputSchema)
	} catch (error) {
		throw new Error(`${label}: the MCP server cannot enforce this operation's input schema.`, {
			cause: error,
		})
	}

	return {
		name: exposure.name,
		title: method.summary,
		description: method.description || method.summary,
		method: httpMethod,
		path: method.path,
		readOnly,
		// The same retry-safety rule the CLI and SDK are generated from. A required retry key is
		// one of the tool's arguments, so repeating the same call repeats the same key.
		idempotent: operation.retrySafety === "idempotent" || operation.requiresIdempotencyKey,
		// MCP reads "not destructive" as "only adds", so an operation has to claim that itself.
		destructive: !readOnly && exposure.destructive !== false,
		inputSchema,
	}
}

export const projectMcpTools = (forge: Forge, openApiJson: string): ReadonlyArray<McpTool> => {
	const document = parseDocument(openApiJson)
	const paths = recordAt(document, "paths") ?? {}
	const components = recordAt(recordAt(document, "components"), "schemas") ?? {}
	const tools: Array<McpTool> = []
	const names = new Set<string>()
	for (const operation of buildSurfaceCatalog(forge).operations) {
		const tool = projectOperation(operation, paths, components)
		if (tool === undefined) {
			continue
		}
		if (names.has(tool.name)) {
			throw new Error(`Duplicate MCP tool name ${JSON.stringify(tool.name)}.`)
		}
		names.add(tool.name)
		tools.push(tool)
	}
	return tools.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export const generateMcpFiles = (
	forge: Forge,
	openApiJson: string,
): ReadonlyArray<GeneratedFile> => {
	const tools = projectMcpTools(forge, openApiJson)
	const content = [
		"// Code generated by @cloudflare/forge. DO NOT EDIT.",
		"",
		'import type { GeneratedToolDescriptor } from "../GeneratedRuntime.ts"',
		"",
		`export const GENERATED_API_VERSION = ${JSON.stringify(forge.version)}`,
		"",
		`export const GENERATED_TOOLS: ReadonlyArray<GeneratedToolDescriptor> = ${JSON.stringify(tools, null, "\t")}`,
		"",
	].join("\n")
	return [{ path: "Tools.ts", content }]
}
