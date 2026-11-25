import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { AutomationStateSnapshot } from "../src/Automation/Automation.aggregate.ts"
import { AutomationCreated } from "../src/Automation/CreateAutomation.command.ts"
import { AutomationRunFailed } from "../src/Automation/RecordAutomationRunFailed.command.ts"
import { AutomationRunStarted } from "../src/Automation/RecordAutomationRunStarted.command.ts"

// What stages that ran automations before descriptions and revisions stored.
const createdBeforeDescriptions = {
	_tag: "automation.created",
	name: "Morning report",
	agent_id: "agent_1",
	agent_version: null,
	environment_id: "env_1",
	text: "Write the morning report.",
	schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
}

const stateBeforeRevisions = (status: string) => ({
	schema_version: 1,
	state: { status, runs: 2, reported: 2, last_scheduled_at: 0, activation: 1 },
})

describe("automation history from before descriptions and revisions", () => {
	it("reads an automation.created event without a description as having none", () => {
		const event = Schema.decodeUnknownSync(AutomationCreated)(createdBeforeDescriptions)
		expect(event.description).toBeNull()
		expect(event.name).toBe("Morning report")
	})

	it("reads run events recorded before runs named their agent as naming none", () => {
		const started = Schema.decodeSync(AutomationRunStarted)({
			_tag: "automation.run_started",
			run: 1,
			session_id: "sess_auto_1_1",
			trigger: "manual",
			scheduled_at: null,
		})
		const failed = Schema.decodeSync(AutomationRunFailed)({
			_tag: "automation.run_failed",
			run: 2,
			trigger: "schedule",
			scheduled_at: 0,
			error: { type: "agent_unavailable", message: "The agent is archived." },
		})
		expect([
			started.agent_id,
			started.agent_version,
			failed.agent_id,
			failed.agent_version,
		]).toEqual([null, null, null, null])
	})

	it("migrates stored state without a revision: a created automation is at its first configuration", () => {
		const decode = Schema.decodeUnknownSync(AutomationStateSnapshot)
		expect(decode(stateBeforeRevisions("active"))).toEqual({
			status: "active",
			runs: 2,
			reported: 2,
			last_scheduled_at: 0,
			activation: 1,
			revision: 1,
		})
		expect(decode(stateBeforeRevisions("")).revision).toBe(0)
	})
})
