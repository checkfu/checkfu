import { Credential } from "@checkfu/domain/Vault/Credential.aggregate"
import { CredentialId } from "@checkfu/domain/Vault/Credential.id"
import { CredentialSecrets } from "@checkfu/domain/Vault/CredentialSecrets.external"
import { CredentialView } from "@checkfu/domain/Vault/CredentialView.view"
import { VaultId } from "@checkfu/domain/Vault/Vault.id"
import { credentialUrlClaimId } from "@checkfu/domain/Vault/CredentialUrlClaim.aggregate"
import { MAX_MCP_SERVER_URL_LENGTH, MAX_VAULT_CREDENTIALS } from "@checkfu/domain/Vault/VaultTypes"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import { credentialUsable } from "../src/Connection/CredentialCustody.ts"
import { makeVaultMcp } from "../src/Connection/VaultMcp.ts"
import type { VaultMcp } from "../src/Connection/VaultMcp.ts"
import { makeApiHandler } from "../src/Http/Router.ts"
import {
	AUTH_HEADERS,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendRequest,
} from "./helpers/ApiHarness.ts"
import { makeVaultsTestLayer } from "./helpers/VaultsHarness.ts"

const TOKEN = "tok_live_SECRET_do_not_leak_4f9a"
const ROTATED = "tok_live_ROTATED_do_not_leak_77c1"
const GITHUB = "https://mcp.github.example/mcp"
const SEALED = { secrets: [], sealed: true }

interface VaultBody {
	readonly id: string
	readonly type: string
	readonly display_name: string
	readonly custody: { readonly storing: number; readonly held: number; readonly erasing: number }
	readonly archived_at: string | null
	readonly updated_at: string
}
interface CredentialBody {
	readonly id: string
	readonly type: string
	readonly vault_id: string
	readonly auth: { readonly type: string; readonly mcp_server_url: string }
	readonly display_name: string | null
	readonly custody: "storing" | "held" | "erasing" | "erased"
	readonly archived_at: string | null
	readonly updated_at: string
}
interface CredentialPage {
	readonly data: ReadonlyArray<CredentialBody>
	readonly next_page: string | null
}

const world = (options: Parameters<typeof makeVaultsTestLayer>[0] = {}) => {
	const vaults = makeVaultsTestLayer(options)
	const logs: Array<unknown> = []
	const transcript: Array<string> = []
	const base = makePiDurableTestLayer(
		async (model) => makeAssistantReply(model, null, "unused", 1, 1),
		{ vaults: vaults.layer },
	)
	const layer = base.layer.pipe(
		Layer.provideMerge(
			Logger.layer([
				Logger.make(({ message, cause }) => {
					logs.push(message, String(cause))
				}),
			]),
		),
	)
	const run = async <A, E>(
		body: (api: {
			readonly call: (
				method: string,
				path: string,
				payload?: unknown,
				headers?: Record<string, string>,
			) => Effect.Effect<{ readonly status: number; readonly body: unknown }>
		}) => Effect.Effect<A, E, Layer.Success<typeof layer>>,
	): Promise<A> => {
		try {
			return await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					return yield* body({
						call: (method, path, payload, headers) =>
							Effect.gen(function* () {
								const res = yield* sendRequest(apiFetch, {
									method,
									path,
									headers: { ...AUTH_HEADERS, ...headers },
									...(payload === undefined ? {} : { body: payload }),
								})
								const text = yield* Effect.promise(() => res.text())
								transcript.push(text, JSON.stringify([...res.headers]))
								return { status: res.status, body: text.length === 0 ? null : JSON.parse(text) }
							}),
					})
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await base.closeAll()
		}
	}
	return { vaults, logs, transcript, run }
}

type Call = Parameters<Parameters<ReturnType<typeof world>["run"]>[0]>[0]["call"]

const createVault = (call: Call, display_name = "Alice") =>
	Effect.map(call("POST", "/v1/vaults", { display_name }), (res) => {
		expect(res.status).toBe(201)
		return res.body as VaultBody
	})

const createCredential = (
	call: Call,
	vaultId: string,
	mcp_server_url = GITHUB,
	extra: { readonly display_name?: string | null } = {},
) =>
	call("POST", `/v1/vaults/${vaultId}/credentials`, {
		auth: { type: "static_bearer", token: TOKEN, mcp_server_url },
		...extra,
	})

const listCredentials = (call: Call, vaultId: string, query: string, atLeast: number) =>
	call("GET", `/v1/vaults/${vaultId}/credentials${query}`).pipe(
		Effect.repeat({
			schedule: Schedule.spaced("5 millis"),
			times: 400,
			until: (res) => res.status === 200 && (res.body as CredentialPage).data.length >= atLeast,
		}),
		Effect.map((res) => {
			expect(res.status).toBe(200)
			return res.body as CredentialPage
		}),
	)

const custodyOf = (call: Call, path: string, custody: CredentialBody["custody"]) =>
	call("GET", path).pipe(
		Effect.repeat({
			schedule: Schedule.spaced("5 millis"),
			times: 400,
			until: (res) => (res.body as CredentialBody).custody === custody,
		}),
		Effect.map((res) => {
			expect(res).toMatchObject({ status: 200, body: { custody } })
			return res.body as CredentialBody
		}),
	)

const vaultCustody = (
	call: Call,
	vaultId: string,
	settled: (custody: VaultBody["custody"]) => boolean,
) =>
	call("GET", `/v1/vaults/${vaultId}`).pipe(
		Effect.repeat({
			schedule: Schedule.spaced("5 millis"),
			times: 400,
			until: (res) => settled((res.body as VaultBody).custody),
		}),
		Effect.map((res) => (res.body as VaultBody).custody),
	)

const settles = (condition: () => boolean) =>
	Effect.sync(condition).pipe(
		Effect.repeat({ schedule: Schedule.spaced("5 millis"), times: 400, until: (met) => met }),
		Effect.tap((met) =>
			Effect.sync(() => {
				expect(met).toBe(true)
			}),
		),
		Effect.asVoid,
	)

