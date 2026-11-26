// @vitest-environment happy-dom
import type { JsonAgent, JsonVault, JsonVaultCredential } from "@checkfu/sdk/client"
import { act, Suspense } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NewSessionPage } from "../src/pages/sessions.tsx"
import { button, click, mount, settle, stubApi, submit } from "./dom.tsx"

const AT = "2026-11-24T00:00:00.000Z"

const agent: JsonAgent = {
	type: "agent",
	id: "agent_1",
	version: 1,
	name: "Triage",
	model: { id: "claude-sonnet-5-5" },
	system: null,
	description: null,
	mcp_servers: [{ type: "url", name: "github", url: "https://mcp.github.com/mcp" }],
	tools: [],
	created_at: AT,
	updated_at: AT,
	archived_at: null,
}

const vault = (id: string): JsonVault => ({
	id,
	type: "vault",
	display_name: `Vault ${id}`,
	custody: { storing: 0, held: 1, erasing: 0 },
	created_at: AT,
	updated_at: AT,
	archived_at: null,
})

const credential = (id: string, vaultId: string): JsonVaultCredential => ({
	id,
	type: "vault_credential",
	vault_id: vaultId,
	display_name: `Credential ${id}`,
	auth: { type: "static_bearer", mcp_server_url: "https://mcp.github.com/mcp" },
	custody: "held",
	created_at: AT,
	updated_at: AT,
	archived_at: null,
})

const page = (data: ReadonlyArray<unknown>) => ({ data, has_more: false, next_cursor: null })

const server = () => {
	const state = {
		vaults: [vault("vlt_work"), vault("vlt_personal")],
		credentials: new Map([
			["vlt_work", [credential("vcrd_work", "vlt_work")]],
			["vlt_personal", [credential("vcrd_personal", "vlt_personal")]],
		]),
		agent,
		failing: new Set<string>(),
		failingLists: new Set<string>(),
		vaultsDown: false,
		goneLists: new Set<string>(),
		existing: {
			vaults: [vault("vlt_work"), vault("vlt_personal")],
			credentials: [
				credential("vcrd_work", "vlt_work"),
				credential("vcrd_personal", "vlt_personal"),
			],
		},
	}
	const gone = { status: 404, body: { error: { type: "not_found_error", message: "Not found." } } }
	const down = { status: 503, body: { error: { type: "api_error", message: "Unavailable." } } }
	const sent = stubApi(({ method, path }) => {
		if (method === "POST") {
			return { body: { id: "sesn_1", type: "session" } }
		}
		const one = /^\/v1\/vaults\/([^/?]+)\/credentials\/([^/?]+)$/u.exec(path)
		if (one !== null) {
			if (state.failing.has(one[2] ?? "")) {
				return down
			}
			const found = state.existing.credentials.find((held) => held.id === one[2])
			return found === undefined ? gone : { body: found }
		}
		const held = /^\/v1\/vaults\/([^/?]+)\/credentials/u.exec(path)?.[1]
		if (held !== undefined) {
			if (state.failingLists.has(held)) {
				return down
			}
			if (state.goneLists.has(held)) {
				return gone
			}
			return { body: page(state.credentials.get(held) ?? []) }
		}
		const id = /^\/v1\/vaults\/([^/?]+)$/u.exec(path)?.[1]
		if (id !== undefined) {
			if (state.failing.has(id)) {
				return down
			}
			const found = state.existing.vaults.find((vault) => vault.id === id)
			return found === undefined ? gone : { body: found }
		}
		if (path.startsWith("/v1/vaults")) {
			return state.vaultsDown ? down : { body: page(state.vaults) }
		}
		if (path.startsWith("/v1/environments")) {
			return { body: page([{ id: "env_1", type: "environment", name: "Default" }]) }
		}
		return { body: page([state.agent]) }
	})
	return { state, started: () => sent.filter((request) => request.method === "POST") }
}

const open = async () => {
	const mounted = await mount(
		<Suspense fallback={null}>
			<NewSessionPage />
		</Suspense>,
	)
	await settle()
	return mounted
}

const check = async (container: HTMLElement, label: string): Promise<void> => {
	const box = [...container.querySelectorAll("label")]
		.find((candidate) => candidate.textContent?.includes(label) === true)
		?.querySelector("input")
	if (box === null || box === undefined) {
		throw new Error(`No checkbox "${label}".`)
	}
	await click(box)
}

