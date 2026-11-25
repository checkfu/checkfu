import type { JsonAutomation } from "@checkfu/sdk/client"
import { describe, expect, it } from "vitest"
import {
	changesOf,
	createBodyOf,
	draftOf,
	firingLabel,
	showsChanges,
} from "../src/automation-draft.ts"

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
		expect(changesOf(draftOf(automation), draftOf(automation))).toEqual({})
	})

	it("sends only the fields the edit changed", () => {
		const draft = { ...draftOf(automation), name: " Noon report ", expression: "0 12 * * *" }
		expect(changesOf(draftOf(automation), draft)).toEqual({
			name: "Noon report",
			schedule: { expression: "0 12 * * *" },
		})
	})

	it("clears a blanked description and follows the latest version of a newly chosen agent", () => {
		const draft = { ...draftOf(automation), description: "  ", agentId: "agent_2" }
		expect(changesOf(draftOf(automation), draft)).toEqual({ description: null, agent: "agent_2" })
	})

	it("keeps the agent's pinned version while the agent stays the same", () => {
		const draft = { ...draftOf(automation), message: "Write the evening report." }
		expect(changesOf(draftOf(automation), draft)).toEqual({
			initial_events: [
				{ type: "user.message", content: [{ type: "text", text: "Write the evening report." }] },
			],
		})
	})
})

describe("editing against the snapshot the editor opened", () => {
	it("leaves another editor's newer schedule alone when only the name was edited", () => {
		const opened = draftOf(automation)
		const draft = { ...opened, name: "Renamed" }
		expect(changesOf(opened, draft)).toEqual({ name: "Renamed" })
	})

	it("keeps stored text the user never touched, even when it is not trimmed", () => {
		const stored = {
			...automation,
			description: "",
			initial_events: [
				{
					type: "user.message" as const,
					content: [{ type: "text" as const, text: "  indented\n" }],
				},
			],
		}
		const opened = draftOf(stored)
		expect(changesOf(opened, { ...opened, name: "Renamed" })).toEqual({ name: "Renamed" })
	})
})

describe("editing one schedule field", () => {
	it("sends only that field, so another editor's change to the other survives", () => {
		const opened = draftOf(automation)
		expect(changesOf(opened, { ...opened, timezone: "Asia/Tokyo" })).toEqual({
			schedule: { timezone: "Asia/Tokyo" },
		})
	})
})

describe("waiting for an update to show", () => {
	it("waits for the agent version too, not only the agent", () => {
		const pinned = { ...automation, agent: { id: "agent_2", version: 1 } }
		expect(showsChanges(pinned, { agent: "agent_2" })).toBe(false)
		expect(
			showsChanges({ ...pinned, agent: { id: "agent_2", version: null } }, { agent: "agent_2" }),
		).toBe(true)
	})

	it("accepts a read only once every submitted field is visible", () => {
		const changes = {
			name: "Noon report",
			schedule: { ...automation.schedule, expression: "0 12 * * *" },
		}
		expect(showsChanges(automation, changes)).toBe(false)
		expect(showsChanges({ ...automation, name: "Noon report" }, changes)).toBe(false)
		expect(showsChanges({ ...automation, schedule: changes.schedule }, changes)).toBe(false)
		expect(
			showsChanges({ ...automation, name: "Noon report", schedule: changes.schedule }, changes),
		).toBe(true)
		expect(showsChanges(automation, {})).toBe(true)
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

describe("firing times in other years and unknown zones", () => {
	const now = Date.parse("2026-11-25T00:00:00.000Z")

	it("show the year only when it is not this one", () => {
		expect(firingLabel("2026-12-01T14:00:00.000Z", "UTC", now)).not.toContain("2026")
		expect(firingLabel("2032-02-29T23:59:00.000Z", "UTC", now)).toContain("2032")
	})

	it("fall back to UTC when the browser does not know the zone", () => {
		const label = firingLabel("2026-12-01T14:00:00.000Z", "Mars/Olympus", now)
		expect(label).toContain("UTC")
		expect(label).toContain("2:00")
	})
})

describe("firing times", () => {
	it("are shown in the automation's own timezone", () => {
		const label = firingLabel("2026-01-05T14:00:00.000Z", "America/New_York")
		expect(label).toContain("9:00")
		expect(label).not.toContain("2:00")
	})
})
