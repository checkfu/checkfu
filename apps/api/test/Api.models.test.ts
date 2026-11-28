import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { DEFAULT_PROVIDERS } from "@checkfu/pi-providers/catalog"
import { makeApiHandler } from "../src/Http/Router.ts"
import {
	AUTH_HEADERS,
	TEST_API_KEY,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendRequest,
} from "./helpers/ApiHarness.ts"

const candidate = "shared-report"
const unicode = "犬".repeat(240)
const capacity = { context_window: 128_000, max_tokens: 4096 }
const defaults = Object.fromEntries(
	Array.from({ length: 51 }, (_entry, index) => [`page-default-${index}`, capacity]),
)
const declaration = {
	name: "Fixture",
	format: DEFAULT_PROVIDERS[0].defaultFormat,
	context_window: 128_000,
	max_tokens: 4096,
	allow_unlisted_models: true,
	models: {
		...defaults,
		[candidate]: capacity,
		[unicode + "a"]: capacity,
		[unicode + "b"]: capacity,
	},
}

const catalog = JSON.stringify([
	{ ...declaration, id: "lab", default_model: "lab/custom-default" },
	{ ...declaration, id: "studio", default_model: `studio/${candidate}` },
])

const modelPage = Schema.decodeUnknownSync(
	Schema.Struct({
		data: Schema.Array(Schema.Struct({ type: Schema.Literal("model"), id: Schema.String })),
		next_page: Schema.NullOr(Schema.String),
	}),
	{ onExcessProperty: "error" },
)

it("lists only authenticated catalog suggestions and accepts a listed or manually typed model", async () => {
	let providerRuns = 0
	const { layer, closeAll } = makePiDurableTestLayer(
		async (model) => {
			providerRuns += 1
			return makeAssistantReply(model, null, "ok", 1, 1)
		},
		{ env: { CHECKFU_API_KEY: TEST_API_KEY, CHECKFU_PROVIDER_CATALOG: catalog } },
	)
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { fetch } = yield* makeApiHandler
					const noAuth = yield* sendRequest(fetch, { method: "GET", path: "/v1/models" })
					expect(noAuth.status).toBe(401)
					expect(yield* Effect.promise(() => noAuth.text())).not.toContain(candidate)
					const list = (path: string) =>
						sendRequest(fetch, { method: "GET", path, headers: AUTH_HEADERS })
					const defaultLimit = yield* list("/v1/models?search=page-default-")
					expect(defaultLimit.status).toBe(200)
					const defaultPage = modelPage(yield* Effect.promise(() => defaultLimit.json()))
					expect(defaultPage.data).toHaveLength(50)
					expect(defaultPage.next_page).toEqual(expect.any(String))
					const first = yield* list("/v1/models?search=shared-report&limit=1")
					expect(first.status).toBe(200)
					expect(first.headers.get("cache-control")).toContain("no-store")
					const content = yield* Effect.promise(() => first.json())
					const page1 = modelPage(content)
					expect(page1.data).toEqual([{ type: "model", id: `lab/${candidate}` }])
					if (page1.next_page === null) {
						throw new Error("Expected continuation")
					}
					const next = encodeURIComponent(page1.next_page)
					const second = yield* list(`/v1/models?search=shared-report&limit=1&page=${next}`)
					const secondBody: unknown = yield* Effect.promise(() => second.json())
					expect(second.status, JSON.stringify(secondBody)).toBe(200)
					expect(modelPage(secondBody)).toEqual({
						data: [{ type: "model", id: `studio/${candidate}` }],
						next_page: null,
					})
					expect((yield* list(`/v1/models?search=different&page=${next}`)).status).toBe(400)
					expect((yield* list("/v1/models?page=invalid_token")).status).toBe(400)
					const unicodeSearch = "/v1/models?search=" + encodeURIComponent(unicode) + "&limit=1"
					const longFirst = yield* list(unicodeSearch)
					expect(longFirst.status).toBe(200)
					const longPage = modelPage(yield* Effect.promise(() => longFirst.json()))
					expect(longPage.data).toEqual([{ type: "model", id: "lab/" + unicode + "a" }])
					if (longPage.next_page === null) {
						throw new Error("Expected a continuation for the Unicode search.")
					}
					const longSecond = yield* list(
						unicodeSearch + "&page=" + encodeURIComponent(longPage.next_page),
					)
					expect(longSecond.status).toBe(200)
					expect(modelPage(yield* Effect.promise(() => longSecond.json())).data).toEqual([
						{ type: "model", id: "lab/" + unicode + "b" },
					])

					const defaultResponse = yield* list("/v1/models?search=custom-default")
					const defaultBody: unknown = yield* Effect.promise(() => defaultResponse.json())
					expect(defaultResponse.status, JSON.stringify(defaultBody)).toBe(200)
					expect(modelPage(defaultBody).data).toEqual([{ type: "model", id: "lab/custom-default" }])
					for (const model of ["lab/custom-default", "lab/not-in-suggestions"]) {
						const response = yield* sendRequest(fetch, {
							method: "POST",
							path: "/v1/agents",
							headers: AUTH_HEADERS,
							body: { name: "An agent", model },
						})
						expect(response.status).toBe(201)
						expect(yield* Effect.promise(() => response.json())).toMatchObject({
							model: { id: model },
						})
					}
				}).pipe(Effect.provide(layer)),
			),
		)
		expect(providerRuns).toBe(0)
	} finally {
		await closeAll()
	}
})