const credentialSelect = (container: HTMLElement): HTMLSelectElement => {
	const select = [...container.querySelectorAll("select")].find((candidate) =>
		[...candidate.options].some((option) => option.textContent?.includes("Match from") === true),
	)
	if (select === undefined) {
		throw new Error("No credential field.")
	}
	return select
}

const choose = async (select: HTMLSelectElement, value: string): Promise<void> => {
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value)
		select.dispatchEvent(new Event("change", { bubbles: true }))
	})
	await settle()
}

const refetch = async (mounted: Awaited<ReturnType<typeof open>>): Promise<void> => {
	await act(async () => {
		await mounted.queryClient.invalidateQueries()
	})
	await settle()
}

afterEach(() => {
	vi.unstubAllGlobals()
	document.body.innerHTML = ""
})

describe("starting a session", () => {
	it("pins the agent version the form showed, though the agent changed before submit", async () => {
		const api = server()
		const mounted = await open()
		await check(mounted.container, "Vault vlt_work")
		api.state.agent = {
			...agent,
			version: 2,
			mcp_servers: [{ type: "url", name: "github", url: "https://mcp.other.example/mcp" }],
		}
		await submit(mounted.container.querySelector("form"))
		expect(api.started().map((request) => request.body)).toEqual([
			{
				agent: { id: "agent_1", version: 1 },
				environment_id: "env_1",
				title: null,
				vault_ids: ["vlt_work"],
			},
		])
		mounted.unmount()
	})
})

