import * as Schema from "effect/Schema"

export const TurnToken = Schema.Struct({ turn: Schema.Finite })
export type TurnToken = typeof TurnToken.Type

export const WorkspacePreparation = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true) }),
	Schema.Struct({ ok: Schema.Literal(false), interrupted: Schema.Literal(true) }),
])
export type WorkspacePreparation = typeof WorkspacePreparation.Type
