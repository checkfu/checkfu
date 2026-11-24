import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type * as HttpServerRequest from "effect/http/HttpServerRequest"
import type * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Schedule from "effect/Schedule"
import { MAX_AGENT_SYSTEM_LENGTH } from "@checkfu/sdk/Schemas"
import { LIST_PAGE_BYTES } from "../src/Http/Listing.ts"
import { makeApiHandler } from "../src/Http/Router.ts"
import {
	AUTH_HEADERS,
	extractLastUserText,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendRequest,
} from "./helpers/ApiHarness.ts"

type ApiFetch = Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	never,
	HttpServerRequest.HttpServerRequest
>

interface Resource {
	readonly id: string
	readonly archived_at: string | null
}

interface ListBody {
	readonly data: ReadonlyArray<Resource>
	readonly has_more: boolean
	readonly next_cursor: string | null
}

const call = <A>(apiFetch: ApiFetch, method: string, path: string, body?: unknown) =>
	Effect.gen(function* () {
		const response = yield* sendRequest(apiFetch, {
			method,
			path,
			headers: AUTH_HEADERS,
			...(body === undefined ? {} : { body }),
		})
		return {
			status: response.status,
			body: (yield* Effect.promise(() => response.json())) as A,
		}
	})

const listed = (apiFetch: ApiFetch, path: string, count: number) =>
	call<ListBody>(apiFetch, "GET", path).pipe(
		Effect.repeat({
			schedule: Schedule.spaced("5 millis"),
			times: 400,
			until: (page) => page.body.data.length === count,
		}),
	)

const idsOf = (page: { readonly body: ListBody }) => page.body.data.map((resource) => resource.id)

const run = async <A>(body: (apiFetch: ApiFetch) => Effect.Effect<A>): Promise<A> => {
	const { layer, closeAll } = makePiDurableTestLayer(async (model, context) =>
		makeAssistantReply(model, null, `Done: ${extractLastUserText(context)}`, 4, 2),
	)
	try {
		return await Effect.runPromise(
			Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				return yield* body(apiFetch)
			}).pipe(Effect.scoped, Effect.provide(layer)),
		)
	} finally {
		await closeAll()
	}
}

const create = (apiFetch: ApiFetch, path: string, body: unknown) =>
	call<Resource>(apiFetch, "POST", path, body).pipe(Effect.map((created) => created.body.id))

