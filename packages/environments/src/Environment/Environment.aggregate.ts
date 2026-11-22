import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import { EnvironmentName, NonNegativeInt } from "../EnvironmentTypes.ts"
import { ArchiveEnvironment, EnvironmentArchived } from "./ArchiveEnvironment.command.ts"
import {
	CreateEnvironment,
	EnvironmentAlreadyExists,
	EnvironmentCreated,
} from "./CreateEnvironment.command.ts"
import { DeleteEnvironment, EnvironmentDeleted } from "./DeleteEnvironment.command.ts"
import { EnvironmentId } from "./Environment.id.ts"
import { EnvironmentArchivedError } from "./EnvironmentArchived.rejection.ts"
import { EnvironmentNotFound } from "./EnvironmentNotFound.rejection.ts"
import {
	EnvironmentUpdated,
	EnvironmentVersionConflict,
	UpdateEnvironment,
} from "./UpdateEnvironment.command.ts"

export const EnvironmentState = Schema.Struct({
	status: Schema.String,
	version: NonNegativeInt,
	name: Schema.Union([Schema.Literal(""), EnvironmentName]),
})
export type EnvironmentState = typeof EnvironmentState.Type

export const ENVIRONMENT_STATE_SCHEMA_VERSION = 1 as const

export const EnvironmentStateSnapshot = versionedSnapshot({
	current: ENVIRONMENT_STATE_SCHEMA_VERSION,
	schema: EnvironmentState,
})

export class Environment extends Domain.Aggregate("Environment", {
	id: EnvironmentId,
	state: EnvironmentStateSnapshot,
	initial: {
		status: "",
		version: 0,
		name: "",
	},
	commands: [CreateEnvironment, UpdateEnvironment, ArchiveEnvironment, DeleteEnvironment],
	keyOf: (cmd) => cmd.environment_id,
	invariants: {
		StatusIsKnown: (s) =>
			[
				s.status === "",
				s.status === "active",
				s.status === "archived",
				s.status === "deleted",
			].some((ok) => ok),
		CreatedExactlyWhenVersioned: (s) =>
			[
				[s.status === "", s.version === 0, s.name === ""].every((ok) => ok),
				[s.status !== "", s.version >= 1, s.name !== ""].every((ok) => ok),
			].some((ok) => ok),
	},
	transitions: {
		CreatedEnvironmentNeverReturnsToUninitialized: ({ before, after }) =>
			[before.status === "", after.status !== ""].some((ok) => ok),
		ArchivedNeverReactivates: ({ before, after }) =>
			[
				before.status !== "archived",
				[
					after.status === "archived",
					after.version === before.version,
					after.name === before.name,
				].every((ok) => ok),
				[
					after.status === "deleted",
					after.version === before.version,
					after.name === before.name,
				].every((ok) => ok),
			].some((ok) => ok),
		DeletedStaysDeleted: ({ before, after }) =>
			[
				before.status !== "deleted",
				[
					after.status === "deleted",
					after.version === before.version,
					after.name === before.name,
				].every((ok) => ok),
			].some((ok) => ok),
		VersionGrowsByOneOrNotAtAll: ({ before, after }) =>
			[
				[
					before.status === "",
					[
						[after.status === "", after.version === 0].every((ok) => ok),
						[after.status === "active", after.version === 1].every((ok) => ok),
					].some((ok) => ok),
				].every((ok) => ok),
				[
					before.status !== "",
					after.status !== "",
					[
						[after.version === before.version, after.name === before.name].every((ok) => ok),
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
		CreateEnvironment: (state, cmd, ctx) => {
			if (state.status !== "") {
				return new EnvironmentAlreadyExists({ environment_id: ctx.id })
			}
			return [
				new EnvironmentCreated({
					version: 1,
					name: cmd.name,
					description: cmd.description,
					config: cmd.config,
				}),
			]
		},
		UpdateEnvironment: (state, cmd, ctx) => {
			if ([state.status === "", state.status === "deleted"].some((gone) => gone)) {
				return new EnvironmentNotFound({ environment_id: ctx.id })
			}
			if (state.status !== "active") {
				return new EnvironmentArchivedError({ environment_id: ctx.id })
			}
			if (cmd.expected_version !== state.version) {
				return new EnvironmentVersionConflict({
					environment_id: ctx.id,
					expected_version: cmd.expected_version,
					current_version: state.version,
				})
			}
			return [
				new EnvironmentUpdated({
					version: state.version + 1,
					name: cmd.name,
					description: cmd.description,
					config: cmd.config,
				}),
			]
		},
		ArchiveEnvironment: (state, _cmd, ctx) => {
			if ([state.status === "", state.status === "deleted"].some((gone) => gone)) {
				return new EnvironmentNotFound({ environment_id: ctx.id })
			}
			if (state.status === "archived") return []
			return [new EnvironmentArchived()]
		},
		DeleteEnvironment: (state, _cmd, ctx) => {
			if ([state.status === "", state.status === "deleted"].some((gone) => gone)) {
				return new EnvironmentNotFound({ environment_id: ctx.id })
			}
			return [new EnvironmentDeleted()]
		},
	},
	reply: {
		CreateEnvironment: (state) => ({ version: state.version }),
		UpdateEnvironment: (state) => ({ version: state.version }),
	},
	evolve: {
		"environment.created": (state, e) =>
			state.status === ""
				? {
						status: "active",
						version: e.version,
						name: e.name,
					}
				: state,
		"environment.updated": (state, e) =>
			state.status === "active"
				? {
						...state,
						version: e.version,
						name: e.name,
					}
				: state,
		"environment.archived": (state) =>
			state.status === "active"
				? {
						...state,
						status: "archived",
					}
				: state,
		"environment.deleted": (state) =>
			[state.status === "active", state.status === "archived"].some((live) => live)
				? {
						...state,
						status: "deleted",
					}
				: state,
	},
}) {}
