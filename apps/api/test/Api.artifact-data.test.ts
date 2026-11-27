import { MAX_ARTIFACT_DOCUMENT_BYTES } from "@checkfu/sdk/Limits"
import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import { ArtifactDatabase } from "../src/ArtifactData/ArtifactDatabase.ts"
import { makeApiHandler } from "../src/Http/Router.ts"
import {
	AUTH_HEADERS,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendRequest,
} from "./helpers/ApiHarness.ts"

interface DocumentBody {
	readonly id: string
	readonly type: string
	readonly artifact_id: string
	readonly collection: string
	readonly data: unknown
	readonly created_at: string
	readonly updated_at: string
}

interface ListBody {
	readonly data: ReadonlyArray<DocumentBody>
	readonly next_page: string | null
}

interface ErrorBody {
	readonly error: { readonly type: string; readonly message: string }
}

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

const eventually = (check: Effect.Effect<boolean>, what: string) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 200; attempt += 1) {
			if (yield* check) {
				return
			}
			yield* Effect.sleep("5 millis")
		}
		return yield* Effect.die(new Error(`Never happened: ${what}`))
	})

const withData = <A>(
	run: (world: {
		readonly call: (
			method: string,
			path: string,
			body?: unknown,
			headers?: Record<string, string>,
		) => Effect.Effect<Response>
		readonly artifact: (name: string) => Effect.Effect<string>
		readonly database: ArtifactDatabase["Service"]
	}) => Effect.Effect<A>,
) => {
	const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
		makeAssistantReply(model, null, "unused", 1, 1),
	)
	return Effect.runPromise(
		Effect.gen(function* () {
			const { fetch: apiFetch } = yield* makeApiHandler
			const call = (
				method: string,
				path: string,
				body?: unknown,
				headers?: Record<string, string>,
			) =>
				sendRequest(apiFetch, {
					method,
					path,
					...(body === undefined ? {} : { body }),
					headers: { ...AUTH_HEADERS, ...headers },
				})
			return yield* run({
				call,
				database: yield* ArtifactDatabase,
				artifact: (name) =>
					Effect.map(
						Effect.flatMap(
							call("POST", "/v1/artifacts", {
								name,
								files: [{ path: "index.html", content: `<h1>${name}</h1>` }],
							}),
							(res) => json<{ id: string }>(res),
						),
						(body) => body.id,
					),
			})
		}).pipe(Effect.scoped, Effect.provide(layer), Effect.ensuring(Effect.promise(closeAll))),
	)
}