describe("starting a session with a choice that stops existing", () => {
	it("keeps a credential archived elsewhere in view, and starts nothing until it is replaced", async () => {
		const api = server()
		const mounted = await open()
		await check(mounted.container, "Vault vlt_work")
		await check(mounted.container, "Vault vlt_personal")
		await choose(credentialSelect(mounted.container), "vcrd_work")

		api.state.credentials.set("vlt_work", [])
		api.state.existing.credentials = [
			{ ...credential("vcrd_work", "vlt_work"), custody: "erased", archived_at: AT },
			credential("vcrd_personal", "vlt_personal"),
		]
		await refetch(mounted)

		expect(mounted.container.textContent).toContain(
			"The credential chosen for github is no longer available.",
		)
		expect(credentialSelect(mounted.container).value).toBe("vcrd_work")
		expect(button(mounted.container, "Start session").disabled).toBe(true)
		await submit(mounted.container.querySelector("form"))
		expect(api.started()).toEqual([])

		await choose(credentialSelect(mounted.container), "")
		expect(button(mounted.container, "Start session").disabled).toBe(false)
		await submit(mounted.container.querySelector("form"))
		expect(api.started().map((request) => request.body)).toEqual([
			{
				agent: { id: "agent_1", version: 1 },
				environment_id: "env_1",
				title: null,
				vault_ids: ["vlt_work", "vlt_personal"],
			},
		])
		mounted.unmount()
	})

	it("keeps a vault archived elsewhere in view with a way to remove it, and sends it no more", async () => {
		const api = server()
		const mounted = await open()
		await check(mounted.container, "Vault vlt_work")
		await check(mounted.container, "Vault vlt_personal")

		api.state.vaults = [{ ...vault("vlt_work"), archived_at: AT }, vault("vlt_personal")]
		api.state.existing.vaults = api.state.vaults
		await refetch(mounted)

		expect(mounted.container.textContent).toContain("is no longer available.")
		expect(button(mounted.container, "Start session").disabled).toBe(true)
		await submit(mounted.container.querySelector("form"))
		expect(api.started()).toEqual([])

		await click(button(mounted.container, "Remove"))
		expect(mounted.container.textContent).not.toContain("is no longer available.")
		await submit(mounted.container.querySelector("form"))
		expect(api.started().map((request) => request.body)).toEqual([
			{
				agent: { id: "agent_1", version: 1 },
				environment_id: "env_1",
				title: null,
				vault_ids: ["vlt_personal"],
			},
		])
		mounted.unmount()
	})

	it("says the same of a vault deleted elsewhere", async () => {
		const api = server()
		const mounted = await open()
		await check(mounted.container, "Vault vlt_work")

		api.state.vaults = [vault("vlt_personal")]
		api.state.existing.vaults = [vault("vlt_personal")]
		await refetch(mounted)

		expect(mounted.container.textContent).toContain("is no longer available.")
		expect(button(mounted.container, "Start session").disabled).toBe(true)
		mounted.unmount()
	})

	it("keeps a chosen vault that only fell off the loaded page of vaults", async () => {
		const api = server()
		const mounted = await open()
		await check(mounted.container, "Vault vlt_work")
		await check(mounted.container, "Vault vlt_personal")

		api.state.vaults = [vault("vlt_newer"), vault("vlt_personal")]
		await refetch(mounted)

		expect(mounted.container.textContent).not.toContain("is no longer available.")
		expect(mounted.container.textContent).toContain("Vault vlt_work")
		expect(button(mounted.container, "Start session").disabled).toBe(false)
		await submit(mounted.container.querySelector("form"))
		expect(api.started().map((request) => request.body)).toEqual([
			{
				agent: { id: "agent_1", version: 1 },
				environment_id: "env_1",
				title: null,
				vault_ids: ["vlt_work", "vlt_personal"],
			},
		])
		mounted.unmount()
	})

	it("keeps a credential chosen by hand when its vault is unchecked", async () => {
		const api = server()
		const mounted = await open()
		await check(mounted.container, "Vault vlt_work")
		await choose(credentialSelect(mounted.container), "vcrd_work")

		await check(mounted.container, "Vault vlt_work")

		expect(mounted.container.textContent).not.toContain("is no longer available.")
		expect(credentialSelect(mounted.container).value).toBe("vcrd_work")
		expect(button(mounted.container, "Start session").disabled).toBe(false)
		await submit(mounted.container.querySelector("form"))
		expect(api.started().map((request) => request.body)).toEqual([
			{
				agent: { id: "agent_1", version: 1 },
				environment_id: "env_1",
				title: null,
				mcp_server_credentials: [{ mcp_server_name: "github", credential_id: "vcrd_work" }],
			},
		])
		mounted.unmount()
	})

	it("marks a credential chosen by hand unavailable once its unchecked vault is archived", async () => {
		const api = server()
		const mounted = await open()
		await check(mounted.container, "Vault vlt_work")
		await choose(credentialSelect(mounted.container), "vcrd_work")
		await check(mounted.container, "Vault vlt_work")
		api.state.existing.vaults = [{ ...vault("vlt_work"), archived_at: AT }, vault("vlt_personal")]
		await refetch(mounted)

		expect(mounted.container.textContent).toContain(
			"The credential chosen for github is no longer available.",
		)
		expect(button(mounted.container, "Start session").disabled).toBe(true)
		mounted.unmount()
	})
})

describe("starting a session when the vaults cannot be listed", () => {
	it("starts an agent with no MCP servers, and asks for no vaults", async () => {
		const api = server()
		api.state.vaultsDown = true
		api.state.agent = { ...agent, mcp_servers: [] }
		const mounted = await open()
		expect(mounted.container.textContent).not.toContain("Vaults")
		await submit(mounted.container.querySelector("form"))
		expect(api.started()).toHaveLength(1)
		mounted.unmount()
	})

	it("says the vaults could not be loaded and lets the user retry, beside an agent's servers", async () => {
		const api = server()
		api.state.vaultsDown = true
		const mounted = await open()
		expect(mounted.container.textContent).toContain("The vaults could not be loaded")
		api.state.vaultsDown = false
		await click(button(mounted.container, "Retry"))
		await settle()
		expect(mounted.container.textContent).toContain("Vault vlt_work")
		mounted.unmount()
	})
})

const holdLookups = (): (() => void) => {
	const stubbed = globalThis.fetch
	let release = (): void => undefined
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
		if (/^\/v1\/vaults\/[^/?]+(?:\/credentials\/[^/?]+)?$/u.test(path)) {
			await gate
		}
		return stubbed(path, init)
	})
	return release
}

const withVaultOffPage = async (prepare: (api: ReturnType<typeof server>) => void) => {
	const api = server()
	const mounted = await open()
	await check(mounted.container, "Vault vlt_work")
	api.state.vaults = [vault("vlt_newer"), vault("vlt_personal")]
	prepare(api)
	await refetch(mounted)
	return { api, mounted }
}

