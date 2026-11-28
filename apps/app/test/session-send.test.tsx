// @vitest-environment happy-dom
import { QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { routeTree } from "../src/routeTree.gen.ts"
import { button, click, newQueryClient, settle, stubApi, submit, type } from "./dom.tsx"

const AT = "2026-11-24T00:00:00.000Z"

const session = {
	id: "sesn_1",
	type: "session",
	title: "Triage",
	status: "idle",
	turn: 1,
	agent: {
		type: "agent",
		id: "agent_1",
		version: 1,
		name: "Triage",
		model: { id: "fixture-model" },
		system: null,
		description: null,
		mcp_servers: [],
		tools: [],
	},
	environment_id: "env_1",
	mcp_server_credentials: [],
	resources: [],
	usage: { input_tokens: 1, output_tokens: 1 },
	created_at: AT,
	updated_at: AT,
	archived_at: null,
}

const envelope = (seq: number) => ({ id: `evt_${seq}`, seq, created_at: AT, processed_at: AT })

const waitingOnACall = [
	{
		...envelope(3),
		type: "session.status_idle",
		turn: 1,
		stop_reason: { type: "requires_action", event_ids: ["tu_1"] },
	},
	{
		...envelope(2),
		type: "agent.mcp_tool_use",
		tool_use_id: "tu_1",
		mcp_server_name: "github",
		name: "create_issue",
		input: { title: "Broken" },
		evaluated_permission: "ask",
	},
	{
		...envelope(1),
		type: "user.message",
		content: [{ type: "text", text: "File it." }],
	},
]

const waitingOnCustomCall = [
	waitingOnACall[0],
	{
		...envelope(2),
		type: "agent.custom_tool_use",
		tool_use_id: "tu_1",
		name: "lookup",
		input: {},
	},
	waitingOnACall[2],
]

const settled = [
	{ ...envelope(2), type: "session.status_idle", turn: 1, stop_reason: { type: "end_turn" } },
	{ ...envelope(1), type: "user.message", content: [{ type: "text", text: "Hello." }] },
]

class QuietEventSource {
	readonly readyState = 1
	addEventListener(): void {}
	close(): void {}
}

const open = async (
	events: ReadonlyArray<unknown>,
	firstPostFailure?: number,
	files: ReadonlyArray<unknown> = [],
) => {
	vi.stubGlobal("EventSource", QuietEventSource)
	let status = firstPostFailure
	const sent = stubApi(({ method, path }) => {
		if (path.endsWith("/outputs")) {
			return {
				body: {
					type: "session_outputs",
					session_id: "sesn_1",
					status: "none",
					turn: 0,
					reason: null,
					recorded_at: null,
					files,
					skipped: [],
				},
			}
		}
		if (method === "POST") {
			const failure = status
			status = undefined
			return failure === undefined
				? { body: {} }
				: {
						status: failure,
						body: { error: { type: "conflict_error", message: "Answer refused." } },
					}
		}
		return path.includes("/events")
			? { body: { data: events, next_page: null } }
			: { body: session }
	})
	const queryClient = newQueryClient()
	const router = createRouter({
		routeTree,
		context: { queryClient },
		history: createMemoryHistory({ initialEntries: ["/sessions/sesn_1"] }),
	})
	const container = document.createElement("div")
	document.body.append(container)
	const root = createRoot(container)
	await act(async () => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		)
		await router.load()
	})
	await settle()
	return {
		container,
		messages: () => sent.filter((request) => request.method === "POST"),
		unmount: () => {
			act(() => root.unmount())
			container.remove()
		},
	}
}

const message = (container: HTMLElement): HTMLTextAreaElement => {
	const field = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')
	if (field === null) {
		throw new Error(`No message field in: ${container.textContent ?? ""}`)
	}
	return field
}

const pressSubmitShortcut = async (field: HTMLTextAreaElement, key: "ctrlKey" | "metaKey") => {
	await act(async () => {
		field.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", [key]: true, bubbles: true, cancelable: true }),
		)
	})
	await settle()
}

