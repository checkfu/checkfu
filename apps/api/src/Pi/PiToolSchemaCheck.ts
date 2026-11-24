import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"

/**
 * The first `$ref` in a schema that points outside it. Pi resolves only references within the
 * schema, so such a schema is refused rather than offered with the reference left unchecked.
 */
const isJsonArray = (value: Schema.Json): value is ReadonlyArray<Schema.Json> =>
	Array.isArray(value)

export const externalReference = (schema: Schema.Json): string | undefined => {
	if (isJsonArray(schema)) {
		for (const item of schema) {
			const found = externalReference(item)
			if (found !== undefined) {
				return found
			}
		}
		return undefined
	}
	if (schema === null || typeof schema !== "object") {
		return undefined
	}
	for (const [key, value] of Object.entries(schema)) {
		if (key === "$ref" && typeof value === "string" && !value.startsWith("#")) {
			return value
		}
		const found = externalReference(value)
		if (found !== undefined) {
			return found
		}
	}
	return undefined
}

export interface ToolSchemaCheckService {
	readonly checkable: (
		schemas: ReadonlyArray<Schema.JsonObject>,
	) => Effect.Effect<ReadonlyArray<boolean>>
}

/**
 * Whether Pi can check a call's arguments against each schema, as it does before every call. Pi
 * runs in the harness Worker, so the API Worker asks it there rather than loading Pi itself. A
 * setup that provides no check refuses every custom tool instead of accepting it unchecked.
 */
export const ToolSchemaCheck = Context.Reference<ToolSchemaCheckService>(
	"@checkfu/api/ToolSchemaCheck",
	{
		defaultValue: () => ({
			checkable: () => Effect.die(new Error("No tool schema check is provided.")),
		}),
	},
)
