import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"

export interface CustomToolsUncheckable {
	readonly _tag: "CustomToolsUncheckable"
}

export const CustomToolFaults = Context.Reference<
	(
		tools: ReadonlyArray<{ readonly name: string; readonly input_schema: Schema.JsonObject }>,
		taken: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyArray<string | null>, CustomToolsUncheckable>
>("@checkfu/api/CustomToolFaults", {
	defaultValue: () => () => Effect.fail({ _tag: "CustomToolsUncheckable" }),
})
