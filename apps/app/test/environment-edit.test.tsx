// @vitest-environment happy-dom
import type { UpdateEnvironmentBody } from "@checkfu/sdk/Api"
import type { JsonEnvironment } from "@checkfu/sdk/client"
import { useSuspenseQuery } from "@tanstack/react-query"
import { waitFor } from "@testing-library/react"
import { act } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { EnvironmentView, NewEnvironmentPage } from "../src/pages/environments.tsx"
import { environmentQuery } from "../src/queries.ts"
import { button, click, mount, newQueryClient, stubApi, submit, type } from "./dom.tsx"

const at = "2026-01-05T12:00:00.000Z"
const environment: JsonEnvironment = {
	id: "env_reports",
	type: "environment",
	version: 1,
	name: "Reports",
	description: "Used for reporting.",
	config: {
		type: "cloud",
		networking: {
			type: "limited",
			allowed_hosts: ["reports.example.test"],
			allow_mcp_servers: false,
			allow_package_managers: true,
		},
	},
	created_at: at,
	updated_at: at,
	archived_at: null,
}
const endpoint = `/v1/environments/${environment.id}`

const field = (container: HTMLElement, label: string) => {
	const control = [...container.querySelectorAll("label")].find(
		(element) => element.textContent?.trim() === label,
	)?.control
	if (control === null || control === undefined) {
		throw new Error(`Missing environment field ${label}.`)
	}
	return control
}

const text = (container: HTMLElement, label: string) => {
	const associated = field(container, label)
	const control = [
		...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"),
	].find((item) => item === associated)
	if (control === undefined) {
		throw new Error(`Expected a text field for ${label}.`)
	}
	return control
}

const selectLimited = async (container: HTMLElement) => {
	const associated = field(container, "Network access")
	const selector = Array.from(container.querySelectorAll("select")).find(
		(item) => item === associated,
	)
	if (selector === undefined) {
		throw new Error("Expected the network access selector.")
	}
	await act(async () => {
		selector.value = "limited"
		selector.dispatchEvent(new Event("change", { bubbles: true }))
	})
}

const host = (container: HTMLElement, index = 1) => {
	const input = container.querySelector<HTMLTextAreaElement>(
		`textarea[aria-label="Allowed host ${index}"]`,
	)
	if (input === null) {
		throw new Error(`Expected allowed host field ${index}.`)
	}
	return input
}

function EnvironmentUnderTest() {
	const { data } = useSuspenseQuery(environmentQuery(environment.id))
	return <EnvironmentView environment={data} />
}

const editor = async (initial = environment) => {
	const client = newQueryClient()
	client.setQueryData(environmentQuery(initial.id).queryKey, initial)
	let current = initial
	let staleAfterConflict = false
	let delayedRead = false
	const sent = stubApi((request) => {
		if (request.method === "POST" && request.path === endpoint) {
			const body = request.body as UpdateEnvironmentBody
			if (body.version !== current.version) {
				delayedRead = staleAfterConflict
				return {
					status: 409,
					body: { error: { type: "conflict_error", message: "The environment changed." } },
				}
			}
			current = { ...current, ...body, version: current.version + 1 }
			return { body: current }
		}
		if (request.path === endpoint) {
			const snapshot = delayedRead ? initial : current
			delayedRead = false
			return { body: snapshot }
		}
		return { body: { data: [], next_page: null } }
	})
	const page = await mount(<EnvironmentUnderTest />, client)
	await click(button(page.container, "Edit"))
	return {
		...page,
		advance: (fields: Partial<JsonEnvironment>) => {
			current = { ...current, ...fields, version: current.version + 1 }
			staleAfterConflict = true
		},
		writes: () => sent.filter(({ method, path }) => method === "POST" && path === endpoint),
	}
}

afterEach(() => {
	vi.unstubAllGlobals()
	document.body.innerHTML = ""
})

