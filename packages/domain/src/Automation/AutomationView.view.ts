import * as Domain from "@alchemy.run/domain"
import { AutomationSnapshot } from "@checkfu/sdk/Schemas"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { AutomationArchived } from "./ArchiveAutomation.command.ts"
import { Automation } from "./Automation.aggregate.ts"
import { AutomationCreated } from "./CreateAutomation.command.ts"
import { AutomationPaused } from "./PauseAutomation.command.ts"
import { AutomationFired } from "./RunAutomation.command.ts"
import { UPCOMING_FIRINGS, upcomingOccurrences } from "./Schedule.ts"
import { AutomationUnpaused } from "./UnpauseAutomation.command.ts"
import { AutomationUpdated } from "./UpdateAutomation.command.ts"

export { AutomationSnapshot }

export class AutomationView extends Domain.View("AutomationView", {
	version: 4,
	from: [Automation],
	key: Automation,
	state: Schema.NullOr(AutomationSnapshot),
	initial: null,
	events: [
		AutomationCreated,
		AutomationUnpaused,
		AutomationUpdated,
		AutomationFired,
		AutomationPaused,
		AutomationArchived,
	],
	evolve: {
		"automation.created": (state, e, ctx) =>
			state !== null
				? state
				: {
						id: ctx.key.id,
						type: "automation" as const,
						name: e.name,
						description: e.description,
						agent_id: e.agent_id,
						agent_version: e.agent_version,
						environment_id: e.environment_id,
						text: e.text,
						schedule: e.schedule,
						status: "active" as const,
						pause_reason: null,
						runs: 0,
						activation: 0,
						upcoming: upcomingOccurrences(
							e.schedule.expression,
							e.schedule.timezone,
							DateTime.toEpochMillis(ctx.at),
							UPCOMING_FIRINGS,
						),
						last_run_at: null,
						created_at: ctx.at,
						updated_at: ctx.at,
						archived_at: null,
					},
		"automation.paused": (state, e, ctx) =>
			state === null || state.status !== "active"
				? state
				: { ...state, status: "paused" as const, pause_reason: e.reason, updated_at: ctx.at },
		"automation.unpaused": (state, e, ctx) =>
			state === null || state.status !== "paused"
				? state
				: {
						...state,
						status: "active" as const,
						pause_reason: null,
						activation: e.activation,
						upcoming: upcomingOccurrences(
							state.schedule.expression,
							state.schedule.timezone,
							DateTime.toEpochMillis(ctx.at),
							UPCOMING_FIRINGS,
						),
						updated_at: ctx.at,
					},
		"automation.updated": (state, e, ctx) =>
			state === null || state.status === "archived"
				? state
				: {
						...state,
						name: e.name,
						description: e.description,
						agent_id: e.agent_id,
						agent_version: e.agent_version,
						environment_id: e.environment_id,
						text: e.text,
						schedule: e.schedule,
						activation: e.activation,
						upcoming:
							state.status === "active"
								? upcomingOccurrences(
										e.schedule.expression,
										e.schedule.timezone,
										DateTime.toEpochMillis(ctx.at),
										UPCOMING_FIRINGS,
									)
								: state.upcoming,
						updated_at: ctx.at,
					},
		"automation.archived": (state, _e, ctx) =>
			state === null || state.status === "archived"
				? state
				: {
						...state,
						status: "archived" as const,
						pause_reason: null,
						archived_at: ctx.at,
						updated_at: ctx.at,
					},
		"automation.fired": (state, e, ctx) =>
			state === null
				? null
				: {
						...state,
						runs: e.run,
						upcoming:
							e.trigger === "schedule"
								? upcomingOccurrences(
										state.schedule.expression,
										state.schedule.timezone,
										DateTime.toEpochMillis(ctx.at),
										UPCOMING_FIRINGS,
									)
								: state.upcoming,
						last_run_at: ctx.at,
						updated_at: ctx.at,
					},
		"automation.run_started": (state) => state,
		"automation.run_failed": (state) => state,
	},
}) {}
