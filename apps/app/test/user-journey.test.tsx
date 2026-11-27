// @vitest-environment happy-dom
import { Checkfu } from "@checkfu/sdk"
import { QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router"
import { fireEvent, render, waitFor } from "@testing-library/react"
import * as Effect from "effect/Effect"
import { EventSource as HttpEventSource } from "eventsource"
import { act } from "react"
import { Headers as HttpHeaders, Request as HttpRequest, Response as HttpResponse } from "undici"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeTestServer, TEST_API_KEY } from "../../mcp/test/helpers/McpHarness.ts"
import { queryClient, router as configuredRouter } from "../src/router.tsx"
import dashboard from "../worker.ts"
import { button, click, settle, type } from "./dom.tsx"

const ORIGIN = "https://dashboard.test"
let consoleErrors: Array<ReadonlyArray<unknown>> = []

const field = (container: HTMLElement, label: string) => {
	const named = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
		`[aria-label="${label}"]`,
	)
	if (named !== null) {
		return named
	}
	const match = [...container.querySelectorAll("label")].find(
		(element) => element.textContent === label,
	)
	const element = match?.control
	if (
		element === null ||
		element === undefined ||
		!["INPUT", "TEXTAREA"].includes(element.tagName)
	) {
		throw new Error(`No field labelled ${label}`)
	}
	return element as HTMLInputElement | HTMLTextAreaElement
}

const link = (container: HTMLElement, text: string) => {
	const element = [...container.querySelectorAll("a")].find(
		(element) => element.textContent?.trim() === text,
	)
	if (element === undefined) {
		throw new Error(`No link labelled ${text}`)
	}
	return element
}

const choose = async (container: HTMLElement, label: string, name: string) => {
	await waitFor(() => {
		const control = [...container.querySelectorAll("label")].find(
			(element) => element.textContent === label,
		)?.control
		if (control?.tagName !== "SELECT") {
			throw new Error(`No select labelled ${label}`)
		}
		const select = control as HTMLSelectElement
		const option = [...select.options].find((option) => option.textContent?.includes(name))
		if (option === undefined) {
			throw new Error(`No option ${name} in ${label}`)
		}
		fireEvent.change(select, { target: { value: option.value } })
	})
	await settle()
}

const open = async (apiFetch: typeof globalThis.fetch, path: string) => {
	// The Worker runs in a server realm; a browser's Response hides Set-Cookie.
	vi.stubGlobal("Request", HttpRequest)
	vi.stubGlobal("Response", HttpResponse)
	vi.stubGlobal("Headers", HttpHeaders)
	const env = {
		CHECKFU_API_KEY: TEST_API_KEY,
		CHECKFU_PUBLIC_API_URL: "https://api.test",
		API: { fetch: apiFetch },
		ASSETS: {
			fetch: () => Promise.reject(new Error("Unexpected asset request in the DOM journey")),
		},
	}
	let cookie = ""
	const fetchDashboard: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(
			typeof input === "string" || "href" in input ? new URL(String(input), ORIGIN) : input,
			init,
		)
		const headers = request.headers
		if (cookie !== "") {
			headers.set("cookie", cookie)
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			headers.set("origin", ORIGIN)
		}
		const response = await dashboard.fetch(request, env)
		const saved = response.headers.get("set-cookie")
		if (saved !== null) {
			cookie = saved.split(";")[0] ?? ""
		}
		return response
	}
	const signedIn = await fetchDashboard(`${ORIGIN}/auth/sign-in`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ key: TEST_API_KEY }).toString(),
	})
	expect(signedIn.status).toBe(204)
	expect(cookie).not.toBe("")
	expect((await fetchDashboard(`${ORIGIN}/auth/session`)).status).toBe(204)
	vi.stubGlobal("fetch", fetchDashboard)
	vi.stubGlobal(
		"EventSource",
		class extends HttpEventSource {
			constructor(url: string) {
				super(new URL(url, ORIGIN), { fetch: fetchDashboard })
			}
		},
	)
	queryClient.clear()
	const router = createRouter({
		...configuredRouter.options,
		history: createMemoryHistory({ initialEntries: [path] }),
	})
	const container = document.createElement("div")
	document.body.append(container)
	const view = render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
		{ container },
	)
	await act(async () => {
		await router.load()
	})
	await settle()
	return {
		container,
		router,
		unmount: () => {
			view.unmount()
			queryClient.clear()
			container.remove()
		},
	}
}

