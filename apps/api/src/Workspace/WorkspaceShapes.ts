import { RepositoryCheckout } from "@checkfu/domain/Session/SessionResource"
import * as Schema from "effect/Schema"

export const TurnToken = Schema.Struct({ turn: Schema.Finite })
export type TurnToken = typeof TurnToken.Type

export const RepositoryMount = Schema.Struct({
	id: Schema.String,
	url: Schema.String,
	mount_path: Schema.String,
	checkout: Schema.NullOr(RepositoryCheckout),
})
export type RepositoryMount = typeof RepositoryMount.Type

export const WorkspacePreparation = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true) }),
	Schema.Struct({ ok: Schema.Literal(false), resource_id: Schema.String, message: Schema.String }),
])
export type WorkspacePreparation = typeof WorkspacePreparation.Type
