// @vitest-environment happy-dom
import type { JsonVault, JsonVaultCredential } from "@checkfu/sdk/client"
import { createMemoryHistory, createRouter, useRouterState } from "@tanstack/react-router"
import type * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NewVaultPage, VaultView } from "../src/pages/vaults.tsx"
import { credentialPages, vaultChoices, vaultQuery, vaultsPage } from "../src/queries.ts"
import { routeTree } from "../src/routeTree.gen.ts"
import { button, click, mount, newQueryClient, settle, stubApi, submit, type } from "./dom.tsx"

const AT = "2026-11-24T00:00:00.000Z"
const TOKEN = "sk-live-do-not-show-9f3a"

const vault: JsonVault = {
	id: "vlt_1",
	type: "vault",
	display_name: "Acme",
	custody: { storing: 0, held: 1, erasing: 0 },
	created_at: AT,
	updated_at: AT,
	archived_at: null,
}

const credential: JsonVaultCredential = {
	id: "vcrd_1",
	type: "vault_credential",
	vault_id: "vlt_1",
	display_name: "GitHub",
	auth: { type: "static_bearer", mcp_server_url: "https://mcp.example.com/mcp" },
	custody: "held",
	created_at: AT,
	updated_at: AT,
	archived_at: null,
}

const pageOf = (credentials: ReadonlyArray<JsonVaultCredential>) => ({
	data: credentials,
	has_more: false,
	next_cursor: null,
})

const withCredentials = (credentials: ReadonlyArray<JsonVaultCredential>) => {
	const queryClient = newQueryClient()
	queryClient.setQueryData(credentialPages(vault.id).queryKey, {
		pages: [pageOf(credentials)],
		pageParams: [undefined],
	})
	return queryClient
}

function AtStart({ children }: { readonly children: React.ReactNode }): React.ReactNode {
	return useRouterState({ select: (state) => state.location.pathname }) === "/" ? children : null
}

const held = (container: HTMLElement, queryClient: ReturnType<typeof newQueryClient>): string =>
	[
		container.innerHTML,
		...[...container.querySelectorAll("input")].map((input) => input.value),
		JSON.stringify(
			queryClient
				.getQueryCache()
				.getAll()
				.map((query) => query.state.data),
		),
		JSON.stringify(
			queryClient
				.getMutationCache()
				.getAll()
				.map((mutation) => [mutation.state.variables, mutation.state.data]),
		),
	].join("\n")

afterEach(() => {
	vi.unstubAllGlobals()
	document.body.innerHTML = ""
})

