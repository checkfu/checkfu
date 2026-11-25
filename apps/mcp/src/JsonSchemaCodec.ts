import type * as JsonSchema from "effect/JsonSchema"
import * as Schema from "effect/Schema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"

const decodeDefinitions = Schema.decodeUnknownSync(
	Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
)

export const importInputSchema = (inputSchema: JsonSchema.JsonSchema): Schema.Codec<unknown> => {
	const { $defs, ...schema } = inputSchema
	return SchemaRepresentation.fromJsonSchemaDocument(
		{ dialect: "draft-2020-12", schema, definitions: decodeDefinitions($defs ?? {}) },
		{ patterns: "apply" },
	) as Schema.Codec<unknown>
}
