import * as Domain from "@alchemy.run/domain"
import { snapshotVersion, versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import { ArchiveAutomation, AutomationArchived } from "./ArchiveAutomation.command.ts"
import { AutomationId, sessionIdOfNextRun } from "./Automation.id.ts"
import { AutomationArchivedError } from "./AutomationArchived.rejection.ts"
import { AutomationNotFound } from "./AutomationNotFound.rejection.ts"
import { NonNegativeInt, PAUSED_MANUALLY } from "./AutomationTypes.ts"
import {
	AutomationAlreadyExists,
	AutomationCreated,
	CreateAutomation,
} from "./CreateAutomation.command.ts"
import { FireAutomation } from "./FireAutomation.command.ts"
import { AutomationPaused, PauseAutomation } from "./PauseAutomation.command.ts"
import {
	AutomationRunFailed,
	RecordAutomationRunFailed,
} from "./RecordAutomationRunFailed.command.ts"
import {
	AutomationRunStarted,
	RecordAutomationRunStarted,
} from "./RecordAutomationRunStarted.command.ts"
import { AutomationFired, RunAutomation } from "./RunAutomation.command.ts"
import { SuspendAutomation } from "./SuspendAutomation.command.ts"
import { AutomationUnpaused, UnpauseAutomation } from "./UnpauseAutomation.command.ts"
import { AutomationUpdated } from "./UpdateAutomation.command.ts"

export const AutomationState = Schema.Struct({
	status: Schema.String,
	runs: NonNegativeInt,
	reported: NonNegativeInt,
	last_scheduled_at: NonNegativeInt,
	activation: NonNegativeInt,
	revision: NonNegativeInt,
})
export type AutomationState = typeof AutomationState.Type

export const AUTOMATION_STATE_SCHEMA_VERSION = 2 as const

const AutomationStateV1 = AutomationState.mapFields(({ revision: _revision, ...fields }) => fields)

export const AutomationStateSnapshot = versionedSnapshot({
	current: AUTOMATION_STATE_SCHEMA_VERSION,
	schema: AutomationState,
	previous: [
		snapshotVersion({
			version: 1,
			schema: AutomationStateV1,
			migrate: (state) => ({ ...state, revision: state.status === "" ? 0 : 1 }),
		}),
	],
})

const fired = (
	automation_id: AutomationId,
	state: AutomationState,
	trigger: "schedule" | "manual",
	scheduled_at: number | null,
) =>
	new AutomationFired({
		run: state.runs + 1,
		session_id: sessionIdOfNextRun(automation_id, state.runs),
		trigger,
		scheduled_at,
	})

export class Automation extends Domain.Aggregate("Automation", {
	id: AutomationId,
	state: AutomationStateSnapshot,
	initial: {
		status: "",
		runs: 0,
		reported: 0,
		last_scheduled_at: 0,
		activation: 0,
		revision: 0,
	},
	commands: [
		CreateAutomation,
		PauseAutomation,
		UnpauseAutomation,
		ArchiveAutomation,
		RunAutomation,
		FireAutomation,
		SuspendAutomation,
		RecordAutomationRunStarted,
		RecordAutomationRunFailed,
	],
	events: [AutomationUpdated],
	keyOf: (cmd) => cmd.automation_id,
	invariants: {
		StatusIsKnown: (s) =>
			[s.status === "", s.status === "active", s.status === "paused", s.status === "archived"].some(
				(ok) => ok,
			),
		NothingRunsBeforeCreation: (s) =>
			[
				s.status !== "",
				[s.runs === 0, s.reported === 0, s.last_scheduled_at === 0, s.activation === 0].every(
					(ok) => ok,
				),
			].some((ok) => ok),
		ReportedNeverExceedsRuns: (s) => s.reported <= s.runs,
		RevisedExactlyWhenCreated: (s) =>
			[
				[s.status === "", s.revision === 0].every((ok) => ok),
				[s.status !== "", s.revision > 0].every((ok) => ok),
			].some((ok) => ok),
	},
	transitions: {
		CreatedAutomationNeverReturnsToUninitialized: ({ before, after }) =>
			[before.status === "", after.status !== ""].some((ok) => ok),
		ArchivedAutomationStaysArchived: ({ before, after }) =>
			[before.status !== "archived", after.status === "archived"].some((ok) => ok),
		ArchivedAutomationNeverFires: ({ before, after }) =>
			[before.status !== "archived", after.runs === before.runs].some((ok) => ok),
		OnlyUnpauseResumesAPausedAutomation: ({ before, after, command }) =>
			[
				before.status !== "paused",
				after.status !== "active",
				command._tag === "UnpauseAutomation",
			].some((ok) => ok),
		RunsGrowByOneOrNotAtAll: ({ before, after }) =>
			[after.runs === before.runs, after.runs === before.runs + 1].some((ok) => ok),
		OnlyRunAndFireStartRuns: ({ before, after, command }) =>
			[
				after.runs === before.runs,
				command._tag === "RunAutomation",
				command._tag === "FireAutomation",
			].some((ok) => ok),
		ScheduledFiringNeedsAnActiveAutomationAndALaterInstant: ({ before, after, command }) => {
			if (command._tag !== "FireAutomation") {
				return true
			}
			return [
				before.status === "active",
				command.activation === before.activation,
				command.scheduled_at > before.last_scheduled_at,
				after.runs === before.runs + 1,
				after.last_scheduled_at === command.scheduled_at,
			].every((ok) => ok)
		},
		OnlyAResumeOrAnUpdateStartsANewActivation: ({ before, after, command, events }) =>
			[
				after.activation === before.activation,
				[
					command._tag === "UnpauseAutomation",
					before.status === "paused",
					after.activation === before.activation + 1,
				].every((ok) => ok),
				[
					events.some((event) => event._tag === "automation.updated"),
					before.status === "active",
					after.activation === before.activation + 1,
				].every((ok) => ok),
			].some((ok) => ok),
		EveryResumeStartsANewActivation: ({ before, after, events }) =>
			events.every(
				(event) =>
					event._tag !== "automation.unpaused" || after.activation === before.activation + 1,
			),
		ScheduledInstantNeverGoesBack: ({ before, after }) =>
			after.last_scheduled_at >= before.last_scheduled_at,
		FiredCarriesTheNewRun: ({ after, events }) =>
			events.every((event) => event._tag !== "automation.fired" || event.run === after.runs),
		RunsAreReportedInOrder: ({ before, after }) =>
			[after.reported === before.reported, after.reported === before.reported + 1].some((ok) => ok),
		OnlyCreationOrAnUpdateRevisesIt: ({ before, after, events }) =>
			[
				after.revision === before.revision,
				[before.status === "", after.revision === 1].every((ok) => ok),
				[
					events.some((event) => event._tag === "automation.updated"),
					after.revision === before.revision + 1,
				].every((ok) => ok),
			].some((ok) => ok),
		AnUpdateLeavesRunsAlone: ({ before, after, events }) =>
			events.every((event) => event._tag !== "automation.updated") ||
			[
				after.runs === before.runs,
				after.reported === before.reported,
				after.last_scheduled_at === before.last_scheduled_at,
			].every((ok) => ok),
		AFailedRunPausesOnlyAnActiveAutomation: ({ before, after, command }) =>
			[
				command._tag !== "RecordAutomationRunFailed",
				after.status === before.status,
				[before.status === "active", after.status === "paused"].every((ok) => ok),
			].some((ok) => ok),
	},
	decide: {
		CreateAutomation: (state, cmd, ctx) => {
			if (state.status !== "") {
				return new AutomationAlreadyExists({ automation_id: ctx.id })
			}
			return [
				new AutomationCreated({
					name: cmd.name,
					description: cmd.description,
					agent_id: cmd.agent_id,
					agent_version: cmd.agent_version,
					environment_id: cmd.environment_id,
					text: cmd.text,
					schedule: cmd.schedule,
				}),
			]
		},
		PauseAutomation: (state, _cmd, ctx) => {
			if (state.status === "") {
				return new AutomationNotFound({ automation_id: ctx.id })
			}
			if (state.status === "archived") {
				return new AutomationArchivedError({ automation_id: ctx.id })
			}
			if (state.status === "paused") {
				return []
			}
			return [new AutomationPaused({ reason: PAUSED_MANUALLY })]
		},
		UnpauseAutomation: (state, _cmd, ctx) => {
			if (state.status === "") {
				return new AutomationNotFound({ automation_id: ctx.id })
			}
			if (state.status === "archived") {
				return new AutomationArchivedError({ automation_id: ctx.id })
			}
			if (state.status === "active") {
				return []
			}
			return [new AutomationUnpaused({ activation: state.activation + 1 })]
		},
		ArchiveAutomation: (state, _cmd, ctx) => {
			if (state.status === "") {
				return new AutomationNotFound({ automation_id: ctx.id })
			}
			if (state.status === "archived") {
				return []
			}
			return [new AutomationArchived()]
		},
		RunAutomation: (state, _cmd, ctx) => {
			if (state.status === "") {
				return new AutomationNotFound({ automation_id: ctx.id })
			}
			if (state.status === "archived") {
				return new AutomationArchivedError({ automation_id: ctx.id })
			}
			return [fired(ctx.id, state, "manual", null)]
		},
		FireAutomation: (state, cmd, ctx) => {
			if (
				state.status !== "active" ||
				cmd.activation !== state.activation ||
				cmd.scheduled_at <= state.last_scheduled_at
			) {
				return []
			}
			return [fired(ctx.id, state, "schedule", cmd.scheduled_at)]
		},
		SuspendAutomation: (state, cmd) =>
			state.status === "active" ? [new AutomationPaused({ reason: cmd.reason })] : [],
		RecordAutomationRunStarted: (state, cmd, ctx) =>
			cmd.run === state.reported + 1 && cmd.run <= state.runs
				? [
						new AutomationRunStarted({
							run: cmd.run,
							session_id: sessionIdOfNextRun(ctx.id, state.reported),
							trigger: cmd.trigger,
							scheduled_at: cmd.scheduled_at,
							agent_id: cmd.agent_id,
							agent_version: cmd.agent_version,
						}),
					]
				: [],
		RecordAutomationRunFailed: (state, cmd) => {
			if (cmd.run !== state.reported + 1 || cmd.run > state.runs) {
				return []
			}
			const failed = new AutomationRunFailed({
				run: cmd.run,
				trigger: cmd.trigger,
				scheduled_at: cmd.scheduled_at,
				agent_id: cmd.agent_id,
				agent_version: cmd.agent_version,
				error: { type: cmd.error_type, message: cmd.message },
			})
			return [cmd.unrecoverable, state.status === "active", cmd.revision === state.revision].every(
				(ok) => ok,
			)
				? [failed, new AutomationPaused({ reason: cmd.error_type })]
				: [failed]
		},
	},
	reply: {
		RunAutomation: (state) => ({ run: state.runs }),
	},
	evolve: {
		"automation.created": (state) =>
			state.status === "" ? { ...state, status: "active", revision: 1 } : state,
		"automation.paused": (state) =>
			state.status === "active" ? { ...state, status: "paused" } : state,
		"automation.unpaused": (state, e) =>
			state.status === "paused" ? { ...state, status: "active", activation: e.activation } : state,
		"automation.updated": (state, e) =>
			[state.status === "active", state.status === "paused"].some((live) => live)
				? { ...state, revision: e.revision, activation: e.activation }
				: state,
		"automation.archived": (state) =>
			[state.status === "active", state.status === "paused"].some((live) => live)
				? { ...state, status: "archived" }
				: state,
		"automation.fired": (state, e) => ({
			...state,
			runs: e.run,
			last_scheduled_at: e.scheduled_at === null ? state.last_scheduled_at : e.scheduled_at,
		}),
		"automation.run_started": (state, e) => ({ ...state, reported: e.run }),
		"automation.run_failed": (state, e) => ({ ...state, reported: e.run }),
	},
}) {}
