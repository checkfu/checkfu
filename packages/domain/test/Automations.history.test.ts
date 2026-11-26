import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { AutomationStateSnapshot } from "../src/Automation/Automation.aggregate.ts"
import { AutomationCreated } from "../src/Automation/CreateAutomation.command.ts"
import { AutomationRunFailed } from "../src/Automation/RecordAutomationRunFailed.command.ts"
import { AutomationRunStarted } from "../src/Automation/RecordAutomationRunStarted.command.ts"

const createdBeforeDescriptions = {
	_tag: "automation.created",
	name: "Morning report",
	agent_id: "agent_1",
	agent_version: 1,
	environment_id: "env_1",
	text: "Write the morning report.",
	schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
}

const stateBeforeRevisions = (status: string) => ({
	schema_version: 1,
	state: { status, runs: 2, reported: 2, last_scheduled_at: 0, activation: 1 },
})

describe("automation event and state decoding", () => {
	it("requires the description and pinned version when decoding a creation", () => {
		const decode = Schema.decodeUnknownSync(AutomationCreated)
		expect(() => decode(createdBeforeDescriptions)).toThrow()
		expect(() =>
			decode({ ...createdBeforeDescriptions, description: null, agent_version: null }),
		).toThrow()
		expect(decode({ ...createdBeforeDescriptions, description: null }).agent_version).toBe(1)
	})

	it("requires the pinned agent when decoding a run outcome", () => {
		const fields = { run: 1, trigger: "manual", scheduled_at: null }
		const started = { ...fields, _tag: "automation.run_started", session_id: "sess_auto_1_1" }
		const failed = {
			...fields,
			_tag: "automation.run_failed",
			error: { type: "agent_unavailable", message: "The agent is archived." },
		}
		expect(() => Schema.decodeUnknownSync(AutomationRunStarted)(started)).toThrow()
		expect(() => Schema.decodeUnknownSync(AutomationRunFailed)(failed)).toThrow()
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
