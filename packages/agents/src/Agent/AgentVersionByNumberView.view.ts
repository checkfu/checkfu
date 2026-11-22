import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { AgentVersion } from "./AgentVersion.aggregate.ts"
import { AgentVersionSnapshot } from "./AgentVersionView.view.ts"

export const AgentVersionLookupId = Schema.String.check(Schema.isMinLength(1)).pipe(
	Schema.brand("AgentVersionLookupId"),
)
export type AgentVersionLookupId = typeof AgentVersionLookupId.Type

export const agentVersionLookupKey = (agentId: string, version: number): AgentVersionLookupId =>
	AgentVersionLookupId.make(`${agentId}@${version}`)

/**
 * Immutable O(1) lookup of an agent version by `(agent_id, version)` without
 * growing the head `AgentView` row as new versions are minted.
 */
export class AgentVersionByNumberView extends Domain.View("AgentVersionByNumberView", {
	version: 1,
	from: [AgentVersion],
	key: AgentVersionLookupId,
	keyOf: {
		"agent_version.minted": ({ event }) => agentVersionLookupKey(event.agent_id, event.version),
	},
	state: Schema.NullOr(AgentVersionSnapshot),
	initial: null,
	evolve: {
		"agent_version.minted": (state, e, ctx) =>
			state !== null
				? state
				: {
						id: ctx.source.id,
						agent_id: e.agent_id,
						type: "agent" as const,
						version: e.version,
						name: e.name,
						model: e.model,
						system: e.system,
						description: e.description,
						created_at: ctx.at,
					},
	},
}) {}
