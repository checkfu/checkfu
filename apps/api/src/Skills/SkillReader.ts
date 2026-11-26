import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export const SkillReading = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true), name: Schema.String, description: Schema.String }),
	Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
])
export type SkillReading = typeof SkillReading.Type

export const SkillReader = Context.Reference<{
	readonly read: (markdown: string) => Effect.Effect<SkillReading>
}>("@checkfu/api/SkillReader", {
	defaultValue: () => ({
		read: () => Effect.die(new Error("No SkillReader is provided to read a SKILL.md.")),
	}),
})
