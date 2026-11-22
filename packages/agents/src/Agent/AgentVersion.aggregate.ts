import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import {
	AgentDescription,
	AgentModel,
	AgentName,
	AgentSystem,
	NonNegativeInt,
	PositiveInt,
} from "../AgentTypes.ts"
import { AgentId } from "./Agent.id.ts"
import { AgentVersionId } from "./AgentVersion.id.ts"

export class AgentVersionMinted extends Domain.Event("agent_version.minted", {
	agent_id: AgentId,
	version: PositiveInt,
	name: AgentName,
	model: AgentModel,
	system: Schema.NullOr(AgentSystem),
	description: Schema.NullOr(AgentDescription),
}) {}

export const AgentVersionState = Schema.Struct({
	minted: Schema.Boolean,
	agent_id: Schema.String,
	version: NonNegativeInt,
	name: Schema.Union([Schema.Literal(""), AgentName]),
	model_id: Schema.String,
	has_system: Schema.Boolean,
	system: AgentSystem,
	has_description: Schema.Boolean,
	description: AgentDescription,
})
export type AgentVersionState = typeof AgentVersionState.Type

export const AGENT_VERSION_STATE_SCHEMA_VERSION = 1 as const

export const AgentVersionStateSnapshot = versionedSnapshot({
	current: AGENT_VERSION_STATE_SCHEMA_VERSION,
	schema: AgentVersionState,
})

export class AgentVersion extends Domain.Aggregate("AgentVersion", {
	id: AgentVersionId,
	state: AgentVersionStateSnapshot,
	initial: {
		minted: false,
		agent_id: "",
		version: 0,
		name: "",
		model_id: "",
		has_system: false,
		system: "",
		has_description: false,
		description: "",
	},
	events: [AgentVersionMinted],
	invariants: {
		MintedExactlyWhenNumbered: (s) =>
			[
				[
					!s.minted,
					s.agent_id === "",
					s.version === 0,
					s.name === "",
					s.model_id === "",
					!s.has_system,
					s.system === "",
					!s.has_description,
					s.description === "",
				].every((ok) => ok),
				[
					s.minted,
					s.agent_id !== "",
					s.version >= 1,
					s.name !== "",
					s.model_id !== "",
					[s.has_system, s.system === ""].some((ok) => ok),
					[s.has_description, s.description === ""].some((ok) => ok),
				].every((ok) => ok),
			].some((ok) => ok),
	},
	transitions: {
		MintedVersionNeverChanges: ({ before, after }) =>
			[
				!before.minted,
				[
					after.minted,
					after.agent_id === before.agent_id,
					after.version === before.version,
					after.name === before.name,
					after.model_id === before.model_id,
					after.has_system === before.has_system,
					after.system === before.system,
					after.has_description === before.has_description,
					after.description === before.description,
				].every((ok) => ok),
			].some((ok) => ok),
	},
	evolve: {
		"agent_version.minted": (state, e) =>
			state.minted
				? state
				: {
						minted: true,
						agent_id: e.agent_id,
						version: e.version,
						name: e.name,
						model_id: e.model.id,
						has_system: e.system !== null,
						system: e.system ?? "",
						has_description: e.description !== null,
						description: e.description ?? "",
					},
	},
}) {}
