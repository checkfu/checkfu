import * as Domain from "@alchemy.run/domain"
import { snapshotVersion, versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import { NonNegativeInt } from "./AgentTypes.ts"
import { NO_MCP_SERVERS } from "../Mcp/McpServers.ts"
import { AgentId } from "./Agent.id.ts"
import { AgentNotFound } from "./AgentNotFound.rejection.ts"
import { AgentArchived, ArchiveAgent } from "./ArchiveAgent.command.ts"
import { AgentCreated } from "./CreateAgent.command.ts"
import { AgentUpdated } from "./UpdateAgent.command.ts"

const AgentStateV1 = Schema.Struct({
	status: Schema.String,
	version: NonNegativeInt,
	current_version_id: Schema.String,
	name: Schema.String,
	model_id: Schema.String,
	has_system: Schema.Boolean,
	system: Schema.String,
	has_description: Schema.Boolean,
	description: Schema.String,
})

export const AgentState = Schema.Struct({
	...AgentStateV1.fields,
	mcp_servers: Schema.String,
})
export type AgentState = typeof AgentState.Type

export const AGENT_STATE_SCHEMA_VERSION = 2 as const

export const AgentStateSnapshot = versionedSnapshot({
	current: AGENT_STATE_SCHEMA_VERSION,
	schema: AgentState,
	previous: [
		snapshotVersion({
			version: 1,
			schema: AgentStateV1,
			migrate: (state) => ({
				...state,
				mcp_servers: state.status === "" ? "" : NO_MCP_SERVERS,
			}),
		}),
	],
})

export class Agent extends Domain.Aggregate("Agent", {
	id: AgentId,
	state: AgentStateSnapshot,
	initial: {
		status: "",
		version: 0,
		current_version_id: "",
		name: "",
		model_id: "",
		has_system: false,
		system: "",
		has_description: false,
		description: "",
		mcp_servers: "",
	},
	commands: [ArchiveAgent],
	events: [AgentCreated, AgentUpdated],
	keyOf: (cmd) => cmd.agent_id,
	invariants: {
		StatusIsKnown: (s) =>
			[s.status === "", s.status === "active", s.status === "archived"].some((ok) => ok),
		CreatedExactlyWhenVersioned: (s) =>
			[
				[
					s.status === "",
					s.version === 0,
					s.current_version_id === "",
					s.name === "",
					s.model_id === "",
					!s.has_system,
					s.system === "",
					!s.has_description,
					s.description === "",
				].every((ok) => ok),
				[
					s.status !== "",
					s.version >= 1,
					s.current_version_id !== "",
					s.name !== "",
					s.model_id !== "",
					[s.has_system, s.system === ""].some((ok) => ok),
					[s.has_description, s.description === ""].some((ok) => ok),
				].every((ok) => ok),
			].some((ok) => ok),
	},
	transitions: {
		CreatedAgentNeverReturnsToUninitialized: ({ before, after }) =>
			[before.status === "", after.status !== ""].some((ok) => ok),
		ArchivedAgentStaysArchived: ({ before, after }) =>
			[
				before.status !== "archived",
				[
					after.status === "archived",
					after.version === before.version,
					after.current_version_id === before.current_version_id,
					after.name === before.name,
					after.model_id === before.model_id,
					after.has_system === before.has_system,
					after.system === before.system,
					after.has_description === before.has_description,
					after.description === before.description,
				].every((ok) => ok),
			].some((ok) => ok),
		VersionGrowsByOneOrNotAtAll: ({ before, after }) =>
			[
				before.status === "",
				[
					after.status !== "",
					[
						after.version === before.version,
						[
							before.status === "active",
							after.status === "active",
							after.version === before.version + 1,
						].every((ok) => ok),
					].some((ok) => ok),
				].every((ok) => ok),
			].some((ok) => ok),
	},
	decide: {
		ArchiveAgent: (state, _cmd, ctx) => {
			if (state.status === "") {
				return new AgentNotFound({ agent_id: ctx.id })
			}
			if (state.status === "archived") {
				return []
			}
			return [new AgentArchived()]
		},
	},
	evolve: {
		"agent.created": (state, e) =>
			state.status === ""
				? {
						status: "active",
						version: e.version,
						current_version_id: e.version_id,
						name: e.name,
						model_id: e.model.id,
						has_system: e.system !== null,
						system: e.system ?? "",
						has_description: e.description !== null,
						description: e.description ?? "",
						mcp_servers: e.mcp_servers ?? NO_MCP_SERVERS,
					}
				: state,
		"agent.updated": (state, e) =>
			state.status === "active"
				? {
						...state,
						version: e.version,
						current_version_id: e.version_id,
						name: e.name,
						model_id: e.model.id,
						has_system: e.system !== null,
						system: e.system ?? "",
						has_description: e.description !== null,
						description: e.description ?? "",
						mcp_servers: e.mcp_servers ?? state.mcp_servers,
					}
				: state,
		"agent.archived": (state) =>
			state.status === "active"
				? {
						...state,
						status: "archived",
					}
				: state,
	},
}) {}
