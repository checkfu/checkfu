import { projectSchemas } from "@checkfu/authoring/schemas"
import * as Schema from "effect/Schema"

export const generateApplySchemas = () =>
	Object.entries(projectSchemas).map(([kind, schema]) => {
		const { schema: body, definitions } = Schema.toJsonSchemaDocument(schema, {
			onExcessProperty: "error",
		})
		return {
			relativePath: `apps/api/public/schemas/apply/${kind}.json`,
			content: `${JSON.stringify(
				{
					$schema: "https://json-schema.org/draft/2020-12/schema",
					...body,
					...(Object.keys(definitions).length === 0 ? {} : { $defs: definitions }),
				},
				null,
				2,
			)}\n`,
		}
	})