describe("An artifact's data API", () => {
	it("adds, lists, retrieves, replaces and deletes documents, and describes what the database holds", () =>
		withData(({ call, artifact }) =>
			Effect.gen(function* () {
				const id = yield* artifact("Poll")
				const data = `/v1/artifacts/${id}/data`
				expect(yield* json(yield* call("GET", data))).toEqual({
					type: "artifact_database",
					artifact_id: id,
					bytes: 0,
					collections: [],
				})

				const added = yield* call("POST", `${data}/votes`, {
					data: { choice: "b", tags: ["x", 1, null, true], nested: { deep: { er: 1.5 } } },
				})
				expect(added.status).toBe(201)
				const vote = yield* json<DocumentBody>(added)
				expect(vote).toEqual({
					id: expect.stringMatching(/^doc_[0-9a-f]{24}$/),
					type: "artifact_document",
					artifact_id: id,
					collection: "votes",
					data: { choice: "b", tags: ["x", 1, null, true], nested: { deep: { er: 1.5 } } },
					created_at: expect.any(String),
					updated_at: vote.created_at,
				})
				expect(yield* json(yield* call("GET", `${data}/votes/${vote.id}`))).toEqual(vote)

				for (const value of ["text", 7, null, false, [1, 2]]) {
					const res = yield* call("POST", `${data}/votes`, { data: value })
					expect((yield* json<DocumentBody>(res)).data).toEqual(value)
				}

				const put = yield* call("PUT", `${data}/settings/theme`, { data: "dark" })
				expect(put.status).toBe(200)
				expect(yield* json(put)).toMatchObject({
					id: "theme",
					collection: "settings",
					data: "dark",
				})
				const replaced = yield* json<DocumentBody>(
					yield* call("PUT", `${data}/votes/${vote.id}`, { data: { choice: "a" } }),
				)
				expect(replaced).toMatchObject({
					id: vote.id,
					data: { choice: "a" },
					created_at: vote.created_at,
				})

				const first = yield* json<ListBody>(yield* call("GET", `${data}/votes?limit=4`))
				expect(first.data.map((document) => document.data)).toEqual([
					{ choice: "a" },
					"text",
					7,
					null,
				])
				expect(first.next_page).not.toBeNull()
				const rest = yield* json<ListBody>(
					yield* call("GET", `${data}/votes?limit=4&page=${first.next_page}`),
				)
				expect(rest.data.map((document) => document.data)).toEqual([false, [1, 2]])
				expect(rest.next_page).toBeNull()
				expect(yield* json(yield* call("GET", `${data}/unused`))).toEqual({
					data: [],
					next_page: null,
				})

				expect(yield* json(yield* call("GET", data))).toMatchObject({
					collections: [
						{ name: "settings", documents: 1, bytes: 6 },
						{ name: "votes", documents: 6 },
					],
				})

				const deleted = yield* call("DELETE", `${data}/settings/theme`)
				expect(deleted.status).toBe(200)
				expect(yield* json(deleted)).toEqual({ id: "theme", type: "artifact_document_deleted" })
				expect((yield* call("GET", `${data}/settings/theme`)).status).toBe(404)
				expect((yield* call("DELETE", `${data}/settings/theme`)).status).toBe(404)
				expect(
					(yield* json<{ collections: ReadonlyArray<{ name: string }> }>(
						yield* call("GET", data),
					)).collections.map((collection) => collection.name),
				).toEqual(["votes"])
			}),
		))

	it("adds a document once however often the same Idempotency-Key is sent", () =>
		withData(({ call, artifact }) =>
			Effect.gen(function* () {
				const id = yield* artifact("Form")
				const path = `/v1/artifacts/${id}/data/responses`
				const key = { "idempotency-key": "response-1" }
				const first = yield* json<DocumentBody>(
					yield* call("POST", path, { data: { answer: 1 } }, key),
				)
				const again = yield* call("POST", path, { data: { answer: 1 } }, key)
				expect(again.status).toBe(201)
				expect(yield* json(again)).toEqual(first)

				const other = yield* call("POST", path, { data: { answer: 2 } }, key)
				expect(other.status).toBe(409)
				expect((yield* json<ErrorBody>(other)).error.message).toContain("Idempotency-Key")

				const elsewhere = yield* json<DocumentBody>(
					yield* call("POST", `/v1/artifacts/${id}/data/other`, { data: { answer: 1 } }, key),
				)
				expect(elsewhere.id).not.toBe(first.id)
				yield* call("POST", path, { data: { answer: 1 } })
				yield* call("POST", path, { data: { answer: 1 } })
				expect((yield* json<ListBody>(yield* call("GET", path))).data).toHaveLength(3)
			}),
		))

	it("refuses names, ids and documents it cannot hold, and artifacts that do not exist", () =>
		withData(({ call, artifact }) =>
			Effect.gen(function* () {
				const id = yield* artifact("Strict")
				const data = `/v1/artifacts/${id}/data`
				const status = (method: string, path: string, body?: unknown) =>
					Effect.map(call(method, path, body), (res) => res.status)

				expect(yield* status("POST", `${data}/Votes`, { data: 1 })).toBe(400)
				expect(yield* status("GET", `${data}/9votes`)).toBe(400)
				expect(yield* status("PUT", `${data}/votes/has.dot`, { data: 1 })).toBe(400)
				expect(yield* status("PUT", `${data}/votes/${"x".repeat(65)}`, { data: 1 })).toBe(400)
				expect(yield* status("POST", `${data}/votes`, {})).toBe(400)
				expect(yield* status("POST", `${data}/votes`, { data: 1, extra: 2 })).toBe(400)
				expect(yield* status("GET", `${data}/votes?limit=0`)).toBe(400)
				expect(yield* status("GET", `${data}/votes?page=abc`)).toBe(400)
				expect(yield* status("GET", `${data}/votes/missing`)).toBe(404)

				const fits = "x".repeat(MAX_ARTIFACT_DOCUMENT_BYTES - 2)
				expect(yield* status("PUT", `${data}/votes/large`, { data: fits })).toBe(200)
				const tooLarge = yield* call("PUT", `${data}/votes/large`, { data: `${fits}x` })
				expect(tooLarge.status).toBe(400)
				expect((yield* json<ErrorBody>(tooLarge)).error.message).toContain(
					`${MAX_ARTIFACT_DOCUMENT_BYTES} bytes`,
				)
				expect((yield* json<DocumentBody>(yield* call("GET", `${data}/votes/large`))).data).toBe(
					fits,
				)

				const missing = "/v1/artifacts/art_000000000000000000000000/data"
				expect(yield* status("GET", missing)).toBe(404)
				expect(yield* status("GET", `${missing}/votes`)).toBe(404)
				expect(yield* status("POST", `${missing}/votes`, { data: 1 })).toBe(404)
				expect(yield* status("GET", `${missing}/votes/a`)).toBe(404)
				expect(yield* status("PUT", `${missing}/votes/a`, { data: 1 })).toBe(404)
				expect(yield* status("DELETE", `${missing}/votes/a`)).toBe(404)
				expect((yield* call("GET", data, undefined, { authorization: "" })).status).toBe(401)
			}),
		))

	it("keeps each artifact's data to itself, and keeps it through new versions and publishing", () =>
		withData(({ call, artifact }) =>
			Effect.gen(function* () {
				const one = yield* artifact("One")
				const two = yield* artifact("Two")
				yield* call("PUT", `/v1/artifacts/${one}/data/notes/shared-id`, { data: "one's" })
				yield* call("PUT", `/v1/artifacts/${two}/data/notes/shared-id`, { data: "two's" })
				const read = (id: string) =>
					Effect.map(
						Effect.flatMap(call("GET", `/v1/artifacts/${id}/data/notes/shared-id`), (res) =>
							json<DocumentBody>(res),
						),
						(document) => document.data,
					)
				expect(yield* read(one)).toBe("one's")
				expect(yield* read(two)).toBe("two's")

				expect(
					(yield* call("POST", `/v1/artifacts/${one}/versions`, {
						version: 1,
						files: [{ path: "index.html", content: "<h1>One, again</h1>" }],
					})).status,
				).toBe(201)
				expect((yield* call("POST", `/v1/artifacts/${one}/publication`, {})).status).toBe(200)
				expect((yield* call("DELETE", `/v1/artifacts/${one}/publication`)).status).toBe(200)
				expect(yield* read(one)).toBe("one's")
				expect(
					(yield* json<{ version: number }>(yield* call("GET", `/v1/artifacts/${one}`))).version,
				).toBe(2)
			}),
		))

	it("erases the data with the artifact, and refuses a write that arrives afterwards", () =>
		withData(({ call, artifact, database }) =>
			Effect.gen(function* () {
				const id = yield* artifact("Short-lived")
				const kept = yield* artifact("Kept")
				const data = `/v1/artifacts/${id}/data`
				yield* call("PUT", `${data}/notes/a`, { data: "gone soon" })
				yield* call("PUT", `/v1/artifacts/${kept}/data/notes/a`, { data: "stays" })

				expect((yield* call("DELETE", `/v1/artifacts/${id}`)).status).toBe(200)
				expect((yield* call("GET", data)).status).toBe(404)
				expect((yield* call("GET", `${data}/notes`)).status).toBe(404)
				expect((yield* call("GET", `${data}/notes/a`)).status).toBe(404)
				expect((yield* call("PUT", `${data}/notes/a`, { data: "back" })).status).toBe(404)
				expect((yield* call("POST", `${data}/notes`, { data: "back" })).status).toBe(404)

				yield* eventually(
					Effect.map(
						Effect.orDie(database.write(id, "notes", "late", '"late"', "replace")),
						(outcome) => outcome.refused === "erased",
					),
					"the deleted artifact's database refusing a late write",
				)
				expect(yield* Effect.orDie(database.get(id, "notes", "a"))).toBeNull()
				expect(yield* Effect.orDie(database.usage(id))).toEqual({ collections: [], bytes: 0 })
				expect(
					(yield* json<DocumentBody>(yield* call("GET", `/v1/artifacts/${kept}/data/notes/a`)))
						.data,
				).toBe("stays")
			}),
		))
})