describe("Vaults", () => {
	it("lists vaults in creation order, a page at a time, leaving out archived and deleted ones unless asked", async () => {
		const { run } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const first = yield* createVault(call, "First")
				const second = yield* createVault(call, "Second")
				const third = yield* createVault(call, "Third")
				const gone = yield* createVault(call, "Gone")
				expect((yield* call("POST", `/v1/vaults/${second.id}/archive`)).status).toBe(200)
				expect((yield* call("DELETE", `/v1/vaults/${gone.id}`)).status).toBe(200)

				const names = (body: unknown) =>
					(body as { readonly data: ReadonlyArray<VaultBody> }).data.map(
						(vault) => vault.display_name,
					)
				const listed = (query: string) =>
					call("GET", `/v1/vaults${query}`).pipe(
						Effect.repeat({
							schedule: Schedule.spaced("5 millis"),
							times: 400,
							until: (res) => res.status === 200 && names(res.body).length > 0,
						}),
						Effect.map((res) => {
							expect(res.status).toBe(200)
							return res.body as {
								readonly data: ReadonlyArray<VaultBody>

								readonly next_page: string | null
							}
						}),
					)

				expect(names(yield* listed(""))).toEqual(["First", "Third"])
				expect(names(yield* listed("?order=desc"))).toEqual(["Third", "First"])
				expect(names(yield* listed("?include_archived=true"))).toEqual(["First", "Second", "Third"])

				const page = yield* listed("?limit=1")
				expect(names(page)).toEqual(["First"])
				expect(page.next_page).not.toBeNull()
				const next = yield* listed(`?limit=1&page=${encodeURIComponent(page.next_page ?? "")}`)
				expect(names(next)).toEqual(["Third"])
				expect(first.id).not.toBe(third.id)

				expect((yield* call("GET", "/v1/vaults?page=not-a-cursor")).status).toBe(400)
			}),
		)
	})

	it("creates, reads, renames, archives and deletes a vault", async () => {
		const { run } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				expect(vault).toMatchObject({
					type: "vault",
					display_name: "Alice",
					custody: { storing: 0, held: 0, erasing: 0 },
					archived_at: null,
				})
				expect(vault.id).toMatch(/^vlt_[0-9a-f]{24}$/u)
				expect(Object.keys(vault).sort()).toEqual([
					"archived_at",
					"created_at",
					"custody",
					"display_name",
					"id",
					"type",
					"updated_at",
				])

				const read = yield* call("GET", `/v1/vaults/${vault.id}`)
				expect(read).toEqual({ status: 200, body: vault })

				const renamed = yield* call("POST", `/v1/vaults/${vault.id}`, { display_name: "Alice B" })
				expect(renamed.status).toBe(200)
				expect(renamed.body).toMatchObject({ id: vault.id, display_name: "Alice B" })

				const unchanged = yield* call("POST", `/v1/vaults/${vault.id}`, {})
				expect(unchanged.body).toMatchObject({ display_name: "Alice B" })

				const archived = yield* call("POST", `/v1/vaults/${vault.id}/archive`)
				expect(archived.status).toBe(200)
				expect((archived.body as VaultBody).archived_at).not.toBeNull()
				const again = yield* call("POST", `/v1/vaults/${vault.id}/archive`)
				expect(again).toEqual(archived)

				const late = yield* call("POST", `/v1/vaults/${vault.id}`, { display_name: "Late" })
				expect(late.status).toBe(409)

				const gone = {
					status: 200,
					body: {
						id: vault.id,
						type: "vault_deleted",
						secrets: "erased",
						custody: { storing: 0, held: 0, erasing: 0 },
					},
				}
				expect(yield* call("DELETE", `/v1/vaults/${vault.id}`)).toEqual(gone)
				expect(yield* call("DELETE", `/v1/vaults/${vault.id}`)).toEqual(gone)
				for (const [method, path] of [
					["GET", `/v1/vaults/${vault.id}`],
					["POST", `/v1/vaults/${vault.id}/archive`],
					["GET", `/v1/vaults/${vault.id}/credentials`],
				] as const) {
					expect((yield* call(method, path)).status).toBe(404)
				}
				expect((yield* call("GET", "/v1/vaults/vlt_missing")).status).toBe(404)
				expect((yield* call("DELETE", "/v1/vaults/vlt_missing")).status).toBe(404)
				expect((yield* call("POST", "/v1/vaults", { display_name: "" })).status).toBe(400)
			}),
		)
	})

	it("creates one vault for one Idempotency-Key, and refuses the key with another body", async () => {
		const { run } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const key = { "idempotency-key": "vault-key-1" }
				const first = yield* call("POST", "/v1/vaults", { display_name: "Alice" }, key)
				expect(first.status).toBe(201)
				const id = (first.body as VaultBody).id
				expect(id).toMatch(/^vlt_[0-9a-f]{64}$/u)
				expect(yield* call("POST", "/v1/vaults", { display_name: "Alice" }, key)).toEqual(first)

				const reused = yield* call("POST", "/v1/vaults", { display_name: "Mallory" }, key)
				expect(reused.status).toBe(409)
				expect(JSON.stringify(reused.body)).toContain("Idempotency-Key")
				expect(yield* call("GET", `/v1/vaults/${id}`)).toEqual({ status: 200, body: first.body })

				const other = yield* call(
					"POST",
					"/v1/vaults",
					{ display_name: "Alice" },
					{ "idempotency-key": "vault-key-2" },
				)
				expect((other.body as VaultBody).id).not.toBe(id)
			}),
		)
	})

	it("stores a credential's secret with its connection and returns everything but the secret", async () => {
		const { run, vaults } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const created = yield* createCredential(
					call,
					vault.id,
					"https://MCP.GitHub.example/mcp#x",
					{
						display_name: "GitHub (work)",
					},
				)
				expect(created.status).toBe(201)
				const credential = created.body as CredentialBody
				expect(credential).toMatchObject({
					type: "vault_credential",
					vault_id: vault.id,
					auth: { type: "static_bearer", mcp_server_url: GITHUB },
					display_name: "GitHub (work)",
					custody: "held",
					archived_at: null,
				})
				expect(credential.id).toMatch(/^vcrd_[0-9a-f]{24}$/u)
				expect(Object.keys(credential.auth).sort()).toEqual(["mcp_server_url", "type"])
				expect(vaults.secretOf(credential.id)).toBe(TOKEN)
				expect(yield* credentialUsable(CredentialId.make(credential.id))).toBe(true)

				const read = yield* call("GET", `/v1/vaults/${vault.id}/credentials/${credential.id}`)
				expect(read).toEqual({ status: 200, body: credential })
				expect(yield* listCredentials(call, vault.id, "", 1)).toEqual({
					data: [credential],
					next_page: null,
				})
				expect(((yield* call("GET", `/v1/vaults/${vault.id}`)).body as VaultBody).custody).toEqual({
					storing: 0,
					held: 1,
					erasing: 0,
				})

				const renamed = yield* call("POST", `/v1/vaults/${vault.id}/credentials/${credential.id}`, {
					display_name: null,
				})
				expect(renamed.status).toBe(200)
				expect(renamed.body).toMatchObject({ id: credential.id, display_name: null })
				expect(vaults.secretOf(credential.id)).toBe(TOKEN)

				const rotated = yield* call("POST", `/v1/vaults/${vault.id}/credentials/${credential.id}`, {
					auth: { type: "static_bearer", token: ROTATED },
					display_name: "Rotated",
				})
				expect(rotated.status).toBe(200)
				expect(rotated.body).toMatchObject({ display_name: "Rotated", auth: credential.auth })
				expect(vaults.secretOf(credential.id)).toBe(ROTATED)

				const untouched = yield* call(
					"POST",
					`/v1/vaults/${vault.id}/credentials/${credential.id}`,
					{
						auth: { type: "static_bearer" },
					},
				)
				expect(untouched.status).toBe(200)
				expect(vaults.secretOf(credential.id)).toBe(ROTATED)
			}),
		)
	})

	it("creates one credential for one Idempotency-Key, and refuses the key with another body or secret", async () => {
		const { run, vaults } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const key = { "idempotency-key": "credential-key-1" }
				const body = {
					auth: { type: "static_bearer", token: TOKEN, mcp_server_url: GITHUB },
					display_name: "GitHub",
				}
				const path = `/v1/vaults/${vault.id}/credentials`
				const first = yield* call("POST", path, body, key)
				expect(first.status).toBe(201)
				const credential = first.body as CredentialBody
				expect(credential.id).toMatch(/^vcrd_[0-9a-f]{64}$/u)

				expect(yield* call("POST", path, body, key)).toEqual(first)
				expect((yield* listCredentials(call, vault.id, "", 1)).data).toHaveLength(1)
				expect(vaults.secretOf(credential.id)).toBe(TOKEN)

				for (const changed of [
					{ ...body, display_name: "Other" },
					{ ...body, auth: { ...body.auth, token: ROTATED } },
					{ ...body, auth: { ...body.auth, mcp_server_url: "https://mcp.linear.example/mcp" } },
				]) {
					const reused = yield* call("POST", path, changed, key)
					expect(reused.status).toBe(409)
					expect(reused.body).toMatchObject({ error: { code: "idempotency_key_reused" } })
					expect(JSON.stringify(reused.body)).toContain("Idempotency-Key")
				}
				expect(vaults.secretOf(credential.id)).toBe(TOKEN)
				expect(yield* credentialUsable(CredentialId.make(credential.id))).toBe(true)

				const rotate = (token: string) =>
					call("POST", `${path}/${credential.id}`, { auth: { type: "static_bearer", token } })
				expect((yield* rotate(ROTATED)).status).toBe(200)
				const replayed = yield* call("POST", path, body, key)
				expect(replayed.status).toBe(201)
				expect(replayed.body).toMatchObject({ id: credential.id, custody: "held" })
				expect(vaults.secretOf(credential.id)).toBe(ROTATED)
				const swapped = yield* call(
					"POST",
					path,
					{ ...body, auth: { ...body.auth, token: ROTATED } },
					key,
				)
				expect(swapped.status).toBe(409)
				expect(JSON.stringify(swapped.body)).toContain("Idempotency-Key")
				expect(vaults.secretOf(credential.id)).toBe(ROTATED)
				expect((yield* rotate(TOKEN)).status).toBe(200)

				const other = yield* createVault(call, "Bob")
				const elsewhere = yield* call("POST", `/v1/vaults/${other.id}/credentials`, body, key)
				expect(elsewhere.status).toBe(201)
				expect((elsewhere.body as CredentialBody).id).not.toBe(credential.id)

				const blocked = { "idempotency-key": "credential-key-2" }
				const duplicate = yield* call("POST", path, { ...body, display_name: "Again" }, blocked)
				expect(duplicate.status).toBe(409)
				expect(JSON.stringify(duplicate.body)).not.toContain("Idempotency-Key")
				expect((yield* call("POST", `${path}/${credential.id}/archive`, undefined)).status).toBe(
					200,
				)
				const retried = yield* call("POST", path, { ...body, display_name: "Again" }, blocked)
				expect(retried.status).toBe(201)
				expect(vaults.secretOf((retried.body as CredentialBody).id)).toBe(TOKEN)

				yield* settles(() => vaults.erased(credential.id))
				const late = yield* call("POST", path, body, key)
				expect(late.body).toMatchObject({ id: credential.id })
				expect((late.body as CredentialBody).archived_at).not.toBeNull()
				expect(vaults.secretOf(credential.id)).toBeNull()
			}),
		)
	})

	it("refuses URLs a bearer token must not be sent to, and unknown kinds of credential", async () => {
		const { run, transcript } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				for (const url of [
					"http://mcp.example.com/mcp",
					"https://user:pass@mcp.example.com/mcp",
					"ftp://mcp.example.com",
					"mcp.example.com",
					"https://",
					"https://[/mcp",
				]) {
					expect(`${url} -> ${(yield* createCredential(call, vault.id, url)).status}`).toBe(
						`${url} -> 400`,
					)
				}
				expect((yield* createCredential(call, vault.id, "http://127.0.0.1:8787/mcp")).status).toBe(
					201,
				)
				const unknownType = yield* call("POST", `/v1/vaults/${vault.id}/credentials`, {
					auth: { type: "api_key", token: TOKEN, mcp_server_url: GITHUB },
				})
				expect(unknownType.status).toBe(400)
				const listed = yield* listCredentials(call, vault.id, "", 1)
				expect(listed.data).toHaveLength(1)

				const credentialId = listed.data[0]?.id
				const auth = {
					type: "static_bearer",
					token: TOKEN,
					mcp_server_url: "https://mcp.gitlab.example/mcp",
				}
				for (const [path, body] of [
					["/v1/vaults", { display_name: "Bob", displayname: "Bob" }],
					[`/v1/vaults/${vault.id}`, { display_name: "Bob", metadata: {} }],
					[`/v1/vaults/${vault.id}/credentials`, { auth, displayname: "x" }],
					[`/v1/vaults/${vault.id}/credentials`, { auth: { ...auth, tokn: TOKEN } }],
					[`/v1/vaults/${vault.id}/credentials/${credentialId}`, { display_name: "x", url: "y" }],
					[
						`/v1/vaults/${vault.id}/credentials/${credentialId}`,
						{
							auth: {
								type: "static_bearer",
								token: TOKEN,
								mcp_server_url: "https://mcp.gitlab.example/mcp",
							},
						},
					],
				] as const) {
					expect(`${path} -> ${(yield* call("POST", path, body)).status}`).toBe(`${path} -> 400`)
				}
				expect(
					((yield* call("GET", `/v1/vaults/${vault.id}`)).body as VaultBody).custody.held,
				).toBe(1)
			}),
		)
		expect(transcript.join("\n")).not.toContain(TOKEN)
	})

	it("refuses a URL whose canonical spelling is too long, before anything is stored", async () => {
		const { run, vaults } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const grows = `https://mcp.example.com/${"é".repeat(700)}`
				expect(grows.length).toBeLessThan(MAX_MCP_SERVER_URL_LENGTH)
				expect(new URL(grows).href.length).toBeGreaterThan(MAX_MCP_SERVER_URL_LENGTH)
				const refused = yield* createCredential(call, vault.id, grows)
				expect(refused.status).toBe(400)
				expect(vaults.calls).toEqual([])
				expect(
					((yield* call("GET", `/v1/vaults/${vault.id}`)).body as VaultBody).custody.held,
				).toBe(0)

				const prefix = "https://mcp.example.com/"
				const longest = `${prefix}${"a".repeat(MAX_MCP_SERVER_URL_LENGTH - prefix.length)}`
				const created = yield* createCredential(call, vault.id, longest)
				expect(created.status).toBe(201)
				expect((created.body as CredentialBody).auth.mcp_server_url).toBe(longest)
				expect((yield* createCredential(call, vault.id, longest)).status).toBe(409)
				expect((yield* createCredential(call, vault.id, `${longest}a`)).status).toBe(400)
			}),
		)
	})

	it("holds one active credential per MCP server URL and stores nothing for a refused one", async () => {
		const { run, vaults } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const first = (yield* createCredential(call, vault.id)).body as CredentialBody
				const refused = yield* createCredential(call, vault.id, `${GITHUB}#again`)
				expect(refused.status).toBe(409)
				expect(refused.body).toMatchObject({
					error: {
						type: "conflict_error",
						message: "The vault already holds an active credential for this MCP server URL.",
						code: "credential_url_taken",
					},
				})
				expect(vaults.calls.filter((entry) => entry.operation === "put")).toHaveLength(1)
				expect(vaults.rowsOf(first.id).secrets).toEqual([first.id])
				expect(vaults.secretOf(first.id)).toBe(TOKEN)

				const other = yield* createVault(call, "Bob")
				expect((yield* createCredential(call, other.id)).status).toBe(201)

				expect(
					(yield* call("POST", `/v1/vaults/${vault.id}/credentials/${first.id}/archive`)).status,
				).toBe(200)
				expect((yield* createCredential(call, vault.id)).status).toBe(201)
			}),
		)
	})

	it("holds no more credentials than the limit", async () => {
		const { run, vaults } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const held: Array<CredentialBody> = []
				for (let index = 0; index < MAX_VAULT_CREDENTIALS; index++) {
					const res = yield* createCredential(call, vault.id, `https://mcp-${index}.example/mcp`)
					expect(res.status).toBe(201)
					held.push(res.body as CredentialBody)
				}
				const over = yield* createCredential(call, vault.id, "https://one-too-many.example/mcp")
				expect(over.status).toBe(409)
				expect(vaults.calls.filter((entry) => entry.operation === "put")).toHaveLength(
					MAX_VAULT_CREDENTIALS,
				)
				const listed = yield* listCredentials(call, vault.id, "", MAX_VAULT_CREDENTIALS)
				expect(listed.data.map(({ id }) => id)).toEqual(held.map(({ id }) => id))
				expect(
					((yield* call("GET", `/v1/vaults/${vault.id}`)).body as VaultBody).custody.held,
				).toBe(MAX_VAULT_CREDENTIALS)

				const page = yield* listCredentials(call, vault.id, "?limit=2&order=desc", 2)
				expect(page.data.map(({ id }) => id)).toEqual(
					held
						.slice(-2)
						.reverse()
						.map(({ id }) => id),
				)
				expect(page.next_page).not.toBeNull()

				const freed = held[0]?.id ?? ""
				expect((yield* call("DELETE", `/v1/vaults/${vault.id}/credentials/${freed}`)).status).toBe(
					200,
				)
				expect(
					(yield* createCredential(call, vault.id, "https://one-too-many.example/mcp")).status,
				).toBe(201)
			}),
		)
	})

	it("archives and deletes a credential, and says when each secret is erased", async () => {
		const { run, vaults } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const credential = (yield* createCredential(call, vault.id)).body as CredentialBody
				const path = `/v1/vaults/${vault.id}/credentials/${credential.id}`

				const archived = yield* call("POST", `${path}/archive`)
				expect(archived.status).toBe(200)
				expect((archived.body as CredentialBody).archived_at).not.toBeNull()
				const erased = archived.body as CredentialBody
				expect(erased.custody).toBe("erased")
				expect(vaults.erased(credential.id)).toBe(true)
				expect(yield* credentialUsable(CredentialId.make(credential.id))).toBe(false)
				expect(yield* call("GET", path)).toEqual({ status: 200, body: erased })
				expect(yield* call("POST", `${path}/archive`)).toEqual({ status: 200, body: erased })
				expect(yield* call("POST", `${path}/archive`)).toEqual({ status: 200, body: erased })
				expect(yield* vaultCustody(call, vault.id, (custody) => custody.erasing === 0)).toEqual({
					storing: 0,
					held: 0,
					erasing: 0,
				})

				expect((yield* listCredentials(call, vault.id, "?include_archived=true", 1)).data).toEqual([
					erased,
				])
				expect((yield* listCredentials(call, vault.id, "", 0)).data).toEqual([])

				const rotate = yield* call("POST", path, {
					auth: { type: "static_bearer", token: ROTATED },
				})
				expect(rotate.status).toBe(409)
				expect(vaults.secretOf(credential.id)).toBeNull()
				expect((yield* call("POST", path, { display_name: "Late" })).status).toBe(409)

				const gone = {
					status: 200,
					body: { id: credential.id, type: "vault_credential_deleted", custody: "erased" },
				}
				expect(yield* call("DELETE", path)).toEqual(gone)
				expect(yield* call("DELETE", path)).toEqual(gone)
				for (const [method, target] of [
					["GET", path],
					["POST", `${path}/archive`],
					["POST", path],
				] as const) {
					expect((yield* call(method, target, method === "POST" ? {} : undefined)).status).toBe(404)
				}
				expect(vaults.secretOf(credential.id)).toBeNull()
				expect(
					(yield* call("DELETE", `/v1/vaults/${vault.id}/credentials/vcrd_missing`)).status,
				).toBe(404)

				const live = (yield* createCredential(call, vault.id)).body as CredentialBody
				const livePath = `/v1/vaults/${vault.id}/credentials/${live.id}`
				const deleted = {
					status: 200,
					body: { id: live.id, type: "vault_credential_deleted", custody: "erased" },
				}
				expect(yield* call("DELETE", livePath)).toEqual(deleted)
				expect(vaults.erased(live.id)).toBe(true)
				expect(yield* credentialUsable(CredentialId.make(live.id))).toBe(false)
				expect(yield* call("DELETE", livePath)).toEqual({
					status: 200,
					body: { id: live.id, type: "vault_credential_deleted", custody: "erased" },
				})
			}),
		)
	})

	it("answers that a credential or vault ended at once, and its policies finish the erasure once storage is back, with no second request", async () => {
		const { run, vaults } = world({ policies: { redeliver: Schedule.spaced("10 millis") } })
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const archived = (yield* createCredential(call, vault.id)).body as CredentialBody
				const deleted = (yield* createCredential(call, vault.id, "https://mcp.linear.example/mcp"))
					.body as CredentialBody
				const base = `/v1/vaults/${vault.id}/credentials`
				vaults.eraseBlocked.add(archived.id)
				vaults.eraseBlocked.add(deleted.id)

				const unconfirmed = yield* call("POST", `${base}/${archived.id}/archive`)
				expect(unconfirmed).toEqual({
					status: 202,
					body: { id: archived.id, type: "vault_credential", vault_id: vault.id, pending: true },
				})
				expect((yield* call("GET", `${base}/${archived.id}`)).body).toMatchObject({
					custody: "erasing",
				})
				expect(yield* credentialUsable(CredentialId.make(archived.id))).toBe(false)
				expect(yield* call("DELETE", `${base}/${deleted.id}`)).toEqual({
					status: 202,
					body: { id: deleted.id, type: "vault_credential_deleted", custody: "erasing" },
				})
				expect(yield* credentialUsable(CredentialId.make(deleted.id))).toBe(false)
				expect(yield* vaultCustody(call, vault.id, (custody) => custody.held === 0)).toEqual({
					storing: 0,
					held: 0,
					erasing: 2,
				})
				expect([archived.id, deleted.id].map((id) => vaults.secretOf(id))).toEqual([TOKEN, TOKEN])

				const whole = yield* createVault(call, "Bob")
				const one = (yield* createCredential(call, whole.id)).body as CredentialBody
				const gone = yield* createVault(call, "Carol")
				const two = (yield* createCredential(call, gone.id)).body as CredentialBody
				vaults.unreachable.add(whole.id)
				vaults.unreachable.add(gone.id)
				expect(yield* call("POST", `/v1/vaults/${whole.id}/archive`)).toEqual({
					status: 202,
					body: { id: whole.id, type: "vault", pending: true },
				})
				const deletedVault = yield* call("DELETE", `/v1/vaults/${gone.id}`)
				expect(deletedVault).toMatchObject({
					status: 202,
					body: { type: "vault_deleted", secrets: "erasing" },
				})
				expect([one.id, two.id].map((id) => vaults.secretOf(id))).toEqual([TOKEN, TOKEN])

				expect(yield* credentialUsable(CredentialId.make(one.id))).toBe(false)
				expect(yield* credentialUsable(CredentialId.make(two.id))).toBe(false)

				const requests = vaults.calls.filter(
					(each) => each.operation !== "erase" && each.operation !== "seal",
				).length
				vaults.eraseBlocked.clear()
				vaults.unreachable.clear()
				const ended = [archived.id, deleted.id, one.id, two.id]
				yield* settles(() => ended.every((id) => vaults.erased(id)))
				expect(ended.map((id) => vaults.secretOf(id))).toEqual([null, null, null, null])
				expect(yield* vaultCustody(call, vault.id, (custody) => custody.erasing === 0)).toEqual({
					storing: 0,
					held: 0,
					erasing: 0,
				})
				expect(
					yield* vaultCustody(
						call,
						whole.id,
						(custody) => custody.erasing === 0 && custody.held === 0,
					),
				).toEqual({ storing: 0, held: 0, erasing: 0 })
				expect((yield* call("GET", `${base}/${archived.id}`)).body).toMatchObject({
					custody: "erased",
				})
				expect(
					vaults.calls.filter((each) => each.operation !== "erase" && each.operation !== "seal"),
				).toHaveLength(requests)
			}),
		)
	})

	it("leaves nothing usable once an archive or delete has answered, whatever the policies have done", async () => {
		const { run, vaults } = world({ policies: "stalled" })
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const archived = (yield* createCredential(call, vault.id)).body as CredentialBody
				const deleted = (yield* createCredential(call, vault.id, "https://mcp.linear.example/mcp"))
					.body as CredentialBody
				const kept = (yield* createCredential(call, vault.id, "https://mcp.kept.example/mcp"))
					.body as CredentialBody
				const base = `/v1/vaults/${vault.id}/credentials`
				const usable = (id: string) => credentialUsable(CredentialId.make(id))
				expect(yield* Effect.forEach([archived.id, deleted.id, kept.id], usable)).toEqual([
					true,
					true,
					true,
				])

				const archive = yield* call("POST", `${base}/${archived.id}/archive`)
				expect(archive).toMatchObject({ status: 200, body: { custody: "erased" } })
				expect(yield* usable(archived.id)).toBe(false)
				expect(vaults.custodyOf(vault.id).usable(archived.id)).toBe(false)
				expect(yield* call("DELETE", `${base}/${deleted.id}`)).toEqual({
					status: 200,
					body: { id: deleted.id, type: "vault_credential_deleted", custody: "erased" },
				})
				expect(vaults.custodyOf(vault.id).usable(deleted.id)).toBe(false)
				expect(vaults.secretOf(kept.id)).toBe(TOKEN)

				const whole = yield* createVault(call, "Bob")
				const one = (yield* createCredential(call, whole.id)).body as CredentialBody
				const two = (yield* createCredential(call, whole.id, "https://mcp.linear.example/mcp"))
					.body as CredentialBody
				expect((yield* call("POST", `/v1/vaults/${whole.id}/archive`)).status).toBe(200)
				expect([one.id, two.id].map((id) => vaults.custodyOf(whole.id).usable(id))).toEqual([
					false,
					false,
				])
				expect(yield* Effect.forEach([one.id, two.id], usable)).toEqual([false, false])
				expect(vaults.rowsOf(one.id)).toMatchObject(SEALED)

				const gone = yield* createVault(call, "Carol")
				const three = (yield* createCredential(call, gone.id)).body as CredentialBody
				expect((yield* call("DELETE", `/v1/vaults/${gone.id}`)).status).toBe(200)
				expect(vaults.custodyOf(gone.id).usable(three.id)).toBe(false)
				expect(vaults.secretOf(three.id)).toBeNull()
			}),
		)
	})

	it("sends no request with a secret once its archive, its delete or its vault's end has answered, with every policy stalled", async () => {
		const { run, vaults } = world({ policies: "stalled" })
		const authenticated: Array<string> = []
		const upstream = (async (url: string, init: RequestInit) => {
			if (new Headers(init.headers).has("authorization")) {
				authenticated.push(url)
			}
			const message = JSON.parse(String(init.body)) as {
				readonly id?: number
				readonly method: string
			}
			if (message.id === undefined) {
				return new Response(null, { status: 202 })
			}
			const answer =
				message.method === "initialize"
					? {
							result: {
								protocolVersion: "2025-11-25",
								capabilities: { tools: {} },
								serverInfo: { name: "upstream", version: "1" },
							},
						}
					: message.method === "tools/call"
						? { result: { content: [{ type: "text", text: "done" }] } }
						: { error: { code: -32_601, message: "Method not found" } }
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...answer }), {
				headers: { "content-type": "application/json" },
			})
		}) as typeof fetch
		const objects = new Map<string, VaultMcp>()
		let sent = 0
		const send = (vaultId: string, credentialId: string, url: string) =>
			Effect.promise(async () => {
				const vault = objects.get(vaultId) ?? makeVaultMcp(vaults.custodyOf(vaultId), upstream)
				objects.set(vaultId, vault)
				return (await vault.call(
					credentialId,
					"session",
					url,
					{ name: "act", description: "", inputSchema: { type: "object" } },
					{},
					`call-${(sent += 1)}`,
				)) as { readonly ok: boolean; readonly message?: string }
			})
		const LINEAR = "https://mcp.linear.example/mcp"
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const archived = (yield* createCredential(call, vault.id)).body as CredentialBody
				const deleted = (yield* createCredential(call, vault.id, LINEAR)).body as CredentialBody
				const whole = yield* createVault(call, "Bob")
				const inVault = (yield* createCredential(call, whole.id)).body as CredentialBody
				const base = `/v1/vaults/${vault.id}/credentials`

				expect((yield* send(vault.id, archived.id, GITHUB)).ok).toBe(true)
				expect((yield* send(vault.id, deleted.id, LINEAR)).ok).toBe(true)
				expect((yield* send(whole.id, inVault.id, GITHUB)).ok).toBe(true)
				expect(new Set(authenticated)).toEqual(new Set([GITHUB, LINEAR]))
				const before = authenticated.length

				expect((yield* call("POST", `${base}/${archived.id}/archive`)).status).toBe(200)
				expect(yield* send(vault.id, archived.id, GITHUB)).toMatchObject({
					ok: false,
					message: expect.stringContaining("archived or deleted"),
				})
				expect((yield* call("DELETE", `${base}/${deleted.id}`)).status).toBe(200)
				expect(yield* send(vault.id, deleted.id, LINEAR)).toMatchObject({
					ok: false,
					message: expect.stringContaining("archived or deleted"),
				})
				expect((yield* call("POST", `/v1/vaults/${whole.id}/archive`)).status).toBe(200)
				expect(yield* send(whole.id, inVault.id, GITHUB)).toMatchObject({
					ok: false,
					message: expect.stringContaining("archived or deleted"),
				})
				expect(authenticated.length).toBe(before)
			}),
		)
	})

	it("refuses to rotate a credential that is ending or whose vault has ended, without touching its secret", async () => {
		const { run, vaults } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const ending = (yield* createCredential(call, vault.id)).body as CredentialBody
				const ended = yield* createVault(call, "Bob")
				const inside = (yield* createCredential(call, ended.id)).body as CredentialBody
				vaults.eraseBlocked.add(ending.id)
				const rotate = (vaultId: string, id: string) =>
					call("POST", `/v1/vaults/${vaultId}/credentials/${id}`, {
						auth: { type: "static_bearer", token: ROTATED },
					})

				expect(
					(yield* call("POST", `/v1/vaults/${vault.id}/credentials/${ending.id}/archive`)).status,
				).toBe(202)
				const refused = yield* rotate(vault.id, ending.id)
				expect(refused.status).toBe(409)
				expect(JSON.stringify(refused.body)).toContain("is archived")

				expect((yield* call("POST", `/v1/vaults/${ended.id}/archive`)).status).toBe(200)
				expect((yield* rotate(ended.id, inside.id)).status).toBe(409)

				expect(vaults.calls.map(({ operation }) => operation)).not.toContain("replace")
				expect(vaults.secretOf(ending.id)).toBe(TOKEN)
				expect(vaults.secretOf(inside.id)).toBeNull()
			}),
		)
	})

	it("refuses to rename or rotate a credential once its vault is archived, before any policy runs", async () => {
		const { run, vaults } = world({ policies: "stalled" })
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const credential = (yield* createCredential(call, vault.id)).body as CredentialBody
				const path = `/v1/vaults/${vault.id}/credentials/${credential.id}`
				expect((yield* call("POST", `/v1/vaults/${vault.id}/archive`)).status).toBe(200)
				expect(
					JSON.stringify(yield* vaults.storedEvents("Credential", credential.id)),
				).not.toContain("vault_credential.archived")

				const renamed = yield* call("POST", path, { display_name: "Renamed" })
				expect(renamed.status).toBe(409)
				expect(JSON.stringify(renamed.body)).toContain("Vault is archived")
				const rotated = yield* call("POST", path, {
					auth: { type: "static_bearer", token: ROTATED },
				})
				expect(rotated.status).toBe(409)
				expect(vaults.calls.map(({ operation }) => operation)).not.toContain("replace")
				const log = JSON.stringify(yield* vaults.storedEvents("Credential", credential.id))
				expect(log).not.toContain("vault_credential.renamed")
				expect(log).not.toContain("vault_credential.rotated")
				expect(yield* credentialUsable(CredentialId.make(credential.id))).toBe(false)
			}),
		)
	})

	it("refuses a secret a header would not carry as written, and stores nothing for it", async () => {
		const { run, vaults, transcript } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const credential = (yield* createCredential(call, vault.id)).body as CredentialBody
				const before = vaults.calls.length
				for (const token of [
					" tok_lead",
					"tok_trail ",
					"tok_line\n",
					"tok in side",
					"tok_ü",
					"\t",
					"short_7",
				]) {
					const created = yield* call("POST", `/v1/vaults/${vault.id}/credentials`, {
						auth: { type: "static_bearer", token, mcp_server_url: "https://mcp.other.example/mcp" },
					})
					const rotated = yield* call(
						"POST",
						`/v1/vaults/${vault.id}/credentials/${credential.id}`,
						{ auth: { type: "static_bearer", token } },
					)
					expect([JSON.stringify(token), created.status, rotated.status]).toEqual([
						JSON.stringify(token),
						400,
						400,
					])
				}
				expect(vaults.calls.length).toBe(before)
				expect(vaults.secretOf(credential.id)).toBe(TOKEN)
			}),
		)
		expect(transcript.join("\n")).not.toContain("tok_lead")
	})

	it("never makes a credential usable again once its secret is erased or its vault has ended", async () => {
		const { run, vaults } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const credential = (yield* createCredential(call, vault.id)).body as CredentialBody
				const other = (yield* createCredential(call, vault.id, "https://mcp.linear.example/mcp"))
					.body as CredentialBody
				const id = CredentialId.make(credential.id)
				const path = `/v1/vaults/${vault.id}/credentials/${credential.id}`
				expect((yield* call("POST", `${path}/archive`)).status).toBe(200)

				const custody = vaults.custodyOf(vault.id)
				const put = (token: string, mode: "create" | "replace") =>
					Effect.sync(() =>
						custody.put(credential.id, { type: "static_bearer", token }, GITHUB, mode),
					)
				expect(yield* put(TOKEN, "create")).toEqual({ refused: "erased" })
				expect(yield* put(ROTATED, "replace")).toEqual({ refused: "erased" })
				expect(custody.usable(credential.id)).toBe(false)
				expect(custody.read(credential.id)).toBeNull()
				expect(vaults.secretOf(credential.id)).toBeNull()
				expect(yield* credentialUsable(id)).toBe(false)
				expect(((yield* call("GET", path)).body as CredentialBody).custody).toBe("erased")
				expect(vaults.secretOf(other.id)).toBe(TOKEN)
				expect(vaults.rowsOf(credential.id)).toEqual({
					secrets: [other.id],
					tombstones: [credential.id],
					sealed: false,
				})

				expect((yield* call("POST", `/v1/vaults/${vault.id}/archive`)).status).toBe(200)
				const late = (credentialId: string, mode: "create" | "replace") =>
					Effect.sync(() =>
						custody.put(credentialId, { type: "static_bearer", token: TOKEN }, GITHUB, mode),
					)
				expect(yield* late(other.id, "replace")).toEqual({ refused: "erased" })
				expect(yield* late("vcrd_never_seen", "create")).toEqual({ refused: "erased" })
				expect(vaults.rowsOf(other.id)).toMatchObject(SEALED)
				expect(custody.usable(other.id)).toBe(false)
			}),
		)
	})

	it("lets no other vault read, change, archive or delete a credential", async () => {
		const { run, vaults } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const owner = yield* createVault(call)
				const other = yield* createVault(call, "Mallory")
				const credential = (yield* createCredential(call, owner.id)).body as CredentialBody
				const foreign = `/v1/vaults/${other.id}/credentials/${credential.id}`
				for (const [method, path, payload] of [
					["GET", foreign, undefined],
					["POST", foreign, { auth: { type: "static_bearer", token: ROTATED } }],
					["POST", foreign, { display_name: "Stolen" }],
					["POST", `${foreign}/archive`, undefined],
					["DELETE", foreign, undefined],
				] as const) {
					expect(`${method} -> ${(yield* call(method, path, payload)).status}`).toBe(
						`${method} -> 404`,
					)
				}
				expect((yield* listCredentials(call, owner.id, "", 1)).data).toHaveLength(1)
				expect((yield* call("GET", `/v1/vaults/${other.id}/credentials`)).body).toMatchObject({
					data: [],
				})
				expect(vaults.secretOf(credential.id)).toBe(TOKEN)
				expect(vaults.calls.map(({ operation }) => operation)).not.toContain("replace")
				const intact = yield* call("GET", `/v1/vaults/${owner.id}/credentials/${credential.id}`)
				expect(intact.body).toEqual(credential)
			}),
		)
	})

	it("archiving or deleting a vault ends every credential in it and erases each secret", async () => {
		const { run, vaults } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const archived = yield* createVault(call)
				const one = (yield* createCredential(call, archived.id)).body as CredentialBody
				const two = (yield* createCredential(call, archived.id, "https://mcp.linear.example/mcp"))
					.body as CredentialBody
				const old = (yield* createCredential(call, archived.id, "https://old.example/mcp"))
					.body as CredentialBody
				expect(
					(yield* call("POST", `/v1/vaults/${archived.id}/credentials/${old.id}/archive`)).status,
				).toBe(200)
				const ended = yield* call("POST", `/v1/vaults/${archived.id}/archive`)
				expect(ended.status).toBe(200)
				expect((ended.body as VaultBody).custody.held).toBe(0)
				expect([one, two, old].every(({ id }) => vaults.erased(id))).toBe(true)
				expect(yield* vaultCustody(call, archived.id, (custody) => custody.erasing === 0)).toEqual({
					storing: 0,
					held: 0,
					erasing: 0,
				})
				for (const { id } of [one, two, old]) {
					const after = yield* custodyOf(
						call,
						`/v1/vaults/${archived.id}/credentials/${id}`,
						"erased",
					)
					expect(after.archived_at).not.toBeNull()
					expect(yield* credentialUsable(CredentialId.make(id))).toBe(false)
				}
				expect((yield* createCredential(call, archived.id, "https://new.example/mcp")).status).toBe(
					409,
				)

				const deleted = yield* createVault(call, "Bob")
				const three = (yield* createCredential(call, deleted.id)).body as CredentialBody
				expect((yield* call("DELETE", `/v1/vaults/${deleted.id}`)).status).toBe(200)
				expect(vaults.erased(three.id)).toBe(true)
				expect(
					(yield* call("GET", `/v1/vaults/${deleted.id}/credentials/${three.id}`)).status,
				).toBe(404)
				const settled = yield* Effect.repeat(call("DELETE", `/v1/vaults/${deleted.id}`), {
					schedule: Schedule.spaced("5 millis"),
					times: 400,
					until: (res) => (res.body as { custody: { erasing: number } }).custody.erasing === 0,
				})
				expect(settled.body).toEqual({
					id: deleted.id,
					type: "vault_deleted",
					secrets: "erased",
					custody: { storing: 0, held: 0, erasing: 0 },
				})
			}),
		)
	})

	it("a credential attached while its vault is archived ends erased, or was never created", async () => {
		const { run, vaults } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				for (let round = 0; round < 12; round++) {
					const vault = yield* createVault(call, `Race ${round}`)
					const settled = (yield* createCredential(call, vault.id)).body as CredentialBody
					const [attached, ended] = yield* Effect.all(
						[
							createCredential(call, vault.id, `https://mcp-${round}.example/mcp`).pipe(
								Effect.delay(`${round % 4} millis`),
							),
							call("POST", `/v1/vaults/${vault.id}/archive`),
						],
						{ concurrency: "unbounded" },
					)
					expect(ended.status).toBe(200)
					expect([201, 409]).toContain(attached.status)
					if (attached.status === 201) {
						const racedId = (attached.body as CredentialBody).id
						const after = yield* custodyOf(
							call,
							`/v1/vaults/${vault.id}/credentials/${racedId}`,
							"erased",
						)
						expect(after.archived_at).not.toBeNull()
						expect(yield* credentialUsable(CredentialId.make(racedId))).toBe(false)
					}
					expect(vaults.rowsOf(settled.id)).toMatchObject(SEALED)
					expect(yield* credentialUsable(CredentialId.make(settled.id))).toBe(false)
					expect(yield* vaultCustody(call, vault.id, (custody) => custody.erasing === 0)).toEqual({
						storing: 0,
						held: 0,
						erasing: 0,
					})
				}
			}),
		)
	})

	it("says the token must be sent again when the connection cannot be reached, and binds a keyed retry to the original token", async () => {
		const { run, vaults, logs, transcript } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const credential = (yield* createCredential(call, vault.id)).body as CredentialBody
				const path = `/v1/vaults/${vault.id}/credentials`
				vaults.unreachable.add(vault.id)
				const rotate = yield* call("POST", `${path}/${credential.id}`, {
					auth: { type: "static_bearer", token: ROTATED },
				})
				expect(rotate.status).toBe(503)

				const key = { "idempotency-key": "credential-unreachable" }
				const body = {
					auth: {
						type: "static_bearer",
						token: TOKEN,
						mcp_server_url: "https://mcp.b.example/mcp",
					},
				}
				const keyed = yield* call("POST", path, body, key)
				expect(keyed.status).toBe(503)
				expect(JSON.stringify(keyed.body)).toContain("same Idempotency-Key")
				const plain = yield* createCredential(call, vault.id, "https://mcp.c.example/mcp")
				expect(plain.status).toBe(503)
				const plainId = /vcrd_[0-9a-f]+/u.exec(JSON.stringify(plain.body))?.[0] ?? ""
				expect(JSON.stringify(plain.body)).toContain("update the credential")

				vaults.unreachable.clear()
				expect(vaults.secretOf(credential.id)).toBe(TOKEN)
				const log = yield* vaults.storedEvents("Credential", credential.id)
				expect(JSON.stringify(log)).not.toContain("vault_credential.rotated")
				expect(yield* credentialUsable(CredentialId.make(plainId))).toBe(false)
				const unstored = yield* call("GET", `${path}/${plainId}`)
				expect((unstored.body as CredentialBody).custody).toBe("storing")
				const listed = (yield* call("GET", path)).body as {
					readonly data: ReadonlyArray<CredentialBody>
				}
				expect(listed.data.filter((item) => item.custody === "storing")).toHaveLength(2)
				expect((yield* call("GET", `/v1/vaults/${vault.id}`)).body).toMatchObject({
					custody: { storing: 2, held: 1, erasing: 0 },
				})

				const swapped = yield* call("POST", path, { auth: { ...body.auth, token: ROTATED } }, key)
				expect(swapped.status).toBe(409)
				const moved = yield* call(
					"POST",
					path,
					{ auth: { ...body.auth, mcp_server_url: "https://mcp.d.example/mcp" } },
					key,
				)
				expect(moved.status).toBe(409)
				const retried = yield* call("POST", path, body, key)
				expect(retried.status).toBe(201)
				const retriedId = (retried.body as CredentialBody).id
				expect((retried.body as CredentialBody).custody).toBe("held")
				expect(vaults.secretOf(retriedId)).toBe(TOKEN)
				expect(yield* credentialUsable(CredentialId.make(retriedId))).toBe(true)
				const updated = yield* call("POST", `${path}/${plainId}`, {
					auth: { type: "static_bearer", token: ROTATED },
				})
				expect(updated.status).toBe(200)
				expect((updated.body as CredentialBody).custody).toBe("held")
				expect(vaults.secretOf(plainId)).toBe(ROTATED)
				expect(yield* credentialUsable(CredentialId.make(plainId))).toBe(true)
				expect((yield* call("GET", `/v1/vaults/${vault.id}`)).body).toMatchObject({
					custody: { storing: 0, held: 3, erasing: 0 },
				})
			}),
		)
		expect(logs.map(String).join("\n")).toContain("Credential secret not put")
		expect(`${logs.map(String).join("\n")}\n${transcript.join("\n")}`).not.toContain(ROTATED)
	})

	it("never puts a secret in a response, an event, a view or a log", async () => {
		const { run, vaults, logs, transcript } = world()
		const recorded = await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const credential = (yield* createCredential(call, vault.id)).body as CredentialBody
				const path = `/v1/vaults/${vault.id}/credentials/${credential.id}`
				yield* call("POST", path, { auth: { type: "static_bearer", token: ROTATED } })
				yield* call("GET", path)
				yield* call("GET", `/v1/vaults/${vault.id}/credentials`)
				yield* createCredential(call, vault.id)
				yield* call("POST", `${path}/archive`)
				yield* call("DELETE", `/v1/vaults/${vault.id}`)

				const tags = (log: ReadonlyArray<{ readonly event: unknown }>) =>
					log.map((entry) => (entry.event as { readonly _tag?: unknown })._tag)
				const credentialLog = yield* vaults.storedEvents("Credential", credential.id).pipe(
					Effect.repeat({
						schedule: Schedule.spaced("5 millis"),
						times: 400,
						until: (log) => tags(log).includes("vault_credential.deleted"),
					}),
				)
				const vaultLog = yield* vaults.storedEvents("Vault", vault.id)
				const urlLog = yield* vaults.storedEvents(
					"CredentialUrlClaim",
					credentialUrlClaimId(vault.id, GITHUB),
				)
				expect(tags(vaultLog)).toEqual([
					"vault.created",
					"vault.credential_attached",
					"vault.credential_storage_counted",
					"vault.credential_detached",
					"vault.credential_erasure_counted",
					"vault.deleted",
					"vault.credential_released",
				])
				expect(tags(credentialLog)).toEqual([
					"vault_credential.created",
					"vault_credential.secret_stored",
					"vault_credential.rotated",
					"vault_credential.archived",
					"vault_credential.secret_erased",
					"vault_credential.deleted",
				])
				expect(tags(urlLog)).toEqual(["vault_credential_url.claimed", "vault_credential_url.freed"])
				const credentialViews = yield* CredentialView
				const viewLog = yield* credentialViews.list(
					Credential.ref(CredentialId.make(credential.id)),
					{ take: 100, order: "asc" },
				)
				expect(viewLog.entries.length).toBeGreaterThanOrEqual(4)
				return JSON.stringify([vaultLog, credentialLog, urlLog, viewLog])
			}),
		)
		const everything = [recorded, ...transcript, ...logs.map(String)].join("\n")
		expect(everything).toContain("vault_credential.rotated")
		expect(everything).not.toContain(TOKEN)
		expect(everything).not.toContain(ROTATED)
	})

	it("holds what it is given and nothing more: the first create, a rotation over it, none after an erase", async () => {
		const { run, vaults } = world()
		await run(() =>
			Effect.gen(function* () {
				const secrets = yield* CredentialSecrets
				const vault_id = VaultId.make("vlt_custody")
				const put = (
					credential_id: CredentialId,
					token: string,
					mode: "create" | "replace" = "create",
				) =>
					secrets.put({
						vault_id,
						credential_id,
						secret: Redacted.make(token),
						mcp_server_url: GITHUB,
						mode,
					})

				const retried = CredentialId.make("vcrd_retried")
				expect(yield* put(retried, TOKEN)).toEqual({ refused: null })
				expect(yield* put(retried, ROTATED)).toEqual({ refused: null })
				expect(vaults.secretOf(retried)).toBe(TOKEN)
				expect(yield* put(retried, ROTATED, "replace")).toEqual({ refused: null })
				expect(vaults.secretOf(retried)).toBe(ROTATED)
				expect(yield* put(retried, TOKEN)).toEqual({ refused: null })
				expect(vaults.secretOf(retried)).toBe(ROTATED)
				expect(vaults.storedWith(retried)).not.toContain(TOKEN)

				const late = CredentialId.make("vcrd_late")
				expect(vaults.secretOf(late)).toBeNull()
				expect(yield* put(late, ROTATED, "replace")).toEqual({ refused: null })
				expect(yield* put(late, TOKEN)).toEqual({ refused: null })
				expect(vaults.secretOf(late)).toBe(ROTATED)
				expect(vaults.targetOf(late)).toBe(GITHUB)

				yield* secrets.erase({ vault_id, credential_id: retried })
				yield* secrets.erase({ vault_id, credential_id: retried })
				expect(yield* put(retried, ROTATED, "replace")).toEqual({ refused: "erased" })
				expect(yield* put(retried, TOKEN)).toEqual({ refused: "erased" })
				expect(vaults.secretOf(retried)).toBeNull()
				expect(vaults.secretOf(late)).toBe(ROTATED)

				yield* secrets.seal({ vault_id })
				yield* secrets.seal({ vault_id })
				expect(yield* put(late, TOKEN, "replace")).toEqual({ refused: "erased" })
				expect(vaults.secretOf(late)).toBeNull()
				expect(vaults.rowsOf(late)).toMatchObject(SEALED)
			}),
		)
	})
})