describe("vault pages", () => {
	it("creates a vault from its trimmed name, once per submission, and opens it", async () => {
		const sent = stubApi(() => ({ body: { ...vault, id: "vlt_9" } }))
		const page = await mount(<NewVaultPage />)
		await type(page.container.querySelector("input"), "  Acme  ")
		await submit(page.container.querySelector("form"))
		expect(sent).toHaveLength(1)
		expect(sent[0]).toMatchObject({
			method: "POST",
			path: "/v1/vaults",
			body: { display_name: "Acme" },
		})
		expect(sent[0]?.headers.get("idempotency-key")).toBeTruthy()
		expect(page.router.state.location.pathname).toBe("/vaults/vlt_9")
		page.unmount()
	})

	it("sends a new credential's token to the API and keeps no copy of it", async () => {
		const saved = { ...credential, id: "vcrd_2", display_name: "Linear" }
		const sent = stubApi((request) =>
			request.method === "POST" ? { body: saved } : { body: pageOf([credential, saved]) },
		)
		const queryClient = withCredentials([credential])
		const page = await mount(<VaultView vault={vault} />, queryClient)
		const form = [...page.container.querySelectorAll("form")].find((candidate) =>
			candidate.textContent?.includes("Add a credential"),
		)
		const [name] = [...(form?.querySelectorAll<HTMLInputElement>("input:not([type])") ?? [])]
		await type(name ?? null, "Linear")
		await type(form?.querySelector('input[type="url"]') ?? null, "https://mcp.linear.app/mcp")
		await type(form?.querySelector('input[type="password"]') ?? null, TOKEN)
		await submit(form)

		const create = sent.find((request) => request.method === "POST")
		expect(create).toMatchObject({
			path: "/v1/vaults/vlt_1/credentials",
			body: {
				display_name: "Linear",
				auth: { type: "static_bearer", token: TOKEN, mcp_server_url: "https://mcp.linear.app/mcp" },
			},
		})
		expect(page.container.textContent).toContain("Linear")
		expect(held(page.container, queryClient)).not.toContain(TOKEN)
		page.unmount()
	})

	it("waits for a pending credential create until its token is stored", async () => {
		const reads: Array<string> = []
		stubApi((request) => {
			if (request.method === "POST") {
				return {
					status: 202,
					body: { id: "vcrd_2", type: "vault_credential", vault_id: "vlt_1", pending: true },
				}
			}
			if (request.path === "/v1/vaults/vlt_1/credentials/vcrd_2") {
				reads.push(request.path)
				return {
					body: {
						...credential,
						id: "vcrd_2",
						display_name: "Linear",
						custody: reads.length === 1 ? "storing" : "held",
					},
				}
			}
			return { body: pageOf([credential]) }
		})
		const queryClient = withCredentials([credential])
		const page = await mount(<VaultView vault={vault} />, queryClient)
		const form = [...page.container.querySelectorAll("form")].find((candidate) =>
			candidate.textContent?.includes("Add a credential"),
		)
		await type(form?.querySelector('input[type="url"]') ?? null, "https://mcp.linear.app/mcp")
		await type(form?.querySelector('input[type="password"]') ?? null, TOKEN)
		await submit(form)
		await vi.waitFor(() => expect(reads).toHaveLength(2), { timeout: 3000 })
		await vi.waitFor(() =>
			expect(form?.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(""),
		)
		page.unmount()
	})

	it("keeps the form when a credential is created without its token, and saving again sends the same key", async () => {
		const refusal =
			"Credential vcrd_2 was created, but its token was not stored. Send the token again: send the same request again."
		let attempts = 0
		const sent = stubApi((request) => {
			if (request.method !== "POST") {
				return { body: pageOf([credential]) }
			}
			attempts += 1
			return attempts === 1
				? { status: 503, body: { error: { type: "service_unavailable", message: refusal } } }
				: { body: { ...credential, id: "vcrd_2" } }
		})
		const queryClient = withCredentials([credential])
		const page = await mount(<VaultView vault={vault} />, queryClient)
		const form = [...page.container.querySelectorAll("form")].find((candidate) =>
			candidate.textContent?.includes("Add a credential"),
		)
		const secret = form?.querySelector<HTMLInputElement>('input[type="password"]') ?? null
		await type(form?.querySelector('input[type="url"]') ?? null, "https://mcp.linear.app/mcp")
		await type(secret, TOKEN)
		expect(page.container.innerHTML).not.toContain(TOKEN)
		await submit(form)
		expect(page.container.textContent).toContain(refusal)
		expect(secret?.value).toBe(TOKEN)
		expect(secret?.getAttribute("value")).toBeNull()
		expect(page.container.innerHTML).not.toContain(TOKEN)

		await submit(form)
		const creates = sent.filter((request) => request.method === "POST")
		expect(creates).toHaveLength(2)
		expect(creates[0]?.headers.get("idempotency-key")).toBeTruthy()
		expect(creates[1]?.headers.get("idempotency-key")).toBe(
			creates[0]?.headers.get("idempotency-key"),
		)
		expect(creates[1]?.body).toEqual(creates[0]?.body)
		expect(secret?.value).toBe("")
		expect(held(page.container, queryClient)).not.toContain(TOKEN)
		page.unmount()
	})

	it("keeps the API's own conflict, such as a full vault, without guessing at an earlier attempt", async () => {
		const full = "The vault already holds its maximum number of credentials."
		let attempts = 0
		stubApi((request) => {
			if (request.method !== "POST") {
				return { body: pageOf([credential]) }
			}
			attempts += 1
			return attempts === 1
				? { status: 503, body: { error: { type: "service_unavailable", message: "unavailable" } } }
				: { status: 409, body: { error: { type: "invalid_request_error", message: full } } }
		})
		const page = await mount(<VaultView vault={vault} />, withCredentials([credential]))
		const form = [...page.container.querySelectorAll("form")].find((candidate) =>
			candidate.textContent?.includes("Add a credential"),
		)
		const secret = form?.querySelector<HTMLInputElement>('input[type="password"]') ?? null
		await type(form?.querySelector('input[type="url"]') ?? null, "https://mcp.linear.app/mcp")
		await type(secret, TOKEN)
		await submit(form)
		await type(secret, `${TOKEN}-2`)
		await submit(form)
		expect(page.container.textContent).toContain(full)
		expect(page.container.textContent).not.toContain("may already have created this credential")
		page.unmount()
	})

	it("gives an edited token its own key, and says an earlier attempt may have created the credential", async () => {
		let attempts = 0
		const sent = stubApi((request) => {
			if (request.method !== "POST") {
				return { body: pageOf([credential]) }
			}
			attempts += 1
			return attempts === 1
				? { status: 503, body: { error: { type: "service_unavailable", message: "unavailable" } } }
				: {
						status: 409,
						body: {
							error: {
								type: "invalid_request_error",
								message: "The vault already holds an active credential for this MCP server URL.",
							},
						},
					}
		})
		const page = await mount(<VaultView vault={vault} />, withCredentials([credential]))
		const form = [...page.container.querySelectorAll("form")].find((candidate) =>
			candidate.textContent?.includes("Add a credential"),
		)
		const secret = form?.querySelector<HTMLInputElement>('input[type="password"]') ?? null
		await type(form?.querySelector('input[type="url"]') ?? null, "https://mcp.linear.app/mcp")
		await type(secret, TOKEN)
		await submit(form)
		await type(secret, `${TOKEN}-2`)
		await submit(form)
		const creates = sent.filter((request) => request.method === "POST")
		expect(creates).toHaveLength(2)
		expect(creates[1]?.headers.get("idempotency-key")).not.toBe(
			creates[0]?.headers.get("idempotency-key"),
		)
		expect(page.container.textContent).toContain("may already have created this credential")
		expect(page.container.textContent).toContain("Replace token")
		page.unmount()
	})

	it("keeps an unsure create for one URL from explaining another URL's conflict", async () => {
		let attempts = 0
		const taken = "The vault already holds an active credential for this MCP server URL."
		stubApi((request) => {
			if (request.method !== "POST") {
				return { body: pageOf([credential]) }
			}
			attempts += 1
			return attempts === 1
				? { status: 503, body: { error: { type: "service_unavailable", message: "unavailable" } } }
				: { status: 409, body: { error: { type: "invalid_request_error", message: taken } } }
		})
		const page = await mount(<VaultView vault={vault} />, withCredentials([credential]))
		const form = [...page.container.querySelectorAll("form")].find((candidate) =>
			candidate.textContent?.includes("Add a credential"),
		)
		const url = form?.querySelector<HTMLInputElement>('input[type="url"]') ?? null
		await type(url, "https://mcp.linear.app/mcp")
		await type(form?.querySelector<HTMLInputElement>('input[type="password"]') ?? null, TOKEN)
		await submit(form)
		await type(url, "https://mcp.example.com/mcp")
		await submit(form)
		expect(attempts).toBe(2)
		expect(page.container.textContent).toContain(taken)
		expect(page.container.textContent).not.toContain("may already have created this credential")
		page.unmount()
	})

	it("freezes the replacement token while it is being saved", async () => {
		let release = (): void => undefined
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
		vi.stubGlobal("fetch", async (_path: string, init: RequestInit = {}) => {
			if ((init.method ?? "GET") !== "POST") {
				return json(pageOf([credential]))
			}
			await new Promise<void>((resolve) => {
				release = resolve
			})
			return json(credential)
		})
		const page = await mount(<VaultView vault={vault} />, withCredentials([credential]))
		await click(button(page.container, "Replace token"))
		const field = page.container.querySelector<HTMLInputElement>('td input[type="password"]')
		await type(field, TOKEN)
		await submit(field?.closest("form"))
		expect(field?.closest("fieldset")?.disabled).toBe(true)
		release()
		await settle()
		expect(page.container.querySelector('td input[type="password"]')).toBeNull()
		page.unmount()
	})

	it("closes a token being replaced once its credential is archived", async () => {
		stubApi(() => ({ body: pageOf([credential]) }))
		const queryClient = withCredentials([credential])
		const page = await mount(<VaultView vault={vault} />, queryClient)
		await click(button(page.container, "Replace token"))
		await type(page.container.querySelector<HTMLInputElement>('td input[type="password"]'), TOKEN)
		queryClient.setQueryData(credentialPages(vault.id).queryKey, {
			pages: [pageOf([{ ...credential, archived_at: AT, custody: "erasing" as const }])],
			pageParams: [undefined],
		})
		await settle()
		expect(page.container.querySelector('td input[type="password"]')).toBeNull()
		expect(page.container.textContent).not.toContain("Save new token")
		page.unmount()
	})

	it("says how many secrets are still being erased, whether or not their rows are listed", async () => {
		stubApi(() => ({ body: pageOf([]) }))
		const erasing = { ...vault, custody: { storing: 0, held: 0, erasing: 2 } }
		const page = await mount(<VaultView vault={erasing} />, withCredentials([]))
		expect(page.container.textContent).toContain("2 secrets are still being erased.")
		page.unmount()
	})

	it("loads exactly the queries the vault's page reads, once each", async () => {
		const sent = stubApi((request) =>
			request.path.includes("/credentials") ? { body: pageOf([credential]) } : { body: vault },
		)
		const queryClient = newQueryClient()
		const router = createRouter({
			routeTree,
			context: { queryClient },
			history: createMemoryHistory({ initialEntries: ["/vaults/vlt_1"] }),
		})
		await router.load()
		expect(
			sent.map((request) => request.path).filter((path) => path.startsWith("/v1/vaults")),
		).toEqual([
			"/v1/vaults/vlt_1",
			"/v1/vaults/vlt_1/credentials?limit=100&order=desc&include_archived=true",
		])
		expect(queryClient.getQueryData(credentialPages(vault.id).queryKey)?.pages).toEqual([
			pageOf([credential]),
		])
	})

	it("reaches a credential older than the first page", async () => {
		const older = { ...credential, id: "vcrd_old", display_name: "Older" }
		const sent = stubApi((request) =>
			request.path.includes("after=cursor-1")
				? { body: pageOf([older]) }
				: { body: { data: [credential], has_more: true, next_cursor: "cursor-1" } },
		)
		const queryClient = newQueryClient()
		queryClient.setQueryData(credentialPages(vault.id).queryKey, {
			pages: [{ data: [credential], has_more: true, next_cursor: "cursor-1" }],
			pageParams: [undefined],
		})
		const page = await mount(<VaultView vault={vault} />, queryClient)
		expect(page.container.textContent).not.toContain("Older")
		await click(button(page.container, "Load older credentials"))
		const last = new URL(sent.at(-1)?.path ?? "", "http://dashboard.test")
		expect(last.pathname).toBe("/v1/vaults/vlt_1/credentials")
		expect(Object.fromEntries(last.searchParams)).toEqual({
			limit: "100",
			order: "desc",
			include_archived: "true",
			after: "cursor-1",
		})
		const rows = [...page.container.querySelectorAll<HTMLElement>("tbody tr")]
		expect(rows.map((row) => row.querySelector("td")?.textContent)).toEqual(["GitHub", "Older"])
		expect(button(rows[1] ?? page.container, "Replace token").closest("tr")).toBe(rows[1])
		page.unmount()
	})

	it("replaces a token in a password field, then closes it without keeping the token", async () => {
		const sent = stubApi((request) =>
			request.method === "POST"
				? { body: { ...credential, updated_at: "2026-11-24T01:00:00.000Z" } }
				: { body: pageOf([credential]) },
		)
		const queryClient = withCredentials([credential])
		const page = await mount(<VaultView vault={vault} />, queryClient)
		await click(button(page.container, "Replace token"))
		const field = page.container.querySelector<HTMLInputElement>('td input[type="password"]')
		expect(field?.autocomplete).toBe("off")
		await type(field, TOKEN)
		await submit(field?.closest("form"))

		expect(sent.find((request) => request.method === "POST")).toMatchObject({
			path: "/v1/vaults/vlt_1/credentials/vcrd_1",
			body: { auth: { type: "static_bearer", token: TOKEN } },
		})
		expect(page.container.querySelector('td input[type="password"]')).toBeNull()
		expect(held(page.container, queryClient)).not.toContain(TOKEN)
		page.unmount()
	})

	it("never writes a token being replaced into the markup, even when the save fails, and clears it on cancel", async () => {
		stubApi((request) =>
			request.method === "POST"
				? { status: 503, body: { error: { type: "service_unavailable", message: "try again" } } }
				: { body: pageOf([credential]) },
		)
		const queryClient = withCredentials([credential])
		const page = await mount(<VaultView vault={vault} />, queryClient)
		await click(button(page.container, "Replace token"))
		const field = page.container.querySelector<HTMLInputElement>('td input[type="password"]')
		await type(field, TOKEN)
		expect(page.container.innerHTML).not.toContain(TOKEN)
		await submit(field?.closest("form"))
		expect(page.container.textContent).toContain("try again")
		expect(field?.getAttribute("value")).toBeNull()
		expect(page.container.innerHTML).not.toContain(TOKEN)

		await click(button(page.container, "Cancel"))
		expect(field?.value).toBe("")
		await click(button(page.container, "Replace token"))
		const reopened = page.container.querySelector<HTMLInputElement>('td input[type="password"]')
		expect(reopened?.value).toBe("")
		page.unmount()
	})

	it("shows where each secret stands as the API reports it", async () => {
		stubApi(() => ({ body: pageOf([]) }))
		const erasing = { ...credential, id: "vcrd_2", archived_at: AT, custody: "erasing" as const }
		const erased = { ...credential, id: "vcrd_3", archived_at: AT, custody: "erased" as const }
		const page = await mount(
			<VaultView vault={{ ...vault, custody: { storing: 0, held: 1, erasing: 1 } }} />,
			withCredentials([credential, erasing, erased]),
		)
		const secrets = [...page.container.querySelectorAll("tbody tr")].map(
			(row) => row.querySelectorAll("td")[3]?.textContent,
		)
		expect(secrets).toEqual(["Held", "Erasing", "Erased"])
		expect(page.container.textContent).toContain("Secrets being erased1")
		expect(page.container.textContent).not.toContain("nothing can use the secret")
		page.unmount()
	})

	it("keeps refreshing an ended vault's credentials until every row is erased", async () => {
		const polls = (vaultEnded: boolean, rows: ReadonlyArray<JsonVaultCredential>) => {
			const interval = credentialPages(vault.id, vaultEnded).refetchInterval
			const query = { state: { data: { pages: [pageOf(rows)], pageParams: [undefined] } } }
			return typeof interval === "function"
				? interval(query as unknown as Parameters<typeof interval>[0])
				: interval
		}
		const erased = { ...credential, archived_at: AT, custody: "erased" as const }
		expect(polls(true, [credential])).toBeGreaterThan(0)
		expect(polls(true, [{ ...credential, custody: "storing" }])).toBeGreaterThan(0)
		expect(polls(true, [erased])).toBe(false)
		expect(polls(false, [credential])).toBe(false)
		const ended = { ...vault, archived_at: AT, custody: { storing: 0, held: 1, erasing: 0 } }
		const vaultPolls = vaultQuery(vault.id).refetchInterval
		const vaultState = (data: JsonVault) => ({ state: { data } })
		expect(
			typeof vaultPolls === "function"
				? vaultPolls(vaultState(ended) as unknown as Parameters<typeof vaultPolls>[0])
				: vaultPolls,
		).toBeGreaterThan(0)

		stubApi(() => ({ body: pageOf([erased]) }))
		const page = await mount(
			<VaultView vault={{ ...ended, custody: { storing: 0, held: 0, erasing: 0 } }} />,
			withCredentials([erased]),
		)
		expect(page.container.textContent).toContain("Erased")
		expect([...page.container.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
			"Replace token",
		)
		page.unmount()
	})

	it("lists archived vaults on the vaults page, and only active ones to choose for a session", async () => {
		const sent = stubApi(() => ({ body: { data: [], has_more: false, next_cursor: null } }))
		const queryClient = newQueryClient()
		await queryClient.fetchQuery(vaultsPage())
		await queryClient.fetchInfiniteQuery(vaultChoices)
		const [management, picker] = sent.map((request) => request.path)
		expect(management).toContain("include_archived=true")
		expect(picker).not.toContain("include_archived")
	})

	it("takes a credential archive whose erasure is still under way as done, and shows it erasing", async () => {
		const archived = { ...credential, archived_at: AT, custody: "erasing" as const }
		const sent = stubApi((request) => {
			if (request.method === "POST" && request.path.endsWith("/archive")) {
				return {
					status: 202,
					body: { id: credential.id, type: "vault_credential", vault_id: vault.id, pending: true },
				}
			}
			if (request.path === `/v1/vaults/${vault.id}/credentials/${credential.id}`) {
				return { body: archived }
			}
			return request.path.includes("/credentials")
				? { body: pageOf([archived]) }
				: { body: { ...vault, custody: { storing: 0, held: 0, erasing: 1 } } }
		})
		const page = await mount(<VaultView vault={vault} />, withCredentials([credential]))
		const row = page.container.querySelector<HTMLElement>("tbody tr")
		await click(button(row ?? page.container, "Archive"))
		await settle()
		const reads = sent.filter(
			(request) =>
				request.method === "GET" &&
				request.path === `/v1/vaults/${vault.id}/credentials/${credential.id}`,
		)
		expect(reads).toHaveLength(1)
		expect(page.container.textContent).not.toContain("not visible yet")
		expect(page.container.querySelector("tbody tr")?.textContent).toMatch(/erasing/iu)
		page.unmount()
	})

	it("deletes a credential and lists the vault's credentials again", async () => {
		const sent = stubApi((request) =>
			request.method === "DELETE"
				? { body: { id: credential.id, type: "vault_credential_deleted", custody: "erasing" } }
				: request.path.includes("/credentials")
					? { body: pageOf([]) }
					: { body: { ...vault, custody: { storing: 0, held: 0, erasing: 1 } } },
		)
		const page = await mount(<VaultView vault={vault} />, withCredentials([credential]))
		const row = page.container.querySelector<HTMLElement>("tbody tr")
		await click(button(row ?? page.container, "Delete"))
		expect(sent.find((request) => request.method === "DELETE")?.path).toBe(
			"/v1/vaults/vlt_1/credentials/vcrd_1",
		)
		expect(page.container.textContent).toContain("No credentials in this vault.")
		page.unmount()
	})

	it("leaves a deleted vault's page for the list, and asks for the vault no more", async () => {
		const sent = stubApi((request) =>
			request.method === "DELETE"
				? {
						body: {
							id: vault.id,
							type: "vault_deleted",
							custody: { storing: 0, held: 0, erasing: 1 },
						},
					}
				: request.path === "/v1/vaults/vlt_1" || request.path.includes("/credentials")
					? { status: 404, body: { error: { type: "not_found", message: "gone" } } }
					: { body: pageOf([]) },
		)
		const queryClient = withCredentials([credential])
		queryClient.setQueryData(vaultQuery(vault.id).queryKey, vault)
		const page = await mount(
			<AtStart>
				<VaultView vault={vault} />
			</AtStart>,
			queryClient,
		)
		const header = page.container.querySelector<HTMLElement>("header") ?? page.container
		await click(button(header, "Delete"))
		expect(sent.find((request) => request.method === "DELETE")?.path).toBe("/v1/vaults/vlt_1")
		expect(page.router.state.location.pathname).toBe("/vaults")
		expect(sent.filter((request) => request.method === "GET")).toEqual([])
		expect(queryClient.getQueryData(vaultQuery(vault.id).queryKey)).toBeUndefined()
		page.unmount()
	})

	it("offers only deletion for an archived credential", async () => {
		stubApi(() => ({ body: pageOf([]) }))
		const archived = { ...credential, archived_at: AT, custody: "erased" as const }
		const page = await mount(<VaultView vault={vault} />, withCredentials([archived]))
		const row = page.container.querySelector<HTMLElement>("tbody tr")
		const labels = [...(row?.querySelectorAll("button") ?? [])].map((each) =>
			each.textContent?.trim(),
		)
		expect(labels).toEqual(["Delete"])
		page.unmount()
	})
})
