// @vitest-environment happy-dom
import * as codec from "@checkfu/authoring/document"
import type { JsonAgent, JsonAutomation, JsonSession } from "@checkfu/sdk/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router"
import { cleanup, render, waitFor } from "@testing-library/react"
import { act, useState } from "react"
import type * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { bodyOf, draftOf, problemsOf } from "../src/agent-draft.ts"
import { AgentToolsFields, AgentToolsSummary } from "../src/pages/agent-tools.tsx"
import { agentQuery } from "../src/queries.ts"
import { routeTree } from "../src/routeTree.gen.ts"
import { button, click, mount, newQueryClient, settle, stubApi, submit, type } from "./dom.tsx"

const AT = "2026-11-24T00:00:00.000Z"

const agent: JsonAgent = {
	type: "agent",
	id: "agent_1",
	version: 1,
	name: "Triage",
	model: { id: "claude-sonnet-5-5" },
	system: null,
	description: null,
	mcp_servers: [{ type: "url", name: "git", url: "https://git.example.com/mcp" }],
	tools: [
		{
			type: "mcp_toolset",
			mcp_server_name: "git",
			default_config: { permission_policy: { type: "always_allow" } },
		},
	],
	created_at: AT,
	updated_at: AT,
	archived_at: null,
}

const open = async () => {
	const held = { draft: draftOf(agent) }
	function Form(): React.JSX.Element {
		const [draft, setDraft] = useState(held.draft)
		held.draft = draft
		return <AgentToolsFields draft={draft} problems={problemsOf(draft)} onChange={setDraft} />
	}
	const mounted = await mount(<Form />)
	return { ...mounted, held }
}

const names = (container: HTMLElement): ReadonlyArray<HTMLInputElement> => [
	...container.querySelectorAll<HTMLInputElement>('input[placeholder="github"]'),
]

const permissions = (container: HTMLElement): ReadonlyArray<string> =>
	[...container.querySelectorAll("select")].map((select) => select.value)

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
	document.body.innerHTML = ""
})

describe("the agent form's MCP servers", () => {
	it("leaves git's permission on git while a second server is typed past its name to github", async () => {
		const form = await open()
		await click(button(form.container, "Add server"))
		for (const typed of ["g", "gi", "git", "gith", "github"]) {
			await type(names(form.container)[1] ?? null, typed)
			expect(permissions(form.container)).toEqual(["always_allow", ""])
			expect(names(form.container)[0]?.value).toBe("git")
		}
		expect(bodyOf(form.held.draft).tools).toEqual(agent.tools)
		form.unmount()
	})

	it("renames a server with its permission, and removes the permission with the server", async () => {
		const form = await open()
		await type(names(form.container)[0] ?? null, "scm")
		expect(permissions(form.container)).toEqual(["always_allow"])
		expect(bodyOf(form.held.draft).tools).toEqual([{ ...agent.tools[0], mcp_server_name: "scm" }])

		await click(button(form.container, "Add server"))
		await type(names(form.container)[1] ?? null, "git")
		expect(permissions(form.container)).toEqual(["always_allow", ""])
		await click(
			form.container.querySelector<HTMLButtonElement>('button[aria-label="Remove scm"]') ??
				form.container,
		)
		expect(permissions(form.container)).toEqual([""])
		expect(bodyOf(form.held.draft).tools).toEqual([])
		form.unmount()
	})
})

describe("the default MCP permission", () => {
	it("says every tool asks first, read-only ones included, in the form and on the saved agent", async () => {
		const form = await open()
		await click(button(form.container, "Add server"))
		const selects = [...form.container.querySelectorAll("select")]
		const chosen = selects[1]?.selectedOptions[0]?.textContent ?? ""
		expect(chosen).toBe("Ask first (default)")
		expect(form.container.textContent).not.toMatch(/read-only/iu)
		form.unmount()

		const saved = await mount(
			<AgentToolsSummary
				agent={{
					...agent,
					mcp_servers: [
						...agent.mcp_servers,
						{ type: "url", name: "docs", url: "https://docs.example.com/mcp" },
					],
				}}
			/>,
		)
		expect(saved.container.textContent).toContain("Ask first (default)")
		expect(saved.container.textContent).not.toMatch(/read-only/iu)
		saved.unmount()
	})
})

