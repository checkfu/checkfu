import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
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

describe("automation event decoding", () => {
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
})
