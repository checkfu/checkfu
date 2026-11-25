import { toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations"
import type * as Schema from "effect/Schema"
import { schemaFault } from "./PiSchemaFault.ts"

export const customToolFaults = (
	tools: ReadonlyArray<{ readonly name: string; readonly input_schema: Schema.JsonObject }>,
	taken: ReadonlyArray<string>,
): ReadonlyArray<string | null> => {
	const spelled = new Map(taken.map((name) => [toCodemodeIdentifier(name), name]))
	return tools.map((tool) => {
		const script = toCodemodeIdentifier(tool.name)
		const other = spelled.get(script)
		if (other !== undefined) {
			return `a script would call it "${script}", which is what it calls "${other}"`
		}
		if (script.startsWith("mcp__")) {
			return `a script would call it "${script}", and names beginning "mcp__" are MCP tools'`
		}
		spelled.set(script, tool.name)
		const fault = schemaFault(tool.input_schema)
		return fault === null ? null : `its input_schema is not usable: ${fault}`
	})
}