describe("agent revision navigation", () => {
	const routeRenderWait = { timeout: 3000 }
	const revision: JsonAgent = {
		...agent,
		model: { id: "historical-model" },
		system: "Original instructions",
	}
	const head: JsonAgent = {
		...agent,
		version: 2,
		model: { id: "current-model" },
		system: "Current instructions",
		mcp_servers: [],
		tools: [],
	}
	const agentPath = `/agents/${agent.id}`
	const agentApiPath = `/v1${agentPath}`
	const session: JsonSession = {
		id: "sesn_1",
		type: "session",
		title: "Run using version one",
		agent: revision,
		environment_id: "env_1",
		mcp_server_credentials: [],
		resources: [],
		status: "idle",
		turn: 1,
		usage: { input_tokens: 1, output_tokens: 1 },
		created_at: AT,
		updated_at: AT,
		archived_at: null,
	}
	const automation: JsonAutomation = {
		id: "auto_1",
		type: "automation",
		name: "Morning report",
		description: null,
		agent: { id: revision.id, version: revision.version },
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
		created_at: AT,
		updated_at: AT,
		archived_at: null,
	}

	const openRoute = async (initialPath: string, initialAgent = head) => {
		let current = initialAgent
		vi.stubGlobal(
			"EventSource",
			class {
				addEventListener(): void {}
				close(): void {}
			},
		)
		const sent = stubApi(({ path, method, body }) => {
			const url = new URL(path, "https://dashboard.test")
			switch (url.pathname) {
				case "/auth/session":
					return { body: {} }
				case "/v1/sessions":
					return { body: { data: [session], next_page: null } }
				case `/v1/sessions/${session.id}`:
					return { body: session }
				case `/v1/sessions/${session.id}/events`:
				case `/v1/automations/${automation.id}/runs`:
					return { body: { data: [], next_page: null } }
				case `/v1/automations/${automation.id}`:
					return { body: automation }
				case agentApiPath:
					if (method === "POST") {
						const { version, ...changes } = body as {
							version: number
							name?: string
							system?: string
						}
						if (version !== current.version) {
							return {
								status: 409,
								body: { error: { type: "conflict_error", message: "Agent changed." } },
							}
						}
						current = { ...current, ...changes, version: version + 1 }
						return { body: current }
					}
					if (!url.searchParams.has("version")) {
						return { body: current }
					}
					if (url.searchParams.get("version") === String(revision.version)) {
						return { body: revision }
					}
					return {
						status: 404,
						body: { error: { type: "not_found_error", message: "Agent revision not found." } },
					}
				default:
					throw new Error(`Unexpected request ${path}`)
			}
		})
		const queryClient = newQueryClient()
		const router = createRouter({
			routeTree,
			context: { queryClient },
			history: createMemoryHistory({ initialEntries: [initialPath] }),
		})
		const view = render(
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		)
		await act(async () => {
			await router.load()
		})
		await settle()
		return {
			...view,
			router,
			queryClient,
			current: () => current,
			updateAgent: async (changes: Partial<JsonAgent>) => {
				current = { ...current, ...changes, version: current.version + 1 }
				await act(async () => {
					await queryClient.invalidateQueries({ queryKey: agentQuery(current.id).queryKey })
				})
			},
			posts: () =>
				sent
					.filter(({ path, method }) => path === agentApiPath && method === "POST")
					.map(({ body }) => body),
			agentRequests: () =>
				sent.filter(({ path }) => path.startsWith(agentApiPath)).map(({ path }) => path),
		}
	}

	it.each([
		{ path: "/sessions", name: `${agent.id} v1` },
		{ path: `/sessions/${session.id}`, name: "Agent v1" },
		{ path: `/automations/${automation.id}`, name: agent.id },
	])("opens the pinned revision from $path", async ({ path, name }) => {
		const view = await openRoute(path)
		const link = await view.findByRole("link", { name }, routeRenderWait)
		expect(link.getAttribute("href")).toBe(`${agentPath}?version=1`)
		await click(link)
		await view.findByText("historical-model", undefined, routeRenderWait)
		expect(view.getByText("Original instructions")).toBeDefined()
		expect(view.queryByRole("button", { name: "Edit" })).toBeNull()
		expect(view.queryByRole("button", { name: "Archive" })).toBeNull()
		expect(view.agentRequests()).toEqual(
			path.startsWith("/automations/")
				? [agentApiPath, `${agentApiPath}?version=1`]
				: [`${agentApiPath}?version=1`],
		)
	})

	it("keeps a directly loaded revision and the current editor separate through history", async () => {
		const view = await openRoute(`${agentPath}?version=1`)
		await view.findByText("historical-model", undefined, routeRenderWait)
		await click(view.getByRole("link", { name: "View current agent" }))
		await view.findByText("current-model", undefined, routeRenderWait)
		expect(view.router.state.location.href).toBe(agentPath)
		await click(view.getByRole("button", { name: "Edit" }))
		expect(view.getByRole("button", { name: "Save new version" })).toBeDefined()
		await act(async () => view.router.history.back())
		await settle()
		await view.findByText("historical-model", undefined, routeRenderWait)
		expect(view.router.state.location.href).toBe(`${agentPath}?version=1`)
		await act(async () => view.router.history.forward())
		await settle()
		await view.findByRole("button", { name: "Edit" }, routeRenderWait)
		expect(view.router.state.location.href).toBe(agentPath)
		expect(view.queryClient.getQueryData(agentQuery(agent.id).queryKey)).toEqual(head)
		expect(view.queryClient.getQueryData(agentQuery(agent.id, 1).queryKey)).toEqual(revision)
		expect(view.agentRequests()).toEqual([`${agentApiPath}?version=1`, agentApiPath])
	})

	const exactAgent: JsonAgent = {
		...head,
		name: " Padded ",
		description: "",
		system: "  Keep the original prompt.\n\n",
		mcp_servers: [{ type: "url", name: "reports", url: "https://reports.example/mcp" }],
		tools: [
			{
				type: "custom",
				name: "before",
				description: "Read the report.",
				input_schema: { type: "object" },
			},
			{ type: "mcp_toolset", mcp_server_name: "reports" },
			{
				type: "custom",
				name: "after",
				description: "Save the report.",
				input_schema: { type: "object" },
			},
		],
	}

	const sourceIn = async (view: Awaited<ReturnType<typeof openRoute>>) => {
		await click(view.getByRole("button", { name: "YAML" }))
		await view.findByRole("textbox", { name: "Agent definition" }, routeRenderWait)
		const field = view.container.querySelector("textarea")
		if (field === null) {
			throw new Error("Missing editor for the agent definition")
		}
		return field
	}

	const editExactAgent = async () => {
		const view = await openRoute(agentPath, exactAgent)
		await click(await view.findByRole("button", { name: "Edit" }, routeRenderWait))
		return view
	}

	it("saves untouched YAML without writing or changing the saved representation", async () => {
		const view = await editExactAgent()
		const source = await sourceIn(view)
		expect(codec.parseAgentDefinition(source.value)).toMatchObject({
			name: exactAgent.name,
			system: exactAgent.system,
			description: "",
			mcp_servers: exactAgent.mcp_servers,
			tools: exactAgent.tools,
		})
		await submit(view.container.querySelector("form"))
		await view.findByRole("button", { name: "Edit" }, routeRenderWait)
		expect(view.posts()).toEqual([])
		expect(view.current()).toEqual(exactAgent)
	})

	it("retains an edited YAML definition through mode switches and sends a sparse update", async () => {
		const view = await editExactAgent()
		const source = await sourceIn(view)
		const edited = codec.agentDefinitionYaml({
			...codec.parseAgentDefinition(source.value),
			system: "Use recent data.",
		})
		await type(source, edited)
		await click(view.getByRole("button", { name: "Form" }))
		await waitFor(() =>
			expect(view.getByRole("textbox", { name: "System prompt" })).toHaveProperty(
				"value",
				"Use recent data.",
			),
		)
		expect((await sourceIn(view)).value).toBe(edited)
		await submit(view.container.querySelector("form"))
		await view.findByRole("button", { name: "Edit" }, routeRenderWait)
		expect(view.posts()).toEqual([{ version: exactAgent.version, system: "Use recent data." }])
		expect(view.current()).toEqual({
			...exactAgent,
			system: "Use recent data.",
			version: exactAgent.version + 1,
		})
	})

	it("rebuilds YAML from the new saved version and the explicitly rebased edit", async () => {
		const view = await editExactAgent()
		const source = await sourceIn(view)
		await type(
			source,
			codec.agentDefinitionYaml({
				...codec.parseAgentDefinition(source.value),
				system: "My new prompt.",
			}),
		)
		await view.updateAgent({ description: "New description from a teammate." })
		await click(await view.findByRole("button", { name: "Apply my edits to v3" }, routeRenderWait))
		expect(codec.parseAgentDefinition((await sourceIn(view)).value)).toMatchObject({
			name: exactAgent.name,
			system: "My new prompt.",
			description: "New description from a teammate.",
			tools: exactAgent.tools,
		})
		await submit(view.container.querySelector("form"))
		await view.findByRole("button", { name: "Edit" }, routeRenderWait)
		expect(view.posts()).toEqual([{ version: 3, system: "My new prompt." }])
	})

	it.each(["Form", "YAML"])(
		"keeps mixed tool order after editing a tool and server from %s",
		async (mode) => {
			const view = await editExactAgent()
			const url = "https://reports.example/new"
			await type(view.container.querySelector('input[type="url"]'), url)
			const toolDescription = view.container.querySelector<HTMLInputElement>(
				'input[value="Read the report."]',
			)
			await type(toolDescription, "Review the report.")
			const tools = exactAgent.tools.map((tool) =>
				tool.type === "custom" && tool.name === "before"
					? { ...tool, description: "Review the report." }
					: tool,
			)
			const mcp_servers = [{ type: "url", name: "reports", url }]
			if (mode === "YAML") {
				expect(codec.parseAgentDefinition((await sourceIn(view)).value)).toMatchObject({
					tools,
					mcp_servers,
				})
			}
			await submit(view.container.querySelector("form"))
			await view.findByRole("button", { name: "Edit" }, routeRenderWait)
			expect(view.posts()).toEqual([{ version: exactAgent.version, tools, mcp_servers }])
		},
	)

	it("keeps an explicit YAML name and tool order across form edits and a concurrent save", async () => {
		const view = await editExactAgent()
		const source = await sourceIn(view)
		const ordered = [...exactAgent.tools].reverse()
		const name = "  Revised report  "
		await type(
			source,
			codec.agentDefinitionYaml({
				...codec.parseAgentDefinition(source.value),
				name,
				tools: ordered,
			}),
		)
		await click(view.getByRole("button", { name: "Form" }))
		await type(view.container.querySelector("textarea"), "My new prompt.")
		expect(codec.parseAgentDefinition((await sourceIn(view)).value)).toMatchObject({
			name,
			system: "My new prompt.",
			tools: ordered,
		})
		const added = {
			type: "custom" as const,
			name: "audit",
			description: "Audit the report.",
			input_schema: { type: "object" },
		}
		await view.updateAgent({ tools: [...exactAgent.tools, added] })
		await click(await view.findByRole("button", { name: "Apply my edits to v3" }, routeRenderWait))
		const tools = [...ordered, added]
		expect(codec.parseAgentDefinition((await sourceIn(view)).value)).toMatchObject({
			name,
			system: "My new prompt.",
			tools,
		})
		await submit(view.container.querySelector("form"))
		await view.findByRole("button", { name: "Edit" }, routeRenderWait)
		expect(view.posts()).toEqual([
			{
				version: 3,
				name,
				system: "My new prompt.",
				mcp_servers: exactAgent.mcp_servers,
				tools,
			},
		])
	})
	it.each([
		["invalid", "Agent version must be a positive integer.", []],
		["0", "Agent version must be a positive integer.", []],
		["99", "Agent revision not found.", [`${agentApiPath}?version=99`]],
	])("shows a route error for requested revision %s", async (version, message, requests) => {
		const view = await openRoute(`${agentPath}?version=${version}`)
		await view.findByText(message, undefined, routeRenderWait)
		expect(view.queryByText("current-model")).toBeNull()
		expect(view.agentRequests()).toEqual(requests)
	})
})