it.each(["unrestricted", "limited"] as const)(
	"creates an environment with the selected %s policy",
	async (mode) => {
		const sent = stubApi(() => ({ body: environment }))
		const page = await mount(<NewEnvironmentPage />)
		try {
			const associated = field(page.container, "Network access")
			const selector = [...page.container.querySelectorAll("select")].find(
				(item) => item === associated,
			)
			if (selector === undefined) {
				throw new Error("Expected the network access selector.")
			}
			expect(selector.value).toBe("unrestricted")
			await type(text(page.container, "Name"), "New environment")
			if (mode === "limited") {
				await selectLimited(page.container)
				await click(button(page.container, "Add host"))
				await type(host(page.container), "reports.example.test")
				await click(button(page.container, "Add host"))
				await type(host(page.container, 2), "data.example.test")
				await click(field(page.container, "Allow MCP servers"))
			}
			await submit(page.container.querySelector("form"))
			const created = sent.find(
				({ method, path }) => method === "POST" && path === "/v1/environments",
			)
			expect(created?.headers.get("idempotency-key")).toBeTruthy()
			expect(created?.body).toEqual({
				name: "New environment",
				description: null,
				config: {
					type: "cloud",
					networking:
						mode === "limited"
							? {
									type: "limited",
									allowed_hosts: ["reports.example.test", "data.example.test"],
									allow_mcp_servers: true,
									allow_package_managers: false,
								}
							: { type: "unrestricted" },
				},
			})
		} finally {
			page.unmount()
		}
	},
)

it("renames a limited environment without sending a policy change", async () => {
	const page = await editor()
	try {
		expect(host(page.container).value).toBe("reports.example.test")
		await type(text(page.container, "Name"), "Reports renamed")
		await submit(page.container.querySelector("form"))
		expect(page.writes().map(({ body }) => body)).toEqual([{ name: "Reports renamed", version: 1 }])
		await waitFor(() => expect(page.container.querySelector("form")).toBeNull())
		expect(page.container.textContent).toContain("Reports renamed")
		expect(page.container.textContent).toContain("reports.example.test")
		expect(page.container.textContent).toContain("v2")
	} finally {
		page.unmount()
	}
})

it("keeps edits across a conflict and waits for review before saving to a newer version", async () => {
	const page = await editor()
	try {
		await type(text(page.container, "Name"), "Draft name")
		await click(field(page.container, "Allow MCP servers"))
		page.advance({
			description: "New description.",
			config: {
				type: "cloud",
				networking: {
					type: "limited",
					allowed_hosts: ["new.example.test"],
					allow_mcp_servers: false,
					allow_package_managers: false,
				},
			},
		})
		await submit(page.container.querySelector("form"))
		expect(button(page.container, "Save changes").disabled).toBe(true)
		expect(page.writes().map(({ body }) => body)).toEqual([
			{
				name: "Draft name",
				version: 1,
				config: {
					type: "cloud",
					networking: {
						type: "limited",
						allowed_hosts: ["reports.example.test"],
						allow_mcp_servers: true,
						allow_package_managers: true,
					},
				},
			},
		])
		await click(button(page.container, "Check latest version"))
		await waitFor(() => expect(page.container.textContent).toContain("new.example.test"))
		expect(button(page.container, "Save changes").disabled).toBe(true)
		expect(text(page.container, "Name").value).toBe("Draft name")
		await click(button(page.container, "Use v2 as the base"))
		expect(text(page.container, "Description").value).toBe("New description.")
		expect(host(page.container).value).toBe("new.example.test")
		await submit(page.container.querySelector("form"))
		expect(page.writes()[1]?.body).toEqual({
			name: "Draft name",
			version: 2,
			config: {
				type: "cloud",
				networking: {
					type: "limited",
					allowed_hosts: ["new.example.test"],
					allow_mcp_servers: true,
					allow_package_managers: false,
				},
			},
		})
		await waitFor(() => expect(page.container.querySelector("form")).toBeNull())
		expect(page.container.textContent).toContain("v3")
	} finally {
		page.unmount()
	}
})

it("preserves the exact saved hosts when only an allowance changes", async () => {
	const allowedHosts = [" reports.example.test ", "one.example.test,two.example.test"]
	const page = await editor({
		...environment,
		name: " Reports ",
		description: "",
		config: {
			type: "cloud",
			networking: {
				type: "limited",
				allowed_hosts: allowedHosts,
				allow_mcp_servers: false,
				allow_package_managers: true,
			},
		},
	})
	try {
		await click(field(page.container, "Allow MCP servers"))
		await submit(page.container.querySelector("form"))
		expect(page.writes()[0]?.body).toEqual({
			version: 1,
			config: {
				type: "cloud",
				networking: {
					type: "limited",
					allowed_hosts: allowedHosts,
					allow_mcp_servers: true,
					allow_package_managers: true,
				},
			},
		})
	} finally {
		page.unmount()
	}
})

