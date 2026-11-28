// @vitest-environment happy-dom
import type {
	JsonAgent,
	JsonArtifact,
	JsonMemoryStore,
	JsonVault,
	JsonVaultCredential,
} from "@checkfu/sdk/client"
import { MAX_SESSION_VAULTS } from "@checkfu/sdk/Limits"
import { act, Suspense } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NewSessionPage } from "../src/pages/new-session.tsx"
import { button, click, mount, settle, stubApi, submit, type } from "./dom.tsx"

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

const notes: JsonMemoryStore = {
	type: "memory_store",
	id: "mstore_notes",
	name: "Notes",
	description: "",
	created_at: AT,
	updated_at: AT,
	archived_at: null,
}
const report: JsonArtifact = {
	type: "artifact",
	id: "art_report",
	name: "Report",
	version: 2,
	capabilities: {},
	made_from: null,
	file_count: 0,
	total_bytes: 0,
	files: [],
	publication: null,
	created_at: AT,
	updated_at: AT,
}

const page = (data: ReadonlyArray<unknown>) => ({ data, next_page: null })

const server = () => {
	const fileId = "file_selected"
	const state = {
		vaults: [vault("vlt_work"), vault("vlt_personal")],
		credentials: new Map([
			["vlt_work", [credential("vcrd_work", "vlt_work")]],
			["vlt_personal", [credential("vcrd_personal", "vlt_personal")]],
		]),
		agent,
		others: [] as ReadonlyArray<JsonAgent>,
		failing: new Set<string>(),
		failingLists: new Set<string>(),
		vaultsDown: false,
		memoryStores: [notes],
		artifacts: [report],
		fileStatus: 200,
		createStatus: 200,
		mountListsDown: false,
		goneLists: new Set<string>(),
		existing: {
			memoryStores: [notes],
			artifacts: [report],
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
			if (state.createStatus === 404) {
				state.fileStatus = 404
				return {
					...gone,
					body: { error: { type: "not_found_error", message: "Saved file has been deleted." } },
				}
			}
			return { body: { id: "sesn_1", type: "session" } }
		}
		if (path === `/v1/files/${fileId}`) {
			if (state.fileStatus === 401) {
				return {
					status: 401,
					body: { error: { type: "authentication_error", message: "Signed out." } },
				}
			}
			return state.fileStatus === 404
				? gone
				: { body: { type: "file", id: fileId, filename: "input.bin" } }
		}
		const mount = /^\/v1\/(memory_stores|artifacts)\/([^/?]+)$/u.exec(path)
		if (mount !== null) {
			const id = mount[2] ?? ""
			if (state.failing.has(id)) {
				return down
			}
			const resources =
				mount[1] === "artifacts" ? state.existing.artifacts : state.existing.memoryStores
			const found = resources.find((resource) => resource.id === id)
			return found === undefined ? gone : { body: found }
		}
		if (path.startsWith("/v1/memory_stores") || path.startsWith("/v1/artifacts")) {
			const resources = path.startsWith("/v1/memory_stores") ? state.memoryStores : state.artifacts
			return state.mountListsDown ? down : { body: page(resources) }
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
		return { body: page([state.agent, ...state.others]) }
	})
	return { state, fileId, started: () => sent.filter((request) => request.method === "POST") }
}

const open = async (fileId?: string) => {
	const mounted = await mount(
		<Suspense fallback={null}>
			<NewSessionPage fileId={fileId} />
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
				agent: { type: "agent", id: "agent_1", version: 1 },
				environment_id: "env_1",
				title: null,
				vault_ids: ["vlt_work"],
			},
		])
		mounted.unmount()
	})
})

describe("switching to an agent with no MCP servers", () => {
	it("drops the vaults chosen for the earlier agent, and a failed lookup no longer blocks it", async () => {
		const api = server()
		api.state.others = [{ ...agent, id: "agent_plain", name: "Plain", mcp_servers: [] }]
		api.state.failingLists.add("vlt_work")
		const mounted = await open()
		await check(mounted.container, "Vault vlt_work")
		await settle()
		expect(button(mounted.container, START).disabled).toBe(true)

		const agentSelect = [...mounted.container.querySelectorAll("select")].find((select) =>
			[...select.options].some((option) => option.textContent?.includes("Plain") === true),
		)
		if (agentSelect === undefined) {
			throw new Error("No agent field.")
		}
		await choose(agentSelect, "agent_plain")
		expect(mounted.container.textContent).not.toContain("Vaults")
		expect(mounted.container.textContent).not.toContain("could not be loaded")
		expect(button(mounted.container, START).disabled).toBe(false)
		await submit(mounted.container.querySelector("form"))
		expect(api.started().map((request) => request.body)).toEqual([
			{
				agent: { type: "agent", id: "agent_plain", version: 1 },
				environment_id: "env_1",
				title: null,
			},
		])
		mounted.unmount()
	})
})

