import * as JsonPointer from "effect/JsonPointer"
import * as JsonSchema from "effect/JsonSchema"
import type * as Schema from "effect/Schema"
import { walkKeywordObjects } from "./OpenApiDocument.ts"
import type { OpenApiDocument } from "./OpenApiDocument.ts"
import { isJsonObject, isSchemaObject } from "./OpenApiTypes.ts"
import type { OpenApiLimits } from "./OpenApiTypes.ts"
import { truncateText } from "@checkfu/domain/Session/TextBounds"

export interface ConvertedSchema {
	readonly schema: JsonSchema.JsonSchema
	readonly references: ReadonlyArray<string>
	readonly local: ReadonlyArray<readonly [string, ConvertedSchema]>
}

export interface SchemaBundler {
	/** A schema from the document as Draft 2020-12, with component references pointing at `#/$defs`. */
	readonly convert: (raw: Schema.Json | undefined) => ConvertedSchema
	/** The definitions the given schemas reach, nearest first, shared between callers and never copied. */
	readonly definitions: (
		roots: ReadonlyArray<ConvertedSchema>,
	) => JsonSchema.Definitions | undefined
}

export const truncate = (text: string, max: number): string =>
	text.length <= max ? text : `${truncateText(text, Math.max(0, max - 1))}…`

const definitionName = (ref: string): string | undefined => {
	const tokens = JsonPointer.parseUriFragment(ref)
	return tokens?.[0] === "$defs" ? tokens[1] : undefined
}

const plain = (schema: JsonSchema.JsonSchema): ConvertedSchema => ({
	schema,
	references: [],
	local: [],
})

export const makeSchemaBundler = (
	document: OpenApiDocument,
	limits: OpenApiLimits,
): SchemaBundler => {
	const components = document.root["components"]
	const schemas =
		isJsonObject(components) && isJsonObject(components["schemas"]) ? components["schemas"] : {}
	const converted = new Map<string, ConvertedSchema | undefined>()

	const finish = (schema: JsonSchema.JsonSchema): Array<string> => {
		const references = new Set<string>()
		walkKeywordObjects(schema, (node) => {
			const ref = node["$ref"]
			if (typeof ref === "string") {
				const name = definitionName(ref)
				if (name === undefined) {
					Reflect.deleteProperty(node, "$ref")
					node["description"] = "A reference that could not be resolved was left out."
				} else {
					references.add(name)
				}
			}
			const description = node["description"]
			if (typeof description === "string") {
				node["description"] = truncate(description, limits.maxSchemaDescriptionLength)
			}
		})
		return [...references]
	}

	const convert = (raw: Schema.Json | undefined): ConvertedSchema => {
		if (raw === false) {
			return plain({ not: {} })
		}
		if (!isJsonObject(raw)) {
			return plain({})
		}
		let parsed: JsonSchema.Document<"draft-2020-12">
		try {
			parsed =
				document.dialect === "3.0"
					? JsonSchema.fromSchemaOpenApi3_0(raw)
					: JsonSchema.fromSchemaOpenApi3_1(raw)
		} catch {
			return plain({ description: "This schema could not be read." })
		}
		return {
			schema: parsed.schema,
			references: finish(parsed.schema),
			local: Object.entries(parsed.definitions).map(([name, definition]) => {
				const schema = isSchemaObject(definition) ? definition : {}
				return [name, { schema, references: finish(schema), local: [] }] as const
			}),
		}
	}

	const component = (name: string): ConvertedSchema | undefined => {
		if (!converted.has(name)) {
			converted.set(name, Object.hasOwn(schemas, name) ? convert(schemas[name]) : undefined)
		}
		return converted.get(name)
	}

	return {
		convert,
		definitions: (roots) => {
			const definitions = new Map<string, JsonSchema.JsonSchema>()
			const local = new Map<string, ConvertedSchema>()
			const queue: Array<string> = []
			const reach = (schema: ConvertedSchema) => {
				for (const [name, definition] of schema.local) {
					if (!local.has(name)) {
						local.set(name, definition)
					}
				}
				queue.push(...schema.references)
			}
			roots.forEach(reach)
			for (let next = 0; next < queue.length; next += 1) {
				const name = queue[next]
				if (name === undefined || definitions.has(name)) {
					continue
				}
				if (definitions.size >= limits.maxDefinitionsPerTool) {
					definitions.set(name, { description: "Left out: this tool reaches too many schemas." })
					continue
				}
				const definition = component(name) ?? local.get(name)
				if (definition === undefined) {
					definitions.set(name, { description: "This schema is not defined in the document." })
					continue
				}
				definitions.set(name, definition.schema)
				reach(definition)
			}
			return definitions.size === 0 ? undefined : Object.fromEntries(definitions)
		},
	}
}