const withCredentialOffList = async (prepare: (api: ReturnType<typeof server>) => void) => {
	const api = server()
	const mounted = await open()
	await check(mounted.container, "Vault vlt_work")
	await choose(credentialSelect(mounted.container), "vcrd_work")
	prepare(api)
	await check(mounted.container, "Vault vlt_work")
	return { api, mounted }
}

const START = "Start session"

describe("listing a chosen vault's credentials", () => {
	it("says a failed list failed instead of showing an empty vault, and lets the user retry it", async () => {
		const api = server()
		api.state.failingLists.add("vlt_work")
		const mounted = await open()
		await check(mounted.container, "Vault vlt_work")
		await settle()
		expect(mounted.container.textContent).toContain(
			"The credentials in vault vlt_work could not be loaded.",
		)
		expect(button(mounted.container, START).disabled).toBe(true)
		await submit(mounted.container.querySelector("form"))
		expect(api.started()).toEqual([])

		api.state.failingLists.clear()
		await click(button(mounted.container, "Retry"))
		await settle()
		expect(mounted.container.textContent).not.toContain("could not be loaded")
		expect(credentialSelect(mounted.container)?.textContent).toContain("Credential vcrd_work")
		expect(button(mounted.container, START).disabled).toBe(false)
		mounted.unmount()
	})

	it("treats a vault whose credentials are gone as unavailable, and lets the user remove it", async () => {
		const api = server()
		api.state.goneLists.add("vlt_work")
		const mounted = await open()
		await check(mounted.container, "Vault vlt_work")
		await settle()
		expect(mounted.container.textContent).toContain("is no longer available.")
		expect(button(mounted.container, START).disabled).toBe(true)
		await submit(mounted.container.querySelector("form"))
		expect(api.started()).toEqual([])

		await click(button(mounted.container, "Remove"))
		await settle()
		expect(mounted.container.textContent).not.toContain("is no longer available.")
		expect(button(mounted.container, START).disabled).toBe(false)
		mounted.unmount()
	})

	it("treats a failed recheck as failed though its last list is cached, and lets the user retry it", async () => {
		const api = server()
		const mounted = await open()
		await check(mounted.container, "Vault vlt_work")
		await settle()
		expect(button(mounted.container, START).disabled).toBe(false)

		api.state.failingLists.add("vlt_work")
		await refetch(mounted)
		expect(mounted.container.textContent).toContain(
			"The credentials in vault vlt_work could not be loaded.",
		)
		expect(button(mounted.container, START).disabled).toBe(true)

		api.state.failingLists.clear()
		await click(button(mounted.container, "Retry"))
		await settle()
		expect(mounted.container.textContent).not.toContain("could not be loaded")
		expect(button(mounted.container, START).disabled).toBe(false)
		mounted.unmount()
	})
})

describe("reading a chosen vault by its id", () => {
	it("waits while the read is under way, then offers the vault", async () => {
		let release = (): void => undefined
		const { api, mounted } = await withVaultOffPage(() => {
			release = holdLookups()
		})
		expect(mounted.container.textContent).toContain("Checking your choices")
		expect(button(mounted.container, START).disabled).toBe(true)
		await submit(mounted.container.querySelector("form"))
		expect(api.started()).toEqual([])

		release()
		await settle()
		expect(mounted.container.textContent).not.toContain("Checking your choices")
		expect(mounted.container.textContent).toContain("Vault vlt_work")
		expect(button(mounted.container, START).disabled).toBe(false)
		mounted.unmount()
	})

	it("says a failed read failed, and lets the user retry it", async () => {
		const { api, mounted } = await withVaultOffPage((api) => api.state.failing.add("vlt_work"))
		expect(mounted.container.textContent).toContain("could not be checked")
		expect(mounted.container.textContent).not.toContain("Checking your choices")
		expect(mounted.container.textContent).not.toContain("is no longer available.")
		expect(button(mounted.container, START).disabled).toBe(true)
		await submit(mounted.container.querySelector("form"))
		expect(api.started()).toEqual([])

		api.state.failing.clear()
		await click(button(mounted.container, "Retry"))
		expect(mounted.container.textContent).not.toContain("could not be checked")
		expect(button(mounted.container, START).disabled).toBe(false)
		await submit(mounted.container.querySelector("form"))
		expect(api.started().map((request) => request.body)).toMatchObject([
			{ vault_ids: ["vlt_work"] },
		])
		mounted.unmount()
	})

	it("lets the user remove a vault whose read failed", async () => {
		const { api, mounted } = await withVaultOffPage((api) => api.state.failing.add("vlt_work"))
		await click(button(mounted.container, "Remove"))
		expect(mounted.container.textContent).not.toContain("could not be checked")
		expect(button(mounted.container, START).disabled).toBe(false)
		await submit(mounted.container.querySelector("form"))
		expect(api.started().map((request) => request.body)).toEqual([
			{ agent: { id: "agent_1", version: 1 }, environment_id: "env_1", title: null },
		])
		mounted.unmount()
	})

	it("believes a 404 over the vault it read before", async () => {
		const { api, mounted } = await withVaultOffPage(() => undefined)
		expect(button(mounted.container, START).disabled).toBe(false)

		api.state.existing.vaults = [vault("vlt_personal")]
		await refetch(mounted)
		expect(mounted.container.textContent).toContain("is no longer available.")
		expect(button(mounted.container, START).disabled).toBe(true)
		await submit(mounted.container.querySelector("form"))
		expect(api.started()).toEqual([])
		mounted.unmount()
	})
})