describe("List endpoints", () => {
	it("lists agents oldest first, a page at a time in either order, without archived ones by default", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				expect(yield* call<ListBody>(apiFetch, "GET", "/v1/agents")).toEqual({
					status: 200,
					body: { data: [], has_more: false, next_cursor: null },
				})
				const ids: Array<string> = []
				for (const name of ["First", "Second", "Third"]) {
					ids.push(yield* create(apiFetch, "/v1/agents", { name, model: "gpt-4o-mini" }))
				}
				const all = yield* listed(apiFetch, "/v1/agents", 3)
				expect(idsOf(all)).toEqual(ids)
				expect(all.body).toMatchObject({ has_more: false, next_cursor: null })
				const fetched = yield* call<Resource>(apiFetch, "GET", `/v1/agents/${ids[0]}`)
				expect(all.body.data[0]).toEqual(fetched.body)

				const first = yield* call<ListBody>(apiFetch, "GET", "/v1/agents?limit=2")
				expect(idsOf(first)).toEqual(ids.slice(0, 2))
				expect(first.body.has_more).toBe(true)
				const second = yield* call<ListBody>(
					apiFetch,
					"GET",
					`/v1/agents?limit=2&after=${first.body.next_cursor}`,
				)
				expect(idsOf(second)).toEqual(ids.slice(2))
				expect(second.body).toMatchObject({ has_more: false, next_cursor: null })

				const newest = yield* call<ListBody>(apiFetch, "GET", "/v1/agents?order=desc&limit=2")
				expect(idsOf(newest)).toEqual([ids[2], ids[1]])
				const oldest = yield* call<ListBody>(
					apiFetch,
					"GET",
					`/v1/agents?order=desc&after=${newest.body.next_cursor}`,
				)
				expect(idsOf(oldest)).toEqual([ids[0]])

				yield* call(apiFetch, "POST", `/v1/agents/${ids[1]}/archive`)
				expect(idsOf(yield* listed(apiFetch, "/v1/agents", 2))).toEqual([ids[0], ids[2]])
				const withArchived = yield* call<ListBody>(
					apiFetch,
					"GET",
					"/v1/agents?include_archived=true",
				)
				expect(idsOf(withArchived)).toEqual(ids)
				expect(withArchived.body.data[1]?.archived_at).not.toBeNull()
				expect(
					idsOf(yield* call<ListBody>(apiFetch, "GET", "/v1/agents?include_archived=false")),
				).toEqual([ids[0], ids[2]])
			}),
		))

	it("lists environments, leaving out archived ones by default and deleted ones always", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const ids: Array<string> = []
				for (const name of ["kept", "archived", "deleted"]) {
					ids.push(yield* create(apiFetch, "/v1/environments", { name }))
				}
				expect(idsOf(yield* listed(apiFetch, "/v1/environments", 3))).toEqual(ids)
				yield* call(apiFetch, "POST", `/v1/environments/${ids[1]}/archive`)
				yield* call(apiFetch, "DELETE", `/v1/environments/${ids[2]}`)
				expect(idsOf(yield* listed(apiFetch, "/v1/environments", 1))).toEqual([ids[0]])
				expect(idsOf(yield* listed(apiFetch, "/v1/environments?include_archived=true", 2))).toEqual(
					[ids[0], ids[1]],
				)
				const fetched = yield* call<Resource>(apiFetch, "GET", `/v1/environments/${ids[0]}`)
				const page = yield* call<ListBody>(apiFetch, "GET", "/v1/environments")
				expect(page.body.data).toEqual([fetched.body])
			}),
		))

	it("lists sessions, filtered by agent when asked, without archived ones by default", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const reporter = yield* create(apiFetch, "/v1/agents", {
					name: "Reporter",
					model: "gpt-4o-mini",
				})
				const helper = yield* create(apiFetch, "/v1/agents", {
					name: "Helper",
					model: "gpt-4o-mini",
				})
				const environmentId = yield* create(apiFetch, "/v1/environments", { name: "Cloud" })
				const ids: Array<string> = []
				for (const agent of [reporter, helper, reporter]) {
					ids.push(
						yield* create(apiFetch, "/v1/sessions", { agent, environment_id: environmentId }),
					)
				}
				expect(idsOf(yield* listed(apiFetch, "/v1/sessions", 3))).toEqual(ids)
				expect(idsOf(yield* listed(apiFetch, `/v1/sessions?agent_id=${reporter}`, 2))).toEqual([
					ids[0],
					ids[2],
				])
				const fetched = yield* call<Resource>(apiFetch, "GET", `/v1/sessions/${ids[1]}`)
				const forHelper = yield* call<ListBody>(apiFetch, "GET", `/v1/sessions?agent_id=${helper}`)
				expect(forHelper.body.data).toEqual([fetched.body])

				yield* call(apiFetch, "POST", `/v1/sessions/${ids[0]}/archive`)
				expect(idsOf(yield* listed(apiFetch, `/v1/sessions?agent_id=${reporter}`, 1))).toEqual([
					ids[2],
				])
				expect(
					idsOf(
						yield* call<ListBody>(
							apiFetch,
							"GET",
							`/v1/sessions?agent_id=${reporter}&include_archived=true&order=desc`,
						),
					),
				).toEqual([ids[2], ids[0]])
				expect(
					yield* call<ListBody>(apiFetch, "GET", "/v1/sessions?agent_id=agent_missing"),
				).toMatchObject({ status: 200, body: { data: [], has_more: false, next_cursor: null } })
			}),
		))

	it("ends a page before its encoded resources pass the byte budget and continues after it", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const system = "\u0001".repeat(MAX_AGENT_SYSTEM_LENGTH)
				const ids: Array<string> = []
				for (let n = 0; n < 8; n++) {
					ids.push(
						yield* create(apiFetch, "/v1/agents", {
							name: `Big ${n}`,
							model: "gpt-4o-mini",
							system,
						}),
					)
				}
				yield* listed(apiFetch, "/v1/agents?limit=1", 1)
				const seen: Array<string> = []
				let path = "/v1/agents?limit=100"
				let pages = 0
				for (;;) {
					const page = yield* call<ListBody>(apiFetch, "GET", path)
					expect(page.status).toBe(200)
					pages += 1
					const encoded = page.body.data.reduce(
						(sum, agent) => sum + JSON.stringify(agent).length,
						0,
					)
					expect(page.body.data.length === 1 || encoded <= LIST_PAGE_BYTES).toBe(true)
					seen.push(...idsOf(page))
					if (page.body.next_cursor === null) {
						break
					}
					path = `/v1/agents?limit=100&after=${encodeURIComponent(page.body.next_cursor)}`
				}
				expect(pages).toBeGreaterThan(1)
				expect(seen).toEqual(ids)
			}),
		))

	it("refuses list paging values it cannot use", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				for (const path of ["/v1/agents", "/v1/environments", "/v1/sessions"]) {
					for (const query of [
						"limit=0",
						"limit=101",
						"after=-1",
						"after=3",
						"after=3:a%2Fb",
						"order=newest",
						"include_archived=yes",
					]) {
						const refused = yield* call(apiFetch, "GET", `${path}?${query}`)
						expect([path, query, refused.status]).toEqual([path, query, 400])
					}
				}
			}),
		))
})