const agentField = (container: HTMLElement, name: string): HTMLSelectElement => {
	const select = [...container.querySelectorAll("select")].find((candidate) =>
		[...candidate.options].some((option) => option.textContent?.includes(name) === true),
	)
	if (select === undefined) {
		throw new Error("No agent field.")
	}
	return select
}

describe("switching between agents with MCP servers", () => {
	it("keeps no vault or credential chosen for one agent when another is selected", async () => {
		const api = server()
		api.state.others = [{ ...agent, id: "agent_second", name: "Second" }]
		const mounted = await open()
		await check(mounted.container, "Vault vlt_work")
		await choose(credentialSelect(mounted.container), "vcrd_work")

		await choose(agentField(mounted.container, "Second"), "agent_second")
		expect(credentialSelect(mounted.container).value).toBe("")
		await submit(mounted.container.querySelector("form"))
		expect(api.started().map((request) => request.body)).toEqual([
			{
				agent: { type: "agent", id: "agent_second", version: 1 },
				environment_id: "env_1",
				title: null,
			},
		])
		mounted.unmount()
	})
})

describe("refreshing the list of vaults", () => {
	it("shows a failed refresh with a retry, and rechecks a chosen vault by its own read", async () => {
		const api = server()
		const mounted = await open()
		await check(mounted.container, "Vault vlt_work")

		api.state.vaultsDown = true
		api.state.existing.vaults = [{ ...vault("vlt_work"), archived_at: AT }, vault("vlt_personal")]
		await refetch(mounted)

		expect(mounted.container.textContent).toContain("The vaults could not be loaded")
		expect(button(mounted.container, "Retry").disabled).toBe(false)
		expect(mounted.container.textContent).toContain("is no longer available.")
		expect(button(mounted.container, START).disabled).toBe(true)
		await submit(mounted.container.querySelector("form"))
		expect(api.started()).toEqual([])
		mounted.unmount()
	})
})

