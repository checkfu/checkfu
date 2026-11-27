// @vitest-environment happy-dom
import type { UpdateAutomationBody } from "@checkfu/sdk/Api"
import type { JsonAutomation } from "@checkfu/sdk/client"
import { useSuspenseQuery } from "@tanstack/react-query"
import { waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { AutomationView } from "../src/pages/automations.tsx"
import { automationQuery } from "../src/queries.ts"
import { button, click, mount, newQueryClient, settle, stubApi, submit, type } from "./dom.tsx"

const automation: JsonAutomation = {
	id: "auto_1",
	type: "automation",
	name: "Morning report",
	description: null,
	agent: { id: "agent_1", version: 2 },
	environment_id: "env_1",
	initial_events: [
		{ type: "user.message", content: [{ type: "text", text: "Write the report." }] },
	],
	schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
	status: "active",
	pause_reason: null,
	run_count: 0,
	revision: 1,
	upcoming_runs_at: [],
	last_run_at: null,
	created_at: "2026-01-05T12:00:00.000Z",
	updated_at: "2026-01-05T12:00:00.000Z",
	archived_at: null,
}

const endpoint = "/v1/automations/auto_1"
const emptyPage = { data: [], next_page: null }
const conflict = {
	status: 409,
	body: { error: { type: "conflict_error", message: "The automation changed." } },
}

function AutomationUnderTest() {
	const { data } = useSuspenseQuery(automationQuery(automation.id))
	return <AutomationView automation={data} />
}

const field = (container: HTMLElement, label: string): HTMLInputElement => {
	const found = [...container.querySelectorAll("label")].find(
		(element) => element.textContent === label,
	)?.control
	if (found?.tagName !== "INPUT") {
		throw new Error("Missing automation field " + label)
	}
	return found as HTMLInputElement
}

const editor = async ({
	pending = false,
	lagOnConflict = false,
	openEditor = true,
	latestAgentVersion = automation.agent.version,
	agentArchived = false,
	omitRevision,
	beforeWrite,
}: {
	readonly pending?: boolean
	readonly lagOnConflict?: boolean
	readonly openEditor?: boolean
	readonly latestAgentVersion?: number
	readonly agentArchived?: boolean
	readonly omitRevision?: "opening" | "refresh"
	readonly beforeWrite?: (
		advance: (fields: Partial<JsonAutomation>) => void,
	) => ReturnType<Parameters<typeof stubApi>[0]> | void
} = {}) => {
	const queryClient = newQueryClient()
	if (omitRevision !== "opening") {
		queryClient.setQueryData(automationQuery(automation.id).queryKey, automation)
	}
	let current = automation
	let previous: JsonAutomation | undefined
	let writeAccepted = false
	let delayedConflict = false
	let acceptedReads = 0
	const advance = (fields: Partial<JsonAutomation>) => {
		current = { ...current, ...fields, revision: current.revision + 1 }
	}
	const sent = stubApi((request) => {
		if (request.path === `${endpoint}/run` && request.method === "POST") {
			return {
				status: 409,
				body: { error: { type: "conflict_error", message: "Run could not start." } },
			}
		}
		if (request.path === endpoint && request.method === "POST") {
			const response = beforeWrite?.(advance)
			if (response !== undefined) {
				return response
			}
			const body = request.body as UpdateAutomationBody
			if (body.revision !== current.revision) {
				if (lagOnConflict && !delayedConflict) {
					previous = automation
					delayedConflict = true
				}
				return conflict
			}
			const before = current
			advance({
				agent:
					typeof body.agent === "object" && body.agent.id === current.agent.id
						? { id: body.agent.id, version: body.agent.version ?? latestAgentVersion }
						: current.agent,
				name: body.name ?? current.name,
				schedule: { ...current.schedule, ...body.schedule },
			})
			writeAccepted = true
			if (pending) {
				previous = before
				return { status: 202, body: { id: current.id, type: "automation", pending: true } }
			}
			return { body: current }
		}
		if (request.path === endpoint) {
			const body = previous ?? current
			previous = undefined
			if (writeAccepted) {
				acceptedReads += 1
			}
			if (omitRevision !== undefined) {
				const { revision: _revision, ...revisionless } = body
				return { body: revisionless }
			}
			return { body }
		}
		if (request.path === "/v1/agents/agent_1") {
			return {
				body: {
					id: "agent_1",
					version: latestAgentVersion,
					archived_at: agentArchived ? automation.created_at : null,
				},
			}
		}
		if (request.path.startsWith("/v1/agents?")) {
			return {
				body: { ...emptyPage, data: [{ id: "agent_1", name: "Reporter", model: { id: "model" } }] },
			}
		}
		if (request.path.startsWith("/v1/environments?")) {
			return { body: { ...emptyPage, data: [{ id: "env_1", name: "Cloud" }] } }
		}
		return { body: emptyPage }
	})
	const page = await mount(<AutomationUnderTest />, queryClient)
	await waitFor(() => expect(button(page.container, "Edit")).toBeTruthy())
	if (openEditor) {
		await click(button(page.container, "Edit"))
		await waitFor(() => expect(page.container.querySelector("form")).not.toBeNull())
	}
	return {
		...page,
		advance,
		current: () => current,
		acceptedReads: () => acceptedReads,
		writes: () =>
			sent.flatMap(({ method, path, body }) =>
				method === "POST" && path === endpoint ? [body] : [],
			),
	}
}

afterEach(() => {
	vi.unstubAllGlobals()
	document.body.innerHTML = ""
})

it("moves the automation to the displayed agent version after a pending update settles", async () => {
	const page = await editor({ openEditor: false, latestAgentVersion: 3, pending: true })
	try {
		await waitFor(() => expect(button(page.container, "Use v3")).toBeTruthy())
		await click(button(page.container, "Use v3"))
		await waitFor(() => expect(page.container.textContent).toContain("pinned to v3"))
		expect(page.writes()).toEqual([
			{ revision: 1, agent: { type: "agent", id: "agent_1", version: 3 } },
		])
		expect(page.acceptedReads()).toBe(3)
		expect(page.container.textContent).not.toContain("Use v3")
	} finally {
		page.unmount()
	}
})

it.each([{ latestAgentVersion: 2 }, { latestAgentVersion: 3, agentArchived: true }])(
	"offers no repin action for an already current pin or an archived agent (%j)",
	async (agent) => {
		const page = await editor({ ...agent, openEditor: false })
		try {
			await settle()
			expect(page.container.textContent).toContain("pinned to v2")
			expect(page.container.textContent).not.toContain("Use v")
		} finally {
			page.unmount()
		}
	},
)

it("shows a revision conflict without resubmitting the repin", async () => {
	const page = await editor({ openEditor: false, latestAgentVersion: 3 })
	try {
		await waitFor(() => expect(button(page.container, "Use v3")).toBeTruthy())
		await click(button(page.container, "Run now"))
		await waitFor(() => expect(page.container.textContent).toContain("Run could not start."))
		page.advance({ description: "External edit" })
		await click(button(page.container, "Use v3"))
		await waitFor(() => expect(page.container.textContent).toContain("The automation changed."))
		expect(page.writes()).toEqual([
			{ revision: 1, agent: { type: "agent", id: "agent_1", version: 3 } },
		])
		expect(page.container.textContent).toContain("pinned to v2")
	} finally {
		page.unmount()
	}
})

it("waits for the newer revision, retries a disjoint edit, and settles the accepted write", async () => {
	const page = await editor({ pending: true, lagOnConflict: true })
	try {
		await type(field(page.container, "Schedule"), "0 10 * * *")
		page.advance({ schedule: { ...automation.schedule, timezone: "Asia/Tokyo" } })
		await submit(page.container.querySelector("form"))
		await waitFor(() => expect(page.container.querySelector("form")).toBeNull())
		expect(page.writes()).toEqual([
			{ revision: 1, schedule: { expression: "0 10 * * *" } },
			{ revision: 2, schedule: { expression: "0 10 * * *" } },
		])
		// Two reads settle the accepted write and the active query refetches once more.
		expect(page.acceptedReads()).toBe(3)
		expect(page.current()).toMatchObject({
			revision: 3,
			schedule: { expression: "0 10 * * *", timezone: "Asia/Tokyo" },
		})
	} finally {
		page.unmount()
	}
})

it.each(["opening", "refresh"] as const)(
	"keeps the draft when the %s snapshot omits its revision",
	async (omitRevision) => {
		const page = await editor({ omitRevision })
		try {
			await type(field(page.container, "Name"), "My report")
			page.advance({ description: "External edit" })
			await submit(page.container.querySelector("form"))
			expect(page.container.querySelector('[role="alert"]')?.textContent).toContain(
				"usable automation revision",
			)
			expect(field(page.container, "Name").value).toBe("My report")
			expect(page.writes()).toEqual(
				omitRevision === "opening" ? [] : [{ name: "My report", revision: 1 }],
			)
		} finally {
			page.unmount()
		}
	},
)

it("preserves the API error and draft when a conflict has no newer revision", async () => {
	const page = await editor({
		beforeWrite: () => ({
			status: 409,
			body: { error: { type: "conflict_error", message: "The agent is archived." } },
		}),
	})
	try {
		await type(field(page.container, "Name"), "My report")
		await submit(page.container.querySelector("form"))
		await waitFor(() =>
			expect(page.container.querySelector('[role="alert"]')?.textContent).toContain(
				"The agent is archived.",
			),
		)
		expect(field(page.container, "Name").value).toBe("My report")
		expect(page.writes()).toEqual([{ name: "My report", revision: 1 }])
	} finally {
		page.unmount()
	}
})

it("shows the conflicting server field and keeps the draft until the user chooses to save it", async () => {
	const page = await editor()
	try {
		await type(field(page.container, "Name"), "My report")
		page.advance({ name: "Server report" })
		await submit(page.container.querySelector("form"))
		expect(page.writes()).toEqual([{ name: "My report", revision: 1 }])
		expect(page.container.querySelector('[role="alert"]')?.textContent).toContain(
			"Name Server report",
		)
		expect(field(page.container, "Name").value).toBe("My report")
		expect(page.current().name).toBe("Server report")
		await click(button(page.container, "Save my edits"))
		expect(page.writes()).toEqual([
			{ name: "My report", revision: 1 },
			{ name: "My report", revision: 2 },
		])
		expect(page.current()).toMatchObject({ name: "My report", revision: 3 })
		expect(page.container.querySelector("form")).toBeNull()
	} finally {
		page.unmount()
	}
})

it("keeps the draft and stops after a second conflict during the same save", async () => {
	const page = await editor({ beforeWrite: (advance) => advance({ description: "External edit" }) })
	try {
		await type(field(page.container, "Name"), "My report")
		await submit(page.container.querySelector("form"))
		expect(page.writes()).toEqual([
			{ name: "My report", revision: 1 },
			{ name: "My report", revision: 2 },
		])
		expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("changed again")
		expect(field(page.container, "Name").value).toBe("My report")
		expect(page.current().name).toBe(automation.name)
		await click(button(page.container, "Cancel"))
		expect(page.container.querySelector("form")).toBeNull()
		expect(page.writes()).toHaveLength(2)
	} finally {
		page.unmount()
	}
})

it("keeps input on a network failure and sends no update after cancelling and reopening unchanged", async () => {
	const page = await editor({
		beforeWrite: () => {
			throw new TypeError("Connection lost.")
		},
	})
	try {
		await type(field(page.container, "Name"), "My report")
		await submit(page.container.querySelector("form"))
		expect(page.container.querySelector('[role="alert"]')?.textContent).toContain(
			"Connection lost.",
		)
		expect(field(page.container, "Name").value).toBe("My report")
		expect(page.writes()).toEqual([{ name: "My report", revision: 1 }])
		await click(button(page.container, "Cancel"))
		await click(button(page.container, "Edit"))
		expect(field(page.container, "Name").value).toBe(automation.name)
		expect(page.container.querySelector('[role="alert"]')).toBeNull()
		await submit(page.container.querySelector("form"))
		expect(page.container.querySelector("form")).toBeNull()
		expect(page.writes()).toHaveLength(1)
	} finally {
		page.unmount()
	}
})
