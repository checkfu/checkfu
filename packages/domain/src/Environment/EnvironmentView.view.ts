import * as Domain from "@alchemy.run/domain"
import { EnvironmentSnapshot } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import { Environment } from "./Environment.aggregate.ts"

export { EnvironmentSnapshot }

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