afterEach(() => {
	vi.unstubAllGlobals()
	document.body.innerHTML = ""
})

it("keeps the session transcript usable when the server returns a malformed file", async () => {
	const page = await open(settled, undefined, [null])
	try {
		expect(page.container.textContent).toContain("Hello.")
		expect(page.container.textContent).toContain("Could not load saved files.")
		expect(button(page.container, "Retry files")).toBeDefined()
	} finally {
		page.unmount()
	}
})

describe("sending a message from a session's page", () => {
	it("sends nothing while tool calls wait, by the button, the form or the keyboard", async () => {
		const page = await open(waitingOnACall)
		expect(page.container.textContent).toContain("The agent is waiting on you")
		await type(message(page.container), "Never mind, do something else.")
		expect(button(page.container, "Send").disabled).toBe(true)

		await pressSubmitShortcut(message(page.container), "ctrlKey")
		await pressSubmitShortcut(message(page.container), "metaKey")
		await submit(message(page.container).form)
		expect(page.messages()).toEqual([])
		expect(message(page.container).value).toBe("Never mind, do something else.")
		page.unmount()
	})

	it("keeps approval locked after acceptance until the stream catches up", async () => {
		const page = await open(waitingOnACall)
		try {
			await click(button(page.container, "Allow"))
			expect(button(page.container, "Allow").disabled).toBe(true)
			expect(button(page.container, "Deny").disabled).toBe(true)
			await click(button(page.container, "Deny"))
			await click(button(page.container, "Allow"))
			expect(page.messages()).toHaveLength(1)
			expect(page.messages()[0]?.body).toMatchObject({
				events: [{ type: "user.tool_confirmation", tool_use_id: "tu_1", result: "allow" }],
			})
		} finally {
			page.unmount()
		}
	})

	it("keeps a terminal refusal locked while the stream still shows approval", async () => {
		const page = await open(waitingOnACall, 409)
		try {
			await click(button(page.container, "Allow"))
			expect(page.container.textContent).toContain("This call is no longer waiting")
			expect(button(page.container, "Allow").disabled).toBe(true)
			expect(button(page.container, "Deny").disabled).toBe(true)
			await click(button(page.container, "Deny"))
			expect(page.messages()).toHaveLength(1)
		} finally {
			page.unmount()
		}
	})

	it("retries a transient approval failure with the same request key", async () => {
		const page = await open(waitingOnACall, 503)
		try {
			await click(button(page.container, "Allow"))
			expect(button(page.container, "Allow").disabled).toBe(false)
			await click(button(page.container, "Allow"))
			expect(button(page.container, "Allow").disabled).toBe(true)
			const keys = page.messages().map(({ headers }) => headers.get("idempotency-key"))
			expect(keys).toHaveLength(2)
			expect(keys[0]).toBeTruthy()
			expect(keys[1]).toBe(keys[0])
		} finally {
			page.unmount()
		}
	})

	it("keeps a submitted custom result locked for both button and form", async () => {
		const page = await open(waitingOnCustomCall)
		try {
			const result = page.container.querySelector<HTMLTextAreaElement>(
				'textarea[aria-label="Result"]',
			)
			await type(result, "Complete.")
			await submit(result?.form)
			expect(button(page.container, "Send result").disabled).toBe(true)
			await submit(result?.form)
			expect(page.messages()).toHaveLength(1)
			expect(page.messages()[0]?.body).toMatchObject({
				events: [{ type: "user.custom_tool_result", custom_tool_use_id: "tu_1" }],
			})
		} finally {
			page.unmount()
		}
	})

	it("sends by the keyboard once nothing waits", async () => {
		const page = await open(settled)
		await type(message(page.container), "Next task.")
		await pressSubmitShortcut(message(page.container), "ctrlKey")
		expect(page.messages().map((request) => request.body)).toEqual([
			{ events: [{ type: "user.message", content: [{ type: "text", text: "Next task." }] }] },
		])
		page.unmount()
	})
})
