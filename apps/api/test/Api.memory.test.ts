import { createHash } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeApiHandler } from "../src/Http/Router.ts"
import {
	AUTH_HEADERS,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendRequest,
} from "./helpers/ApiHarness.ts"

type ApiFetch = Parameters<typeof sendRequest>[0]

interface StoreBody {
	readonly id: string
	readonly type: string
	readonly name: string
	readonly description: string
	readonly created_at: string
	readonly updated_at: string
	readonly archived_at: string | null
}

interface MemoryBody {
	readonly id: string
	readonly type: string
	readonly memory_store_id: string
	readonly path: string
	readonly content: string
	readonly content_sha256: string
	readonly content_size_bytes: number
	readonly version: number
}

type ListedMemory = Omit<MemoryBody, "content" | "version"> & {
	readonly created_at: string
	readonly updated_at: string
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

const request = (
	apiFetch: ApiFetch,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
) =>
	sendRequest(apiFetch, {
		method,
		path,
		headers: { ...AUTH_HEADERS, ...headers },
		...(body === undefined ? {} : { body }),
	})

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

const withApi = async (run: (apiFetch: ApiFetch) => Effect.Effect<void>) => {
	const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
		makeAssistantReply(model, null, "ok", 1, 1),
	)
	try {
		await Effect.runPromise(
			Effect.flatMap(makeApiHandler, ({ fetch: apiFetch }) => run(apiFetch)).pipe(
				Effect.scoped,
				Effect.provide(layer),
			),
		)
	} finally {
		await closeAll()
	}
}