describe("reading a chosen credential by its id", () => {
	it("waits while the read is under way, then keeps the credential chosen", async () => {
		let release = (): void => undefined
		const { api, mounted } = await withCredentialOffList(() => {
			release = holdLookups()
		})
		expect(mounted.container.textContent).toContain("Checking your choices")
		expect(button(mounted.container, START).disabled).toBe(true)
		await submit(mounted.container.querySelector("form"))
		expect(api.started()).toEqual([])

		release()
		await settle()
		expect(credentialSelect(mounted.container).value).toBe("vcrd_work")
		expect(button(mounted.container, START).disabled).toBe(false)
		mounted.unmount()
	})

	it("says a failed read failed, keeps the choice, and lets the user retry it", async () => {
		const { api, mounted } = await withCredentialOffList((api) =>
			api.state.failing.add("vcrd_work"),
		)
		expect(mounted.container.textContent).toContain(
			"The credential chosen for github could not be checked.",
		)
		expect(mounted.container.textContent).not.toContain("Checking your choices")
		expect(credentialSelect(mounted.container).value).toBe("vcrd_work")
		expect(button(mounted.container, START).disabled).toBe(true)
		await submit(mounted.container.querySelector("form"))
		expect(api.started()).toEqual([])

		api.state.failing.clear()
		await click(button(mounted.container, "Retry"))
		expect(mounted.container.textContent).not.toContain("could not be checked")
		expect(button(mounted.container, START).disabled).toBe(false)
		await submit(mounted.container.querySelector("form"))
		expect(api.started().map((request) => request.body)).toMatchObject([
			{ mcp_server_credentials: [{ mcp_server_name: "github", credential_id: "vcrd_work" }] },
		])
		mounted.unmount()
	})

	it("lets the user drop a credential whose read failed for automatic matching", async () => {
		const { api, mounted } = await withCredentialOffList((api) =>
			api.state.failing.add("vcrd_work"),
		)
		await choose(credentialSelect(mounted.container), "")
		expect(mounted.container.textContent).not.toContain("could not be checked")
		expect(button(mounted.container, START).disabled).toBe(false)
		expect(api.started()).toEqual([])
		mounted.unmount()
	})

	it("believes a 404 over the credential it read before", async () => {
		const { api, mounted } = await withCredentialOffList(() => undefined)
		expect(button(mounted.container, START).disabled).toBe(false)

		api.state.existing.credentials = [credential("vcrd_personal", "vlt_personal")]
		api.state.credentials.set("vlt_work", [])
		await refetch(mounted)
		expect(mounted.container.textContent).toContain(
			"The credential chosen for github is no longer available.",
		)
		expect(credentialSelect(mounted.container).value).toBe("vcrd_work")
		expect(button(mounted.container, START).disabled).toBe(true)
		await submit(mounted.container.querySelector("form"))
		expect(api.started()).toEqual([])
		mounted.unmount()
	})
})