it("adds a host without changing other saved host entries", async () => {
	const saved = [" reports.example.test ", "other.example.test\nmore.example.test"]
	const page = await editor({
		...environment,
		config: {
			type: "cloud",
			networking: {
				type: "limited",
				allowed_hosts: saved,
				allow_mcp_servers: false,
				allow_package_managers: true,
			},
		},
	})
	try {
		await click(button(page.container, "Add host"))
		await type(host(page.container, 3), "added.example.test")
		await submit(page.container.querySelector("form"))
		expect(page.writes()[0]?.body).toMatchObject({
			version: 1,
			config: { networking: { allowed_hosts: [...saved, "added.example.test"] } },
		})
	} finally {
		page.unmount()
	}
})

it("keeps edited limited fields visible after reviewing a concurrent mode change", async () => {
	const page = await editor()
	try {
		await type(host(page.container), "draft.example.test")
		page.advance({ config: { type: "cloud", networking: { type: "unrestricted" } } })
		await submit(page.container.querySelector("form"))
		expect(button(page.container, "Save changes").disabled).toBe(true)
		await click(button(page.container, "Check latest version"))
		await waitFor(() => expect(page.container.textContent).toContain("Use v2 as the base"))
		await click(button(page.container, "Use v2 as the base"))
		expect(host(page.container).value).toBe("draft.example.test")
		await submit(page.container.querySelector("form"))
		expect(page.writes()[1]?.body).toEqual({
			version: 2,
			config: {
				type: "cloud",
				networking: {
					type: "limited",
					allowed_hosts: ["draft.example.test"],
					allow_mcp_servers: false,
					allow_package_managers: true,
				},
			},
		})
	} finally {
		page.unmount()
	}
})

it.each(["saved", "draft"] as const)(
	"requires a choice to keep the %s allowlist after concurrent changes",
	async (choice) => {
		const page = await editor()
		try {
			await type(text(page.container, "Name"), "New name")
			await click(button(page.container, "Add host"))
			await type(host(page.container, 2), "added.example.test")
			page.advance({
				config: {
					type: "cloud",
					networking: {
						type: "limited",
						allowed_hosts: [],
						allow_mcp_servers: false,
						allow_package_managers: true,
					},
				},
			})
			await submit(page.container.querySelector("form"))
			await click(button(page.container, "Check latest version"))
			await waitFor(() => expect(page.container.textContent).toContain("Choose the list to keep"))
			expect(button(page.container, "Save changes").disabled).toBe(true)
			await click(button(page.container, `Keep ${choice} allowlist`))
			await submit(page.container.querySelector("form"))
			expect(page.writes()[1]?.body).toEqual({
				version: 2,
				name: "New name",
				...(choice === "saved"
					? {}
					: {
							config: {
								type: "cloud",
								networking: {
									type: "limited",
									allowed_hosts: ["reports.example.test", "added.example.test"],
									allow_mcp_servers: false,
									allow_package_managers: true,
								},
							},
						}),
			})
		} finally {
			page.unmount()
		}
	},
)

it("preserves disjoint changes when both reviewers select limited networking", async () => {
	const page = await editor({
		...environment,
		config: { type: "cloud", networking: { type: "unrestricted" } },
	})
	try {
		await selectLimited(page.container)
		await click(field(page.container, "Allow MCP servers"))
		page.advance({
			config: {
				type: "cloud",
				networking: {
					type: "limited",
					allowed_hosts: ["saved.example.test"],
					allow_mcp_servers: false,
					allow_package_managers: true,
				},
			},
		})
		await submit(page.container.querySelector("form"))
		await click(button(page.container, "Check latest version"))
		await waitFor(() => expect(page.container.textContent).toContain("Use v2 as the base"))
		await click(button(page.container, "Use v2 as the base"))
		await submit(page.container.querySelector("form"))
		expect(page.writes()[1]?.body).toEqual({
			version: 2,
			config: {
				type: "cloud",
				networking: {
					type: "limited",
					allowed_hosts: ["saved.example.test"],
					allow_mcp_servers: true,
					allow_package_managers: true,
				},
			},
		})
	} finally {
		page.unmount()
	}
})

it("displays archived environments without editing or archive controls", async () => {
	const page = await mount(<EnvironmentView environment={{ ...environment, archived_at: at }} />)
	try {
		expect(page.container.textContent).toContain("Archived")
		expect(page.container.textContent).toContain("reports.example.test")
		expect(page.container.querySelector("form")).toBeNull()
		expect(
			[...page.container.querySelectorAll("button")].map((control) => control.textContent),
		).not.toContain("Edit")
		expect(
			[...page.container.querySelectorAll("button")].map((control) => control.textContent),
		).not.toContain("Archive")
	} finally {
		page.unmount()
	}
})
