import type { JsonAgent, JsonSession, JsonVault, JsonVaultCredential } from "@checkfu/sdk/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
	bindingsOf,
	goneSelections,
	hasGoneSelection,
	placeError,
	SessionBindings,
	SessionCredentialFields,
} from "../src/pages/session-bindings.tsx"
import type { VaultList } from "../src/pages/session-bindings.tsx"
import { credentialsQuery } from "../src/queries.ts"
import { reconcile } from "../src/selection.ts"
import { newQueryClient } from "./dom.tsx"

const AT = "2026-11-24T00:00:00.000Z"

const servers: JsonAgent["mcp_servers"] = [
	{ type: "url", name: "github", url: "https://mcp.github.com/mcp" },
	{ type: "url", name: "linear", url: "https://mcp.linear.app/mcp" },
]

const agent: JsonAgent = {
	type: "agent",
	id: "agent_1",
	version: 3,
	name: "Triage",
	model: { id: "claude-sonnet-5-5" },
	system: null,
	description: null,
	mcp_servers: servers,
	tools: [],
	created_at: AT,
	updated_at: AT,
	archived_at: null,
}

const vault = (id: string, archived = false): JsonVault => ({
	id,
	type: "vault",
	display_name: `Vault ${id}`,
	custody: { storing: 0, held: 0, erasing: 0 },
	created_at: AT,
	updated_at: AT,
	archived_at: archived ? AT : null,
})

const credential = (id: string, vaultId: string, url: string): JsonVaultCredential => ({
	id,
	type: "vault_credential",
	vault_id: vaultId,
	display_name: `Credential ${id}`,
	auth: { type: "static_bearer", mcp_server_url: url },
	custody: "held",
	created_at: AT,
	updated_at: AT,
	archived_at: null,
})

const work = credential("vcrd_work", "vlt_a", "https://mcp.github.com/mcp")
const personal = credential("vcrd_personal", "vlt_b", "https://mcp.github.com/mcp#ignored")
const linear = credential("vcrd_linear", "vlt_a", "https://mcp.linear.app/mcp")

const chosen = (picked: JsonVaultCredential) => ({
	credential_id: picked.id,
	vault_id: picked.vault_id,
})

const AMBIGUOUS =
	'More than one credential matches MCP server "github". Name one in mcp_server_credentials.'
const NETWORK =
	'MCP server "linear" (mcp.linear.app) is not allowed by the environment\'s network rules.'

const render = (
	message: string | undefined,
	list: Partial<VaultList> = {},
	held: {
		readonly a: ReadonlyArray<JsonVaultCredential>
		readonly b: ReadonlyArray<JsonVaultCredential>
	} = {
		a: [work, linear],
		b: [personal],
	},
) => {
	const queryClient = newQueryClient()
	const page = { has_more: false, next_cursor: null }
	queryClient.setQueryData(credentialsQuery("vlt_a").queryKey, { ...page, data: held.a })
	queryClient.setQueryData(credentialsQuery("vlt_b").queryKey, { ...page, data: held.b })
	return renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<SessionCredentialFields
				agent={agent}
				vaultList={{
					items: [vault("vlt_a"), vault("vlt_b"), vault("vlt_old", true)],
					more: null,
					loading: false,
					error: undefined,
					moreError: undefined,
					retry: () => undefined,
					...list,
				}}
				vaultIds={["vlt_a", "vlt_b"]}
				onVaults={() => undefined}
				explicit={{}}
				onExplicit={() => undefined}
				error={placeError(message, servers)}
			/>
		</QueryClientProvider>,
	)
}

