import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { EnvironmentConfig, NonEmptyString, PositiveInt } from "./EnvironmentTypes.ts"
import { Environment } from "./Environment.aggregate.ts"
import { EnvironmentId } from "./Environment.id.ts"

export const EnvironmentSnapshot = Schema.Struct({
	id: EnvironmentId,
	type: Schema.Literal("environment"),
	version: PositiveInt,
	name: NonEmptyString,
	description: Schema.NullOr(Schema.String),
	config: EnvironmentConfig,
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type EnvironmentSnapshot = typeof EnvironmentSnapshot.Type

export class EnvironmentView extends Domain.View("EnvironmentView", {
	from: [Environment],
	key: Environment,
	state: Schema.NullOr(EnvironmentSnapshot),
	initial: null,
	evolve: {
		"environment.created": (state, e, ctx) =>
			state !== null
				? state
				: {
						id: ctx.key.id,
						type: "environment" as const,
						version: e.version,
						name: e.name,
						description: e.description,
						config: e.config,
						created_at: ctx.at,
						updated_at: ctx.at,
						archived_at: null,
					},
		"environment.updated": (state, e, ctx) =>
			state === null
				? null
				: {
						...state,
						version: e.version,
						name: e.name,
						description: e.description,
						config: e.config,
						updated_at: ctx.at,
					},
		"environment.archived": (state, _e, ctx) =>
			state === null || state.archived_at
				? state
				: {
						...state,
						archived_at: ctx.at,
						updated_at: ctx.at,
					},
		"environment.deleted": () => null,
	},
}) {}