const memoryJourney = async (apiFetch: typeof globalThis.fetch) => {
	const otherUser = new Checkfu({
		baseUrl: "https://api.test",
		apiKey: TEST_API_KEY,
		fetch: apiFetch,
	})
	const page = await open(apiFetch, "/memory-stores/new")
	try {
		await waitFor(
			() => {
				expect(
					page.container.querySelector("h1")?.textContent,
					page.container.textContent ?? "",
				).toBe("New memory store")
			},
			{ timeout: 5000 },
		)
		await type(field(page.container, "Name"), "Shared handbook")
		await click(button(page.container, "Create store"))
		await waitFor(() =>
			expect(page.container.querySelector("h1")?.textContent).toBe("Shared handbook"),
		)
		await type(field(page.container, "Path"), "/notes/guide.md")
		await type(field(page.container, "Content"), "Original café 🧪\n")
		await click(button(page.container, "Add memory"))
		await waitFor(() => expect(page.container.textContent).toContain("/notes/guide.md"))
		await click(link(page.container, "/notes/guide.md"))
		await waitFor(() => expect(field(page.container, "Content").value).toBe("Original café 🧪\n"))
		await type(field(page.container, "Content"), "My unsaved draft\n")
		const stores = await otherUser.memoryStores.list()
		const store = stores.data[0]
		if (store === undefined) {
			throw new Error("The UI-created store was not persisted")
		}
		const listed = await otherUser.memoryStores.memories.list(store.id)
		const memory = listed.data[0]
		if (memory === undefined) {
			throw new Error("The UI-created memory was not persisted")
		}
		await otherUser.memoryStores.memories.update(store.id, memory.id, {
			content: "A teammate's new version\n",
		})
		await click(button(page.container, "Save"))
		await waitFor(() => expect(page.container.querySelector('[role="alert"]')).not.toBeNull())
		expect(field(page.container, "Content").value).toBe("My unsaved draft\n")
		expect((await otherUser.memoryStores.memories.retrieve(store.id, memory.id)).content).toBe(
			"A teammate's new version\n",
		)
		// Refetch through navigation, as a user returning to the file would.
		await click(link(page.container, "Shared handbook"))
		await click(link(page.container, "/notes/guide.md"))
		await waitFor(() =>
			expect(field(page.container, "Content").value).toBe("A teammate's new version\n"),
		)
		await type(field(page.container, "Content"), "A deliberate new edit\n")
		await click(button(page.container, "Save"))
		await waitFor(async () =>
			expect((await otherUser.memoryStores.memories.retrieve(store.id, memory.id)).content).toBe(
				"A deliberate new edit\n",
			),
		)
	} finally {
		page.unmount()
	}
}

const agentJourney = async (apiFetch: typeof globalThis.fetch) => {
	const otherUser = new Checkfu({
		baseUrl: "https://api.test",
		apiKey: TEST_API_KEY,
		fetch: apiFetch,
	})
	const page = await open(apiFetch, "/agents/new")
	try {
		await waitFor(() => {
			expect(page.container.querySelector("h1")?.textContent).toBe("New agent")
		})
		await click(button(page.container, "YAML"))
		await waitFor(() => expect(field(page.container, "Agent definition")).toBeDefined())
		const source = [
			"name: Shared reporter",
			"model: gpt-6.2-sol",
			"system: Original agent instructions.",
			"tools:",
			"  - type: custom",
			"    name: lookup_report",
			"    description: Look up a report by its reference.",
			"    input_schema:",
			"      type: object",
			"      properties:",
			"        reference: {type: string}",
			"      required: [reference]",
		].join("\n")
		await type(field(page.container, "Agent definition"), `${source}\nunknown_field: reject this\n`)
		await waitFor(() =>
			expect(page.container.querySelector('[role="alert"]')?.textContent).toContain(
				"unknown_field",
			),
		)
		expect(button(page.container, "Create agent").disabled).toBe(true)
		expect((await otherUser.agents.list()).data).toHaveLength(0)
		await type(field(page.container, "Agent definition"), source)
		await click(button(page.container, "Form"))
		expect(field(page.container, "Name").value).toBe("Shared reporter")
		expect(button(page.container, "Create agent").disabled, page.container.textContent ?? "").toBe(
			false,
		)
		await click(button(page.container, "Create agent"))
		await waitFor(() => {
			expect(
				page.container.querySelector("h1")?.textContent,
				page.container.textContent ?? "",
			).toBe("Shared reporter")
		})
		const agent = (await otherUser.agents.list()).data[0]
		if (agent === undefined) {
			throw new Error("The YAML-authored agent was not persisted")
		}
		expect(agent.tools).toHaveLength(1)
		await click(button(page.container, "Edit"))
		await type(field(page.container, "Description"), "My unsaved description")
		await otherUser.agents.update(agent.id, {
			version: 1,
			system: "A teammate's newer instructions.",
		})
		await click(button(page.container, "Save new version"))
		await waitFor(() => {
			expect(button(page.container, "Apply my edits to v2")).toBeDefined()
		})
		expect(field(page.container, "Description").value).toBe("My unsaved description")
		const before = await otherUser.agents.retrieve(agent.id)
		expect(before.description).toBeNull()
		expect(before.system).toBe("A teammate's newer instructions.")
		await click(button(page.container, "Apply my edits to v2"))
		await click(button(page.container, "Save new version"))
		await waitFor(() => {
			expect(button(page.container, "Edit")).toBeDefined()
		})
		const saved = await otherUser.agents.retrieve(agent.id)
		expect(saved.version).toBe(3)
		expect(saved.description).toBe("My unsaved description")
		expect(saved.system).toBe("A teammate's newer instructions.")
		expect(saved.tools).toEqual(agent.tools)
		const historical = await otherUser.agents.retrieve(agent.id, { version: 1 })
		expect(historical.system).toBe("Original agent instructions.")
		expect(historical.description).toBeNull()
		expect(historical.tools).toEqual(agent.tools)
	} finally {
		page.unmount()
	}
}