describe("session credential bindings", () => {
	it("sends the chosen vaults, and an explicit credential only where it is for that server", () => {
		expect(
			bindingsOf(
				servers,
				["vlt_a", "vlt_b"],
				{ github: chosen(personal), linear: chosen(work), gone: chosen(linear) },
				[work, personal, linear],
			),
		).toEqual({
			vault_ids: ["vlt_a", "vlt_b"],
			mcp_server_credentials: [{ mcp_server_name: "github", credential_id: "vcrd_personal" }],
		})
		expect(bindingsOf(servers, [], {}, [])).toEqual({})
	})

	it("keeps apart the chosen ids that are no longer on offer", () => {
		expect(reconcile(["a", "b", "c"], [{ id: "c" }, { id: "a" }])).toEqual({
			kept: ["a", "c"],
			gone: ["b"],
		})
		expect(reconcile([], [{ id: "a" }])).toEqual({ kept: [], gone: [] })
	})

	it("names a chosen vault and a server's chosen credential that are not among the choices", () => {
		const vaults = [vault("vlt_a"), vault("vlt_b"), vault("vlt_old", true)]
		const nothing = goneSelections(servers, vaults, ["vlt_a"], { github: chosen(work) }, [work])
		expect(nothing).toEqual({ vaults: [], servers: [] })
		expect(hasGoneSelection(nothing)).toBe(false)

		const gone = goneSelections(
			servers,
			vaults,
			["vlt_a", "vlt_old", "vlt_deleted"],
			{ github: chosen(work), linear: chosen(personal) },
			[personal, linear],
		)
		expect(gone).toEqual({ vaults: ["vlt_old", "vlt_deleted"], servers: ["github", "linear"] })
		expect(hasGoneSelection(gone)).toBe(true)
	})

	it("offers each server the active vaults' credentials stored for its URL", () => {
		const html = render(undefined)
		expect(html).toContain("Vault vlt_a")
		expect(html).not.toContain("Vault vlt_old")
		const github = html.slice(
			html.indexOf("Credential for github"),
			html.indexOf("Credential for linear"),
		)
		expect(github).toContain("Credential vcrd_work")
		expect(github).toContain("Credential vcrd_personal")
		expect(github).not.toContain("Credential vcrd_linear")
	})

	it("names each credential's vault and id, so two with the same name can be told apart", () => {
		const html = render(
			undefined,
			{},
			{
				a: [{ ...work, display_name: "Work" }, linear],
				b: [{ ...personal, display_name: "Work" }],
			},
		)
		const github = html.slice(
			html.indexOf("Credential for github"),
			html.indexOf("Credential for linear"),
		)
		expect(github).toContain("Work · Vault vlt_a · ")
		expect(github).toContain("Work · Vault vlt_b · ")
		const labels = [...github.matchAll(/<option value="vcrd_[a-z]+">([^<]+)<\/option>/gu)].map(
			(match) => match[1],
		)
		expect(new Set(labels).size).toBe(labels.length)
	})

	it("keeps the loaded vaults and offers Retry when the next page fails", () => {
		const html = render(undefined, { more: () => undefined, moreError: "Service unavailable" })
		expect(html).toContain("Vault vlt_a")
		expect(html).toContain("More vaults could not be loaded: Service unavailable")
		expect(html).not.toContain("Load more vaults")
		expect(html).toContain("Retry")
		expect(render(undefined, { more: () => undefined })).toContain("Load more vaults")
	})

	it("puts the ambiguity refusal next to the server it names", () => {
		expect(placeError(AMBIGUOUS, servers)).toEqual({ server: "github", message: AMBIGUOUS })
		const html = render(AMBIGUOUS)
		const at = html.indexOf("More than one credential matches")
		expect(at).toBeGreaterThan(html.indexOf("Credential for github"))
		expect(at).toBeLessThan(html.indexOf("Credential for linear"))
	})

	it("says how to fix an environment's network refusal, next to that server", () => {
		const html = render(NETWORK)
		const at = html.indexOf("not allowed by the environment")
		expect(at).toBeGreaterThan(html.indexOf("Credential for linear"))
		expect(html).toContain("Allow its host in the environment")
	})

	it("leaves a refusal about no declared server with the form", () => {
		expect(placeError("Vault vlt_x is not an active vault.", servers)).toEqual({
			server: undefined,
			message: "Vault vlt_x is not an active vault.",
		})
	})

	it("shows the credential a session was given for each server that has one", () => {
		const session: JsonSession = {
			id: "sesn_1",
			type: "session",
			status: "idle",
			agent: { id: agent.id, version: agent.version },
			environment_id: "env_1",
			title: null,
			turn: 0,
			usage: { input_tokens: 0, output_tokens: 0 },
			mcp_server_credentials: [{ mcp_server_name: "github", credential_id: "vcrd_work" }],
			created_at: AT,
			updated_at: AT,
			archived_at: null,
		}
		const html = renderToStaticMarkup(<SessionBindings session={session} />)
		expect(html).toContain("MCP server github")
		expect(html).toContain("vcrd_work")
		expect(html).not.toContain("linear")
		expect(
			renderToStaticMarkup(
				<SessionBindings session={{ ...session, mcp_server_credentials: [] }} />,
			),
		).toBe("")
	})
})
