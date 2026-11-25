import type { JsonAutomation } from "@checkfu/sdk/client"
import { describe, expect, it } from "vitest"
import { changesOf, createBodyOf, draftOf, firingLabel } from "../src/automation-draft.ts"

const automation: JsonAutomation = {
	id: "auto_1",
	type: "automation",
	name: "Morning report",
	description: "Every weekday.",
	agent: { id: "agent_1", version: 2 },
	environment_id: "env_1",
	initial_events: [
		{ type: "user.message", content: [{ type: "text", text: "Write the morning report." }] },
	],
	schedule: { type: "cron", expression: "0 9 * * 1-5", timezone: "America/New_York" },
	status: "active",
	pause_reason: null,
	run_count: 0,
	upcoming_runs_at: [],
	last_run_at: null,
	created_at: "2026-01-05T12:00:00.000Z",
	updated_at: "2026-01-05T12:00:00.000Z",
	archived_at: null,
}

describe("editing an automation", () => {
	it("sends nothing when nothing changed, so the server keeps every field as it is", () => {
		expect(changesOf(automation, draftOf(automation))).toEqual({})
	})

	it("sends only the fields the edit changed", () => {
		const draft = { ...draftOf(automation), name: " Noon report ", expression: "0 12 * * *" }
		expect(changesOf(automation, draft)).toEqual({
			name: "Noon report",
			schedule: { type: "cron", expression: "0 12 * * *", timezone: "America/New_York" },
		})
	})

	it("clears a blanked description and follows the latest version of a newly chosen agent", () => {
		const draft = { ...draftOf(automation), description: "  ", agentId: "agent_2" }
		expect(changesOf(automation, draft)).toEqual({ description: null, agent: "agent_2" })
	})

	it("keeps the agent's pinned version while the agent stays the same", () => {
		const draft = { ...draftOf(automation), message: "Write the evening report." }
		expect(changesOf(automation, draft)).toEqual({
			initial_events: [
				{ type: "user.message", content: [{ type: "text", text: "Write the evening report." }] },
			],
		})
	})
})

describe("creating an automation", () => {
	it("builds the create body from the form, trimming what the user typed", () => {
		expect(
			createBodyOf({
				name: " Report ",
				description: "",
				agentId: "agent_1",
				environmentId: "env_1",
				message: " Go. ",
				expression: " 0 9 * * * ",
				timezone: " UTC ",
			}),
		).toEqual({
			name: "Report",
			description: null,
			agent: "agent_1",
			environment_id: "env_1",
			initial_events: [{ type: "user.message", content: [{ type: "text", text: "Go." }] }],
			schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
		})
	})
})

describe("firing times", () => {
	it("are shown in the automation's own timezone", () => {
		const label = firingLabel("2026-01-05T14:00:00.000Z", "America/New_York")
		expect(label).toContain("9:00")
		expect(label).not.toContain("2:00")
	})
})