describe("Memory stores", () => {
	it("creates, reads, renames, archives and deletes a store", () =>
		withApi((apiFetch) =>
			Effect.gen(function* () {
				const created = yield* request(apiFetch, "POST", "/v1/memory_stores", {
					name: "User Preferences",
					description: "Per-user preferences.",
				})
				expect(created.status).toBe(201)
				const store = yield* json<StoreBody>(created)
				expect(store).toEqual({
					id: expect.stringMatching(/^memstore_/),
					type: "memory_store",
					name: "User Preferences",
					description: "Per-user preferences.",
					created_at: expect.any(String),
					updated_at: store.created_at,
					archived_at: null,
				})
				const path = `/v1/memory_stores/${store.id}`
				expect(yield* json(yield* request(apiFetch, "GET", path))).toEqual(store)

				const renamed = yield* json<StoreBody>(
					yield* request(apiFetch, "POST", path, { name: "Preferences" }),
				)
				expect([renamed.name, renamed.description]).toEqual([
					"Preferences",
					"Per-user preferences.",
				])

				const bare = yield* json<StoreBody>(
					yield* request(apiFetch, "POST", "/v1/memory_stores", { name: "Bare" }),
				)
				expect(bare.description).toBe("")
				expect(bare.id).not.toBe(store.id)

				const archived = yield* json<StoreBody>(yield* request(apiFetch, "POST", `${path}/archive`))
				expect(archived.archived_at).not.toBeNull()
				expect((yield* request(apiFetch, "POST", `${path}/archive`)).status).toBe(200)
				expect((yield* request(apiFetch, "POST", path, { name: "Too late" })).status).toBe(409)

				const deleted = yield* request(apiFetch, "DELETE", path)
				expect(yield* json(deleted)).toEqual({ id: store.id, type: "memory_store_deleted" })
				expect((yield* request(apiFetch, "GET", path)).status).toBe(404)
				expect((yield* request(apiFetch, "DELETE", path)).status).toBe(404)
				expect((yield* request(apiFetch, "POST", `${path}/archive`)).status).toBe(404)
				expect((yield* request(apiFetch, "GET", "/v1/memory_stores/memstore_missing")).status).toBe(
					404,
				)

				for (const body of [{}, { name: "" }, { name: "x".repeat(257) }, { name: 7 }]) {
					expect((yield* request(apiFetch, "POST", "/v1/memory_stores", body)).status).toBe(400)
				}
			}),
		))

	it("gives a retried create the same store and refuses the key for a different one", () =>
		withApi((apiFetch) =>
			Effect.gen(function* () {
				const create = (name: string) =>
					request(apiFetch, "POST", "/v1/memory_stores", { name }, { "idempotency-key": "k1" })
				const first = yield* json<StoreBody>(yield* create("Team"))
				const second = yield* json<StoreBody>(yield* create("Team"))
				expect(second).toEqual(first)
				expect((yield* create("Other")).status).toBe(409)
			}),
		))

	it("stores memories by path with their hash and size, and lists them without content", () =>
		withApi((apiFetch) =>
			Effect.gen(function* () {
				const store = yield* json<StoreBody>(
					yield* request(apiFetch, "POST", "/v1/memory_stores", { name: "Notes" }),
				)
				const base = `/v1/memory_stores/${store.id}/memories`
				const create = (path: string, content: string) =>
					request(apiFetch, "POST", base, { path, content })

				const created = yield* create("/preferences/formatting.md", "Tabs, not spaces. ✓")
				expect(created.status).toBe(201)
				const formatting = yield* json<MemoryBody>(created)
				expect(formatting).toMatchObject({
					id: expect.stringMatching(/^mem_/),
					type: "memory",
					memory_store_id: store.id,
					path: "/preferences/formatting.md",
					content: "Tabs, not spaces. ✓",
					content_sha256: sha256("Tabs, not spaces. ✓"),
					content_size_bytes: 21,
					version: 1,
				})
				expect((yield* create("/preferences/formatting.md", "again")).status).toBe(409)

				yield* create("/preferences/tone.md", "Brief.")
				yield* create("/preferences/archive/old.md", "Old.")
				yield* create("/todo.md", "Ship.")
				yield* create("/preferences-old/x.md", "Not under /preferences/.")

				const paths = (query: string) =>
					Effect.map(
						Effect.flatMap(request(apiFetch, "GET", `${base}${query}`), (response) =>
							json<{ data: ReadonlyArray<ListedMemory> }>(response),
						),
						(listed) => listed.data.map((entry) => entry.path),
					)
				expect(yield* paths("")).toEqual([
					"/preferences-old/x.md",
					"/preferences/archive/old.md",
					"/preferences/formatting.md",
					"/preferences/tone.md",
					"/todo.md",
				])
				expect(yield* paths("?path_prefix=/preferences/")).toEqual([
					"/preferences/archive/old.md",
					"/preferences/formatting.md",
					"/preferences/tone.md",
				])
				expect(yield* paths("?path_prefix=/preferences/&depth=1")).toEqual([
					"/preferences/formatting.md",
					"/preferences/tone.md",
				])
				expect(yield* paths("?path_prefix=/&depth=1")).toEqual(["/todo.md"])
				expect((yield* request(apiFetch, "GET", `${base}?path_prefix=/preferences`)).status).toBe(
					400,
				)
				expect((yield* request(apiFetch, "GET", `${base}?depth=2`)).status).toBe(400)

				const listed = yield* json<{ data: ReadonlyArray<ListedMemory> }>(
					yield* request(apiFetch, "GET", `${base}?path_prefix=/preferences/&depth=1`),
				)
				expect(listed.data[0]).toEqual({
					id: formatting.id,
					type: "memory",
					memory_store_id: store.id,
					path: "/preferences/formatting.md",
					content_sha256: formatting.content_sha256,
					content_size_bytes: 21,
					created_at: expect.any(String),
					updated_at: expect.any(String),
				})

				expect(
					yield* json(yield* request(apiFetch, "GET", `${base}/${formatting.id}`)),
				).toMatchObject({ id: formatting.id, content: "Tabs, not spaces. ✓" })

				for (const body of [
					{ path: "notes.md", content: "x" },
					{ path: "/a/../b.md", content: "x" },
					{ path: "/a//b.md", content: "x" },
					{ path: "/", content: "x" },
					{ path: "/big.md", content: "é".repeat(50_001) },
					{ path: "/huge.md", content: "x".repeat(100_001) },
					{ path: "/no-content.md" },
				]) {
					expect([body.path, (yield* request(apiFetch, "POST", base, body)).status]).toEqual([
						body.path,
						400,
					])
				}
				expect((yield* create("/limit.md", "x".repeat(100_000))).status).toBe(201)
			}),
		))

	it("takes any memory within its size however it escapes, and refuses text that is not Unicode", () =>
		withApi((apiFetch) =>
			Effect.gen(function* () {
				const store = yield* json<StoreBody>(
					yield* request(apiFetch, "POST", "/v1/memory_stores", { name: "Edges" }),
				)
				const base = `/v1/memory_stores/${store.id}/memories`
				// 90,000 tabs are within the 100 kB limit but take 180 kB as JSON.
				const tabs = yield* request(apiFetch, "POST", base, {
					path: "/tabs.md",
					content: "\t".repeat(90_000),
				})
				expect(tabs.status).toBe(201)
				const written = yield* json<MemoryBody>(tabs)
				const updated = yield* request(apiFetch, "POST", `${base}/${written.id}`, {
					content: "\t".repeat(89_999),
				})
				expect(updated.status).toBe(200)
				// Half a surrogate pair has no UTF-8 form, so no hash or size would describe it.
				const broken = yield* request(apiFetch, "POST", base, {
					path: "/broken.md",
					content: "half a pair: \ud800",
				})
				expect(broken.status).toBe(400)
			}),
		))

	it("refuses a path that would be both a memory and a directory of memories, in either order", () =>
		withApi((apiFetch) =>
			Effect.gen(function* () {
				const store = yield* json<StoreBody>(
					yield* request(apiFetch, "POST", "/v1/memory_stores", { name: "Notes" }),
				)
				const create = (path: string) =>
					Effect.flatMap(
						request(apiFetch, "POST", `/v1/memory_stores/${store.id}/memories`, {
							path,
							content: "x",
						}),
						(res) =>
							Effect.map(
								json<{ error?: { message: string } }>(res),
								(body) => [res.status, body.error?.message] as const,
							),
					)
				expect((yield* create("/notes"))[0]).toBe(201)
				expect(yield* create("/notes/todo.md")).toEqual([
					409,
					"Memory path /notes/todo.md conflicts with /notes: a path cannot be both a memory and a directory of memories.",
				])
				expect((yield* create("/team/plan/q3.md"))[0]).toBe(201)
				expect(yield* create("/team")).toEqual([
					409,
					"Memory path /team conflicts with /team/plan/q3.md: a path cannot be both a memory and a directory of memories.",
				])
				// A shared prefix is not a shared directory.
				expect((yield* create("/notes-archive"))[0]).toBe(201)
				expect((yield* create("/team/plan/q3.md.bak"))[0]).toBe(201)
				expect((yield* create("/team/plans"))[0]).toBe(201)

				// A deleted store's index outlives it, but none of its old paths answer for it.
				expect((yield* request(apiFetch, "DELETE", `/v1/memory_stores/${store.id}`)).status).toBe(
					200,
				)
				const [status, message] = yield* create("/notes/after-delete.md")
				expect(status).toBe(404)
				expect(message).not.toContain("/notes")
			}),
		))

	it("updates and deletes a memory only as its precondition allows, and only in its own store", () =>
		withApi((apiFetch) =>
			Effect.gen(function* () {
				const store = yield* json<StoreBody>(
					yield* request(apiFetch, "POST", "/v1/memory_stores", { name: "Notes" }),
				)
				const other = yield* json<StoreBody>(
					yield* request(apiFetch, "POST", "/v1/memory_stores", { name: "Other" }),
				)
				const base = `/v1/memory_stores/${store.id}/memories`
				const memory = yield* json<MemoryBody>(
					yield* request(apiFetch, "POST", base, { path: "/style.md", content: "Tabs." }),
				)
				const path = `${base}/${memory.id}`

				const stale = yield* request(apiFetch, "POST", path, {
					content: "Spaces.",
					precondition: { type: "content_sha256", content_sha256: sha256("Something else.") },
				})
				expect(stale.status).toBe(409)

				const guarded = yield* json<MemoryBody>(
					yield* request(apiFetch, "POST", path, {
						content: "Two spaces.",
						precondition: { type: "content_sha256", content_sha256: memory.content_sha256 },
					}),
				)
				expect(guarded).toMatchObject({
					id: memory.id,
					content: "Two spaces.",
					content_sha256: sha256("Two spaces."),
					version: 2,
				})
				const plain = yield* json<MemoryBody>(
					yield* request(apiFetch, "POST", path, { content: "Four spaces." }),
				)
				expect([plain.content, plain.version]).toEqual(["Four spaces.", 3])

				const elsewhere = `/v1/memory_stores/${other.id}/memories/${memory.id}`
				expect((yield* request(apiFetch, "GET", elsewhere)).status).toBe(404)
				expect((yield* request(apiFetch, "POST", elsewhere, { content: "x" })).status).toBe(404)
				expect((yield* request(apiFetch, "DELETE", elsewhere)).status).toBe(404)
				expect((yield* request(apiFetch, "GET", `${base}/mem_missing`)).status).toBe(404)
				expect(
					(yield* request(apiFetch, "POST", `${base}/mem_missing`, { content: "x" })).status,
				).toBe(404)

				expect(
					(yield* request(
						apiFetch,
						"DELETE",
						`${path}?expected_content_sha256=${sha256("Two spaces.")}`,
					)).status,
				).toBe(409)
				const deleted = yield* request(
					apiFetch,
					"DELETE",
					`${path}?expected_content_sha256=${sha256("Four spaces.")}`,
				)
				expect(yield* json(deleted)).toEqual({ id: memory.id, type: "memory_deleted" })
				expect((yield* request(apiFetch, "GET", path)).status).toBe(404)
				expect((yield* request(apiFetch, "DELETE", path)).status).toBe(404)
				expect((yield* request(apiFetch, "POST", path, { content: "back?" })).status).toBe(404)

				const again = yield* json<MemoryBody>(
					yield* request(apiFetch, "POST", base, { path: "/style.md", content: "Back." }),
				)
				expect([again.id, again.version]).toEqual([memory.id, 5])
			}),
		))

	it("makes an archived store's memories read-only and a deleted store's unreachable", () =>
		withApi((apiFetch) =>
			Effect.gen(function* () {
				const store = yield* json<StoreBody>(
					yield* request(apiFetch, "POST", "/v1/memory_stores", { name: "Notes" }),
				)
				const base = `/v1/memory_stores/${store.id}/memories`
				const memory = yield* json<MemoryBody>(
					yield* request(apiFetch, "POST", base, { path: "/style.md", content: "Tabs." }),
				)
				yield* request(apiFetch, "POST", `/v1/memory_stores/${store.id}/archive`)

				expect((yield* request(apiFetch, "GET", `${base}/${memory.id}`)).status).toBe(200)
				expect((yield* request(apiFetch, "GET", base)).status).toBe(200)
				expect(
					(yield* request(apiFetch, "POST", base, { path: "/new.md", content: "x" })).status,
				).toBe(409)
				expect(
					(yield* request(apiFetch, "POST", `${base}/${memory.id}`, { content: "x" })).status,
				).toBe(409)
				expect((yield* request(apiFetch, "DELETE", `${base}/${memory.id}`)).status).toBe(409)

				yield* request(apiFetch, "DELETE", `/v1/memory_stores/${store.id}`)
				expect((yield* request(apiFetch, "GET", `${base}/${memory.id}`)).status).toBe(404)
				expect((yield* request(apiFetch, "GET", base)).status).toBe(404)
				expect(
					(yield* request(apiFetch, "POST", base, { path: "/new.md", content: "x" })).status,
				).toBe(404)
			}),
		))
})
