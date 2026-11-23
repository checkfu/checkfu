import * as Effect from "effect/Effect"
import * as JsonPointer from "effect/JsonPointer"
import type * as JsonSchema from "effect/JsonSchema"
import * as Schema from "effect/Schema"
import { OpenApiImportError, isJsonArray, isJsonObject, isSchemaObject } from "./OpenApiTypes.ts"
import type { OpenApiLimits } from "./OpenApiTypes.ts"
import { truncateText } from "@checkfu/domain/Session/TextBounds"

export interface OpenApiDocument {
	readonly root: Schema.JsonObject
	readonly dialect: "3.0" | "3.1"
}

const DATA_KEYS: ReadonlySet<string> = new Set(["example", "examples", "default", "enum", "const"])
const NAME_MAP_KEYS: ReadonlySet<string> = new Set([
	"properties",
	"patternProperties",
	"dependentSchemas",
	"$defs",
	"definitions",
	"headers",
])

const DATA = 1
const NAMES = 2
const SECTIONS = 4

const childFlags = (parent: number, key: string, depth: number): number => {
	if ((parent & DATA) !== 0) {
		return DATA
	}
	if ((parent & NAMES) !== 0) {
		return 0
	}
	if ((parent & SECTIONS) !== 0) {
		return NAMES
	}
	if (DATA_KEYS.has(key) || key.startsWith("x-")) {
		return DATA
	}
	if (NAME_MAP_KEYS.has(key)) {
		return NAMES
	}
	return key === "components" && depth === 0 ? SECTIONS : 0
}

/**
 * Visits every object whose keys are OpenAPI or JSON Schema keywords, without
 * recursion. Objects that only hold data (examples, defaults, enum members,
 * extensions) and maps keyed by a name (properties, components) are walked
 * for their size but not visited: a key called `$ref` there is not a
 * reference.
 */
export const walkKeywordObjects = (
	root: JsonSchema.JsonSchema,
	visit: (node: JsonSchema.JsonSchema) => void,
	bounds: { readonly maxNodes: number; readonly maxDepth: number } = {
		maxNodes: Infinity,
		maxDepth: Infinity,
	},
): "ok" | "too_large" | "too_deep" => {
	const values: Array<JsonSchema.JsonSchema | ReadonlyArray<unknown>> = [root]
	const depths: Array<number> = [0]
	const flags: Array<number> = [0]
	let nodes = 0
	for (let value = values.pop(); value !== undefined; value = values.pop()) {
		const depth = depths.pop() ?? 0
		const flag = flags.pop() ?? 0
		nodes += 1
		if (depth > bounds.maxDepth) {
			return "too_deep"
		}
		const array = Array.isArray(value)
		if (!array && flag === 0 && isSchemaObject(value)) {
			visit(value)
		}
		for (const [key, child] of Object.entries(value)) {
			if (Array.isArray(child) || isSchemaObject(child)) {
				values.push(child)
				depths.push(depth + 1)
				flags.push(array ? flag & DATA : childFlags(flag, key, depth))
			} else {
				nodes += 1
			}
		}
		if (nodes > bounds.maxNodes) {
			return "too_large"
		}
	}
	return "ok"
}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

const parse = (
	input: string | Schema.JsonObject,
	limits: OpenApiLimits,
): Effect.Effect<Schema.Json, OpenApiImportError> => {
	if (typeof input !== "string") {
		return Effect.succeed(input)
	}
	if (input.length > limits.maxDocumentLength) {
		return Effect.fail(
			new OpenApiImportError({
				reason: "too_large",
				message: `The document is longer than ${limits.maxDocumentLength} characters.`,
			}),
		)
	}
	return Effect.try({
		try: () => decodeJson(input),
		catch: () =>
			new OpenApiImportError({ reason: "not_json", message: "The document is not valid JSON." }),
	})
}

export const loadDocument = (
	input: string | Schema.JsonObject,
	limits: OpenApiLimits,
): Effect.Effect<OpenApiDocument, OpenApiImportError> =>
	Effect.gen(function* () {
		const root = yield* parse(input, limits)
		if (!isJsonObject(root)) {
			return yield* new OpenApiImportError({
				reason: "invalid_document",
				message: "The document is not a JSON object.",
			})
		}
		const version = root["openapi"]
		const dialect =
			typeof version !== "string"
				? undefined
				: /^3\.0\.\d+/.test(version)
					? ("3.0" as const)
					: /^3\.1\.\d+/.test(version)
						? ("3.1" as const)
						: undefined
		if (dialect === undefined) {
			return yield* new OpenApiImportError({
				reason: "unsupported_version",
				message:
					root["swagger"] === undefined
						? "Only OpenAPI 3.0 and 3.1 documents are supported."
						: "Swagger 2.0 is not supported. Convert the document to OpenAPI 3.0 or 3.1.",
			})
		}
		let remote: string | undefined
		const walked = walkKeywordObjects(
			root,
			(node) => {
				const ref = node["$ref"]
				if (typeof ref === "string" && !ref.startsWith("#")) {
					remote ??= ref
				}
			},
			limits,
		)
		if (walked !== "ok") {
			return yield* new OpenApiImportError({
				reason: walked,
				message:
					walked === "too_deep"
						? `The document nests deeper than ${limits.maxDepth} levels.`
						: `The document holds more than ${limits.maxNodes} values.`,
			})
		}
		if (remote !== undefined) {
			return yield* new OpenApiImportError({
				reason: "remote_reference",
				message: `References to other documents are not followed: ${truncateText(remote, 200)}`,
			})
		}
		return { root, dialect }
	})

export const resolvePointer = (root: Schema.JsonObject, ref: string): Schema.Json | undefined => {
	const tokens = JsonPointer.parseUriFragment(ref)
	if (tokens === undefined) {
		return undefined
	}
	let current: Schema.Json | undefined = root
	for (const token of tokens) {
		if (isJsonArray(current) && /^\d+$/.test(token)) {
			current = current[Number(token)]
		} else if (isJsonObject(current) && Object.hasOwn(current, token)) {
			current = current[token]
		} else {
			return undefined
		}
	}
	return current
}

const MAX_REFERENCE_HOPS = 8

/** Follows a parameter, request body, response or path item reference to its object. */
export const dereference = (
	root: Schema.JsonObject,
	value: Schema.Json | undefined,
): Schema.JsonObject | undefined => {
	let current = value
	for (let hops = 0; hops <= MAX_REFERENCE_HOPS; hops += 1) {
		if (!isJsonObject(current)) {
			return undefined
		}
		const ref = current["$ref"]
		if (typeof ref !== "string") {
			return current
		}
		current = resolvePointer(root, ref)
	}
	return undefined
}