describe("choosing vaults for a session", () => {
	it("stops at the API's limit of vaults, says why, and keeps the chosen ones removable", async () => {
		const api = server()
		const many = Array.from({ length: MAX_SESSION_VAULTS + 1 }, (_, index) =>
			vault(`vlt_${String(index).padStart(2, "0")}`),
		)
		api.state.vaults = many
		api.state.existing.vaults = many
		const mounted = await open()
		for (const chosen of many.slice(0, MAX_SESSION_VAULTS)) {
			await check(mounted.container, chosen.display_name)
		}
		const last = many[MAX_SESSION_VAULTS]
		const boxOf = (label: string) =>
			[...mounted.container.querySelectorAll("label")]
				.find((candidate) => candidate.textContent?.includes(label) === true)
				?.querySelector("input")
		expect(boxOf(last?.display_name ?? "")?.disabled).toBe(true)
		expect(boxOf(many[0]?.display_name ?? "")?.disabled).toBe(false)
		expect(mounted.container.textContent).toContain(
			`A session takes at most ${MAX_SESSION_VAULTS} vaults.`,
		)

		await check(mounted.container, many[0]?.display_name ?? "")
		expect(boxOf(last?.display_name ?? "")?.disabled).toBe(false)
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
				agent: { type: "agent", id: "agent_1", version: 1 },
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
				agent: { type: "agent", id: "agent_1", version: 1 },
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
				agent: { type: "agent", id: "agent_1", version: 1 },
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
				agent: { type: "agent", id: "agent_1", version: 1 },
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
		const api = server()
		const mounted = await open()
		const release = holdLookups()
		await check(mounted.container, "Vault vlt_work")
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
			{ agent: { type: "agent", id: "agent_1", version: 1 }, environment_id: "env_1", title: null },
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

const chosenMount = (container: HTMLElement, id: string): HTMLSelectElement => {
	const field = [...container.querySelectorAll("select")].find((select) =>
		[...select.options].some((option) => option.value === id),
	)
	if (field === undefined) {
		throw new Error(`Selected mount field for ${id} disappeared.`)
	}
	return field
}

it.each(["deleted", "archived"] as const)(
	"blocks a selected mount when its store was %s",
	async (state) => {
		const api = server()
		const mounted = await open()
		await click(button(mounted.container, "Memory store"))
		await choose(chosenMount(mounted.container, notes.id), notes.id)
		expect(button(mounted.container, START).disabled).toBe(false)
		api.state.memoryStores = []
		api.state.existing.memoryStores = state === "deleted" ? [] : [{ ...notes, archived_at: AT }]
		await refetch(mounted)
		expect(chosenMount(mounted.container, notes.id).value).toBe(notes.id)
		expect(mounted.container.textContent).toContain("The store you chose is no longer available.")
		expect(button(mounted.container, START).disabled).toBe(true)
		await submit(mounted.container.querySelector("form"))
		expect(api.started()).toEqual([])
		mounted.unmount()
	},
)

it.each(["Artifact files", "Skill"] as const)(
	"keeps selected %s when the listing fails and retries its detail",
	async (type) => {
		const api = server()
		const mounted = await open()
		await click(button(mounted.container, type))
		await choose(chosenMount(mounted.container, report.id), report.id)
		expect(button(mounted.container, START).disabled).toBe(false)
		api.state.artifacts = []
		api.state.mountListsDown = true
		api.state.failing.add(report.id)
		await refetch(mounted)
		expect(chosenMount(mounted.container, report.id).value).toBe(report.id)
		expect(button(mounted.container, START).disabled).toBe(true)
		await submit(mounted.container.querySelector("form"))
		expect(api.started()).toEqual([])
		api.state.failing.delete(report.id)
		await click(button(mounted.container, "Retry"))
		const field = chosenMount(mounted.container, report.id)
		expect(field.value).toBe(report.id)
		expect(field.selectedOptions[0]?.textContent).toBe("Report (v2)")
		expect(button(mounted.container, START).disabled).toBe(false)
		await submit(mounted.container.querySelector("form"))
		expect(api.started().map(({ body }) => body)).toEqual([
			expect.objectContaining({
				resources: [
					expect.objectContaining({
						type: type === "Skill" ? "skill" : "artifact",
						artifact_id: report.id,
					}),
				],
			}),
		])
		mounted.unmount()
	},
)

it("displays the checked version even when the picker still has an older listing", async () => {
	const api = server()
	api.state.existing.artifacts = [{ ...report, version: 3 }]
	const mounted = await open()
	await click(button(mounted.container, "Artifact files"))
	await choose(chosenMount(mounted.container, report.id), report.id)
	expect(chosenMount(mounted.container, report.id).selectedOptions[0]?.textContent).toBe(
		"Report (v3)",
	)
	expect(button(mounted.container, START).disabled).toBe(false)
	mounted.unmount()
})

it.each([
	[401, "Sign in again"],
	[404, "This saved file is no longer available."],
] as const)(
	"keeps a saved File draft recoverable after an unavailable metadata read (%i)",
	async (status, message) => {
		const { state, fileId, started } = server()
		state.fileStatus = status
		const page = await open(fileId)
		try {
			await vi.waitFor(() => expect(page.container.textContent).toContain(message))
			expect(button(page.container, "Start session").disabled).toBe(true)
			expect(started()).toEqual([])
			expect(page.container.querySelector('[aria-label="Remove file"]')).not.toBeNull()
		} finally {
			page.unmount()
		}
	},
)

it("retains the selected File and path when the owner refuses an explicit create", async () => {
	const { state, fileId, started } = server()
	const fetch = globalThis.fetch
	const refreshed = Promise.withResolvers<void>()
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		if (input === `/v1/files/${fileId}` && state.fileStatus === 404) {
			await refreshed.promise
		}
		return fetch(input, init)
	})
	const page = await open(fileId)
	try {
		await vi.waitFor(() => expect(page.container.textContent).toContain("input.bin · read-only"))
		const path = [...page.container.querySelectorAll("label")].find(
			(label) => label.textContent === "File mount path",
		)?.control
		if (!path || path.tagName !== "INPUT") {
			throw new Error("Missing File mount path input")
		}
		await type(path as HTMLInputElement, "reference/input.bin")
		state.createStatus = 404
		await click(button(page.container, "Start session"))
		await vi.waitFor(() =>
			expect(page.container.textContent).toContain("Saved file has been deleted."),
		)
		expect(started()).toHaveLength(1)
		expect(started()[0]?.body).toMatchObject({
			resources: [{ type: "file", file_id: fileId, mount_path: "reference/input.bin" }],
		})
		expect((path as HTMLInputElement).value).toBe("reference/input.bin")
		expect(page.container.textContent).toContain("Checking saved file…")
		expect(path.closest("fieldset")?.disabled).toBe(false)
		expect(button(page.container, "Start session").disabled).toBe(true)
		refreshed.resolve()
		await vi.waitFor(() =>
			expect(page.container.textContent).toContain("This saved file is no longer available."),
		)
		expect(button(page.container, "Start session").disabled).toBe(true)
	} finally {
		refreshed.resolve()
		page.unmount()
	}
})
