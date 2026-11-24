import { Credential } from "@checkfu/domain/Vault/Credential.aggregate"
import { CredentialId } from "@checkfu/domain/Vault/Credential.id"
import { CredentialSecrets } from "@checkfu/domain/Vault/CredentialSecrets.external"
import { CredentialView } from "@checkfu/domain/Vault/CredentialView.view"
import { MAX_VAULT_CREDENTIALS } from "@checkfu/domain/Vault/VaultTypes"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import { UNCONFIRMED_SECRET_TTL_MS } from "../src/Connection/SecretCustody.ts"
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

interface VaultBody {
	readonly id: string
	readonly type: string
	readonly display_name: string
	readonly archived_at: string | null
	readonly updated_at: string
}
interface CredentialBody {
	readonly id: string
	readonly type: string
	readonly vault_id: string
	readonly auth: { readonly type: string; readonly mcp_server_url: string }
	readonly display_name: string | null
	readonly archived_at: string | null
	readonly updated_at: string
}

/** The API over an in-memory host, with the connection objects exposed for inspection. */
const world = () => {
	const vaults = makeVaultsTestLayer()
	const logs: Array<unknown> = []
	const transcript: Array<string> = []
	const base = makePiDurableTestLayer(
		async (model) => makeAssistantReply(model, null, "unused", 1, 1),
		undefined,
		undefined,
		undefined,
		vaults.layer,
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
			) => Effect.Effect<{ readonly status: number; readonly body: unknown }>
		}) => Effect.Effect<A, E, Layer.Success<typeof layer>>,
	): Promise<A> => {
		try {
			return await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					return yield* body({
						call: (method, path, payload) =>
							Effect.gen(function* () {
								const res = yield* sendRequest(apiFetch, {
									method,
									path,
									headers: AUTH_HEADERS,
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

/** Policies run after the response, so what they cause is awaited rather than assumed. */
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
	it("creates, reads, renames, archives and deletes a vault", async () => {
		const { run } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				expect(vault).toMatchObject({ type: "vault", display_name: "Alice", archived_at: null })
				expect(vault.id).toMatch(/^vlt_[0-9a-f]{24}$/u)
				expect(Object.keys(vault).sort()).toEqual([
					"archived_at",
					"created_at",
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
				expect(again.body).toEqual(archived.body)

				const late = yield* call("POST", `/v1/vaults/${vault.id}`, { display_name: "Late" })
				expect(late.status).toBe(409)

				const deleted = yield* call("DELETE", `/v1/vaults/${vault.id}`)
				expect(deleted).toEqual({ status: 200, body: { id: vault.id, type: "vault_deleted" } })
				for (const [method, path] of [
					["GET", `/v1/vaults/${vault.id}`],
					["POST", `/v1/vaults/${vault.id}/archive`],
					["DELETE", `/v1/vaults/${vault.id}`],
					["GET", `/v1/vaults/${vault.id}/credentials`],
				] as const) {
					expect((yield* call(method, path)).status).toBe(404)
				}
				expect((yield* call("GET", "/v1/vaults/vlt_missing")).status).toBe(404)
				expect((yield* call("POST", "/v1/vaults", { display_name: "" })).status).toBe(400)
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
					archived_at: null,
				})
				expect(credential.id).toMatch(/^vcrd_[0-9a-f]{24}$/u)
				expect(Object.keys(credential.auth).sort()).toEqual(["mcp_server_url", "type"])
				expect(vaults.secretOf(credential.id)).toBe(TOKEN)
				// The credential's creation confirms the secret, which stops it expiring.
				yield* settles(() => vaults.alarmOf(credential.id) === null)

				const read = yield* call("GET", `/v1/vaults/${vault.id}/credentials/${credential.id}`)
				expect(read).toEqual({ status: 200, body: credential })
				const listed = yield* call("GET", `/v1/vaults/${vault.id}/credentials`)
				expect(listed).toEqual({ status: 200, body: { data: [credential] } })

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
				const listed = yield* call("GET", `/v1/vaults/${vault.id}/credentials`)
				expect((listed.body as { data: ReadonlyArray<unknown> }).data).toHaveLength(1)

				// A misspelled field is refused, not dropped, at every object of every body.
				const credentialId = (listed.body as { data: ReadonlyArray<{ id: string }> }).data[0]?.id
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
				const after = yield* call("GET", `/v1/vaults/${vault.id}/credentials`)
				expect((after.body as { data: ReadonlyArray<unknown> }).data).toHaveLength(1)
			}),
		)
		expect(transcript.join("\n")).not.toContain(TOKEN)
	})

	it("holds one active credential per MCP server URL and erases the secret of a refused one", async () => {
		const { run, vaults } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const first = (yield* createCredential(call, vault.id)).body as CredentialBody
				const refused = yield* createCredential(call, vault.id, `${GITHUB}#again`)
				expect(refused.status).toBe(409)
				const stored = vaults.calls.filter((entry) => entry.operation === "store")
				expect(stored).toHaveLength(2)
				const refusedId = stored[1]?.credentialId ?? ""
				expect(refusedId).not.toBe(first.id)
				expect(vaults.secretOf(refusedId)).toBeNull()
				expect([...vaults.heldBy(refusedId)]).toEqual([])
				expect(vaults.alarmOf(refusedId)).toBeNull()
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
				const refusedId = vaults.calls.findLast((entry) => entry.operation === "store")
				expect(vaults.secretOf(refusedId?.credentialId ?? "")).toBeNull()
				const listed = yield* call("GET", `/v1/vaults/${vault.id}/credentials`)
				expect(
					(listed.body as { data: ReadonlyArray<CredentialBody> }).data.map(({ id }) => id),
				).toEqual(held.map(({ id }) => id))

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

	it("archives and deletes a credential, erasing its secret each time", async () => {
		const { run, vaults } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const credential = (yield* createCredential(call, vault.id)).body as CredentialBody
				const path = `/v1/vaults/${vault.id}/credentials/${credential.id}`

				const archived = yield* call("POST", `${path}/archive`)
				expect(archived.status).toBe(200)
				expect((archived.body as CredentialBody).archived_at).not.toBeNull()
				yield* settles(() => vaults.secretOf(credential.id) === null)
				expect([...vaults.heldBy(credential.id)]).toEqual([["status", "erased"]])
				expect((yield* call("POST", `${path}/archive`)).body).toEqual(archived.body)
				expect((yield* call("GET", path)).body).toEqual(archived.body)
				expect(
					(
						(yield* call("GET", `/v1/vaults/${vault.id}/credentials`)).body as {
							data: ReadonlyArray<unknown>
						}
					).data,
				).toEqual([])

				const rotate = yield* call("POST", path, {
					auth: { type: "static_bearer", token: ROTATED },
				})
				expect(rotate.status).toBe(409)
				expect(vaults.secretOf(credential.id)).toBeNull()
				expect((yield* call("POST", path, { display_name: "Late" })).status).toBe(409)

				const deleted = yield* call("DELETE", path)
				expect(deleted).toEqual({
					status: 200,
					body: { id: credential.id, type: "vault_credential_deleted" },
				})
				for (const [method, target] of [
					["GET", path],
					["POST", `${path}/archive`],
					["DELETE", path],
				] as const) {
					expect((yield* call(method, target)).status).toBe(404)
				}
				expect(vaults.secretOf(credential.id)).toBeNull()

				const live = (yield* createCredential(call, vault.id)).body as CredentialBody
				expect(
					(yield* call("DELETE", `/v1/vaults/${vault.id}/credentials/${live.id}`)).status,
				).toBe(200)
				yield* settles(() => vaults.secretOf(live.id) === null)
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
				expect((yield* call("POST", `/v1/vaults/${archived.id}/archive`)).status).toBe(200)
				yield* settles(() => vaults.secretOf(one.id) === null && vaults.secretOf(two.id) === null)
				const after = yield* call("GET", `/v1/vaults/${archived.id}/credentials/${one.id}`)
				expect((after.body as CredentialBody).archived_at).not.toBeNull()
				expect((yield* createCredential(call, archived.id, "https://new.example/mcp")).status).toBe(
					409,
				)

				const deleted = yield* createVault(call, "Bob")
				const three = (yield* createCredential(call, deleted.id)).body as CredentialBody
				expect((yield* call("DELETE", `/v1/vaults/${deleted.id}`)).status).toBe(200)
				yield* settles(() => vaults.secretOf(three.id) === null)
				expect(
					(yield* call("GET", `/v1/vaults/${deleted.id}/credentials/${three.id}`)).status,
				).toBe(404)
			}),
		)
	})

	it("stores nothing and creates nothing when the connection cannot be reached", async () => {
		const { run, vaults, logs, transcript } = world()
		await run(({ call }) =>
			Effect.gen(function* () {
				const vault = yield* createVault(call)
				const credential = (yield* createCredential(call, vault.id)).body as CredentialBody
				vaults.unreachable.add(credential.id)
				const rotate = yield* call("POST", `/v1/vaults/${vault.id}/credentials/${credential.id}`, {
					auth: { type: "static_bearer", token: ROTATED },
				})
				expect(rotate.status).toBe(503)
				vaults.unreachable.delete(credential.id)
				expect(vaults.secretOf(credential.id)).toBe(TOKEN)
			}),
		)
		expect(logs.map(String).join("\n")).toContain("Credential secret not replaced")
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

				const vaultLog = yield* vaults.storedEvents("Vault", vault.id)
				const credentialLog = yield* vaults.storedEvents("Credential", credential.id)
				const tags = (log: typeof vaultLog) =>
					log.map((entry) => (entry.event as { readonly _tag?: unknown })._tag)
				expect(tags(vaultLog)).toEqual([
					"vault.created",
					"vault.credential_attached",
					"vault.credential_detached",
					"vault.deleted",
				])
				expect(tags(credentialLog)).toEqual([
					"vault_credential.created",
					"vault_credential.rotated",
					"vault_credential.archived",
				])
				const credentialViews = yield* CredentialView
				const viewLog = yield* credentialViews.list(
					Credential.ref(CredentialId.make(credential.id)),
					{ take: 100, order: "asc" },
				)
				expect(viewLog.entries).toHaveLength(3)
				return JSON.stringify([vaultLog, credentialLog, viewLog])
			}),
		)
		const everything = [recorded, ...transcript, ...logs.map(String)].join("\n")
		expect(everything).toContain("vault_credential.rotated")
		expect(everything).not.toContain(TOKEN)
		expect(everything).not.toContain(ROTATED)
	})

	it("erases a secret whose credential was never confirmed to exist", async () => {
		const { run, vaults } = world()
		await run(() =>
			Effect.gen(function* () {
				const secrets = yield* CredentialSecrets
				const orphan = CredentialId.make("vcrd_orphan")
				expect(
					yield* secrets.store({ credential_id: orphan, secret: Redacted.make(TOKEN) }),
				).toEqual({
					stored: true,
				})
				expect(vaults.secretOf(orphan)).toBe(TOKEN)
				expect(vaults.alarmOf(orphan)).toBe(UNCONFIRMED_SECRET_TTL_MS)
				yield* Effect.promise(() => vaults.advanceTo(UNCONFIRMED_SECRET_TTL_MS - 1))
				expect(vaults.secretOf(orphan)).toBe(TOKEN)
				yield* Effect.promise(() => vaults.advanceTo(UNCONFIRMED_SECRET_TTL_MS))
				expect(vaults.secretOf(orphan)).toBeNull()
				expect([...vaults.heldBy(orphan)]).toEqual([])

				const kept = CredentialId.make("vcrd_kept")
				yield* secrets.store({ credential_id: kept, secret: Redacted.make(TOKEN) })
				yield* secrets.keep({ credential_id: kept })
				yield* Effect.promise(() => vaults.advanceTo(UNCONFIRMED_SECRET_TTL_MS * 3))
				expect(vaults.secretOf(kept)).toBe(TOKEN)
				expect(
					yield* secrets.store({ credential_id: kept, secret: Redacted.make(ROTATED) }),
				).toEqual({
					stored: false,
				})
				yield* secrets.erase({ credential_id: kept })
				expect(
					yield* secrets.replace({ credential_id: kept, secret: Redacted.make(ROTATED) }),
				).toEqual({ replaced: false })
				expect(
					yield* secrets.store({ credential_id: kept, secret: Redacted.make(ROTATED) }),
				).toEqual({
					stored: false,
				})
				expect(vaults.secretOf(kept)).toBeNull()
			}),
		)
	})
})
