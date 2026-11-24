import * as Domain from "@alchemy.run/domain"
import { AutomationSnapshot } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import { AutomationArchived } from "./ArchiveAutomation.command.ts"
import { Automation } from "./Automation.aggregate.ts"
import { AutomationCreated } from "./CreateAutomation.command.ts"
import { AutomationPaused } from "./PauseAutomation.command.ts"
import { AutomationFired } from "./RunAutomation.command.ts"
import { AutomationUnpaused } from "./UnpauseAutomation.command.ts"

export { AutomationSnapshot }

export class AutomationView extends Domain.View("AutomationView", {
	version: 1,
	from: [Automation],
	key: Automation,
	state: Schema.NullOr(AutomationSnapshot),
	initial: null,
	events: [
		AutomationCreated,
		AutomationUnpaused,
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
						agent_id: e.agent_id,
						agent_version: e.agent_version,
						environment_id: e.environment_id,
						text: e.text,
						schedule: e.schedule,
						status: "active" as const,
						pause_reason: null,
						runs: 0,
						activation: 0,
						scheduled_from: ctx.at,
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
						scheduled_from: ctx.at,
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
						scheduled_from: e.trigger === "schedule" ? ctx.at : state.scheduled_from,
						last_run_at: ctx.at,
						updated_at: ctx.at,
					},
	},
}) {}
