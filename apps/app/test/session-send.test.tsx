// @vitest-environment happy-dom
import { QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { routeTree } from "../src/routeTree.gen.ts"
import { button, newQueryClient, settle, stubApi, submit, type } from "./dom.tsx"

const AT = "2026-11-24T00:00:00.000Z"

const session = {
	id: "sesn_1",
	type: "session",
	title: "Triage",
	status: "idle",
	turn: 1,
	agent: { id: "agent_1", version: 1 },
	environment_id: "env_1",
	mcp_server_credentials: [],
	usage: { input_tokens: 1, output_tokens: 1 },
	created_at: AT,
	updated_at: AT,
	archived_at: null,
}

const envelope = (seq: number) => ({ id: `evt_${seq}`, seq, created_at: AT })

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

const settled = [
	{ ...envelope(2), type: "session.status_idle", turn: 1, stop_reason: { type: "end_turn" } },
	{ ...envelope(1), type: "user.message", content: [{ type: "text", text: "Hello." }] },
]

class QuietEventSource {
	readonly readyState = 1
	addEventListener(): void {}
	close(): void {}
}

const open = async (events: ReadonlyArray<unknown>) => {
	vi.stubGlobal("EventSource", QuietEventSource)
	const sent = stubApi(({ method, path }) =>
		method === "POST"
			? { body: {} }
			: path.includes("/events")
				? { body: { data: events, next_page: null } }
				: { body: session },
	)
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