const sessionJourney = async (apiFetch: typeof globalThis.fetch) => {
	const otherUser = new Checkfu({
		baseUrl: "https://api.test",
		apiKey: TEST_API_KEY,
		fetch: apiFetch,
	})
	await otherUser.waitForPending(
		await otherUser.agents.create({ name: "Resource reader", model: "gpt-6.2-sol" }),
	)
	await otherUser.waitForPending(
		await otherUser.environments.create({ name: "Resource environment" }),
	)
	const memory = await otherUser.waitForPending(
		await otherUser.memoryStores.create({ name: "Shared notes" }),
	)
	const input = await otherUser.artifacts.create({
		name: "Report input",
		files: [{ path: "input.csv", content: "value\n42\n" }],
	})
	const skill = await otherUser.artifacts.create({
		name: "Report skill",
		files: [
			{
				path: "SKILL.md",
				content:
					"---\nname: report-reader\ndescription: Read the report input.\n---\n\nKeep the exact source bytes.",
			},
		],
	})
	const page = await open(apiFetch, "/sessions/new")
	try {
		await waitFor(() => expect(page.container.querySelector("h1")?.textContent).toBe("New session"))
		await type(field(page.container, "Title"), "Shared report")
		await click(button(page.container, "Memory store"))
		await choose(page.container, "Store", "Shared notes")
		await click(button(page.container, "Artifact files"))
		await choose(page.container, "Artifact", "Report input")
		await click(button(page.container, "Skill"))
		await choose(page.container, "Skill", "Report input")
		await click(button(page.container, "Start session"))
		await waitFor(() =>
			expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("SKILL.md"),
		)
		expect((await otherUser.sessions.list()).data).toHaveLength(0)
		expect(field(page.container, "Title").value).toBe("Shared report")
		await choose(page.container, "Skill", "Report skill")
		await click(button(page.container, "Start session"))
		await waitFor(() => {
			expect(page.container.querySelector("h1")?.textContent).toBe("Shared report")
		})
		const session = (await otherUser.sessions.list()).data[0]
		if (session === undefined) {
			throw new Error("The corrected session was not persisted")
		}
		const saved = await otherUser.sessions.retrieve(session.id)
		expect(saved.resources.map((resource) => resource.type)).toEqual([
			"memory_store",
			"artifact",
			"skill",
		])
		expect(saved.resources[0]).toMatchObject({ memory_store_id: memory.id, access: "read_write" })
		expect(saved.resources[1]).toMatchObject({ artifact_id: input.id, version: 1 })
		expect(saved.resources[2]).toMatchObject({
			artifact_id: skill.id,
			version: 1,
			name: "report-reader",
		})
	} finally {
		page.unmount()
	}
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
	consoleErrors = []
	vi.spyOn(console, "error").mockImplementation((...args: ReadonlyArray<unknown>) => {
		consoleErrors.push(args)
	})
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
	document.body.innerHTML = ""
})

describe("dashboard journeys through the production HTTP boundary and domain", () => {
	it(
		"rejects an invalid skill without partial admission and preserves the form to create a corrected session",
		{ timeout: 20_000, tags: ["acceptance", "ui-session-admission"] },
		async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const server = yield* makeTestServer
					yield* Effect.promise(() => sessionJourney(server.apiFetch))
				}).pipe(Effect.scoped),
			)
			expect(consoleErrors).toEqual([])
		},
	)
	it(
		"authors YAML in the UI and explicitly rebases a stale edit without losing tools or historical versions",
		{ timeout: 20_000, tags: ["acceptance", "ui-agent-conflict"] },
		async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const server = yield* makeTestServer
					yield* Effect.promise(() => agentJourney(server.apiFetch))
				}).pipe(Effect.scoped),
			)
			expect(consoleErrors).toEqual([])
		},
	)
	it(
		"creates a memory, preserves a conflicting draft, and saves only after loading the newer version",
		{ timeout: 20_000, tags: ["acceptance", "ui-memory-conflict"] },
		async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const server = yield* makeTestServer
					yield* Effect.promise(() => memoryJourney(server.apiFetch))
				}).pipe(Effect.scoped),
			)
			expect(consoleErrors).toEqual([])
		},
	)
})
