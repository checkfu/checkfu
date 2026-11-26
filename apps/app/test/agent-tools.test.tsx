// @vitest-environment happy-dom
import type { JsonAgent } from "@checkfu/sdk/client"
import { useState } from "react"
import type * as React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { bodyOf, draftOf, problemsOf } from "../src/agent-draft.ts"
import { AgentToolsFields, AgentToolsSummary } from "../src/pages/agent-tools.tsx"
import { button, click, mount, type } from "./dom.tsx"

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
