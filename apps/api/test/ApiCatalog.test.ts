import { describe, expect, it } from "@effect/vitest"
import {
	MAX_API_SERVER_DESCRIPTORS_JSON_BYTES,
	MAX_API_SERVER_OPERATIONS,
} from "@checkfu/domain/Mcp/ApiServers"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import {
	UNCONFIRMED_CATALOG_TTL_MS,
	importApiServer,
	makeApiCatalog,
} from "../src/OpenApi/ApiCatalogStore.ts"
import type { CatalogConfig } from "../src/OpenApi/ApiCatalogStore.ts"

const BASE = "https://api.shop.example/v1"

interface Fields {
	readonly [field: string]: Schema.Json
}

const operation = (operationId: string, tag: string, extra: Fields = {}) => ({
	operationId,
	tags: [tag],
	responses: { "200": { description: "ok" } },
	...extra,
})

const SHOP: Fields = {
	openapi: "3.0.3",
	info: { title: "Shop", version: "1" },
	paths: {
		"/pets/{petId}": {
			get: operation("getPet", "pets", {
				parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
			}),
			delete: operation("deletePet", "pets", {
				parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
			}),
		},
		"/orders": { get: operation("listOrders", "orders") },
	},
}

const many = (count: number, description = "An operation."): Fields => ({
	openapi: "3.0.3",
	info: { title: "Many", version: "1" },
	paths: Object.fromEntries(
		Array.from({ length: count }, (_unused, index) => [
			`/things/${index}`,
			{ get: { ...operation(`getThing${index}`, "things"), description } },
		]),
	),
})

const read = (document: Fields, selection: Parameters<typeof importApiServer>[1] = {}) =>
	Effect.runPromise(importApiServer(JSON.stringify(document), selection))

const refusal = async (...args: Parameters<typeof read>) => {
	const imported = await read(...args)
	return imported.ok ? "accepted" : imported.message
}

const memory = () => {
	const kv = new Map<string, string>()
	const state = {
		get document() {
			return kv.get("document") ?? null
		},
		alarm: null as number | null,
		now: 1000,
	}
	const reads = { document: 0 }
	const catalog = makeApiCatalog(
		{
			get: (key) => {
				if (key === "document") {
					reads.document += 1
				}
				return kv.get(key)
			},
			put: (key, value) => {
				kv.set(key, value)
			},
			clear: () => {
				kv.clear()
				return Promise.resolve()
			},
			setAlarm: (at) => {
				state.alarm = at
				return Promise.resolve()
			},
			deleteAlarm: () => {
				state.alarm = null
				return Promise.resolve()
			},
		},
		() => state.now,
	)
	return { catalog, state, kv, reads }
}

const config = (extra: Partial<CatalogConfig> = {}): CatalogConfig => ({
	base_url: BASE,
	digest: "sha256:one",
	...extra,
})

describe("an OpenAPI document as an API server's tools", () => {
	it("makes one tool per operation and lets only the HTTP method mark a read", async () => {
		const imported = await read(SHOP)
		expect(imported.ok && imported.tools.map((tool) => [tool.name, tool.readOnly])).toEqual([
			["getPet", true],
			["deletePet", undefined],
			["listOrders", true],
		])
	})

	it("keeps the operations include picks and drops those exclude names", async () => {
		const pets = await read(SHOP, {
			include: { tags: ["pets"] },
			exclude: { names: ["deletePet"] },
		})
		expect(pets.ok && pets.tools.map((tool) => tool.name)).toEqual(["getPet"])
	})

	it("refuses a filter that names nothing in the document, or leaves nothing", async () => {
		expect(await refusal(SHOP, { include: { names: ["getPets"] } })).toContain(
			'include.names lists "getPets"',
		)
		expect(await refusal(SHOP, { exclude: { tags: ["nope"] } })).toContain(
			'exclude.tags lists "nope"',
		)
		expect(await refusal(SHOP, { exclude: { tags: ["pets", "orders"] } })).toContain(
			"no operation that can be a tool",
		)
	})

	it("refuses more operations than a server may have until they are narrowed", async () => {
		const document = many(MAX_API_SERVER_OPERATIONS + 1)
		expect(await refusal(document)).toContain(`at most ${MAX_API_SERVER_OPERATIONS}`)
		expect(await refusal(document, { exclude: { names: ["getThing0"] } })).toBe("accepted")
	})

	it("refuses operations whose descriptions come to more than a session can cache", async () => {
		const wordy = many(MAX_API_SERVER_OPERATIONS, "d".repeat(1000))
		const imported = await read(wordy)
		const size = imported.ok ? JSON.stringify(imported.tools).length : 0
		// The importer caps a description, so only many large schemas can reach the bound.
		expect(size).toBeLessThan(MAX_API_SERVER_DESCRIPTORS_JSON_BYTES)
		const heavy: Fields = {
			...wordy,
			paths: Object.fromEntries(
				Array.from({ length: MAX_API_SERVER_OPERATIONS }, (_unused, index) => [
					`/things/${index}`,
					{
						post: {
							...operation(`makeThing${index}`, "things"),
							requestBody: {
								required: true,
								content: {
									"application/json": {
										schema: {
											type: "object",
											properties: Object.fromEntries(
												Array.from({ length: 60 }, (_field, field) => [
													`field_${index}_${field}`,
													{ type: "string", description: "x".repeat(80) },
												]),
											),
										},
									},
								},
							},
						},
					},
				]),
			),
		}
		expect(await refusal(heavy)).toContain("bytes of tool descriptions")
	})

	it("says what is wrong with a document it cannot read", async () => {
		expect(
			await refusal({ swagger: "2.0", info: { title: "Old", version: "1" }, paths: {} }),
		).not.toBe("accepted")
		expect(await Effect.runPromise(importApiServer("{not json", {}))).toMatchObject({ ok: false })
	})
})

describe("custody of an API server's document", () => {
	it("holds a document unconfirmed and erases it unless something confirms it", async () => {
		const { catalog, state } = memory()
		expect(await catalog.store(JSON.stringify(SHOP), config())).toBe(true)
		expect(state.alarm).toBe(1000 + UNCONFIRMED_CATALOG_TTL_MS)

		await catalog.expire()
		expect(state.document).toBeNull()
		expect(await catalog.tools()).toMatchObject({ ok: false })
	})

	it("keeps a document once its agent version confirms it, or a session lists its tools", async () => {
		const confirmed = memory()
		await confirmed.catalog.store(JSON.stringify(SHOP), config())
		await confirmed.catalog.keep()
		expect(confirmed.state.alarm).toBeNull()
		await confirmed.catalog.expire()
		expect(confirmed.state.document).not.toBeNull()

		const listed = memory()
		await listed.catalog.store(JSON.stringify(SHOP), config())
		const tools = await listed.catalog.tools()
		expect(tools.ok && tools.tools.map((tool) => tool.name)).toEqual([
			"getPet",
			"deletePet",
			"listOrders",
		])
		await listed.catalog.expire()
		expect(listed.state.document).not.toBeNull()
	})

	it("takes the same document again and refuses another under the same name", async () => {
		const { catalog, state } = memory()
		await catalog.store(JSON.stringify(SHOP), config())
		expect(await catalog.store(JSON.stringify(SHOP), config())).toBe(true)
		expect(await catalog.store(JSON.stringify(many(2)), config({ digest: "sha256:two" }))).toBe(
			false,
		)
		expect(state.document).toBe(JSON.stringify(SHOP))
	})

	it("serves only the picked operations and builds a call's request under the base URL", async () => {
		const { catalog } = memory()
		await catalog.store(JSON.stringify(SHOP), config({ include: { tags: ["pets"] } }))
		const tools = await catalog.tools()
		expect(tools.ok && tools.tools.map((tool) => tool.name)).toEqual(["getPet", "deletePet"])

		expect(await catalog.request("getPet", { path: { petId: "a/b" } })).toEqual({
			ok: true,
			request: { method: "GET", url: `${BASE}/pets/a%2Fb`, headers: expect.any(Object) },
		})
		expect(await catalog.request("listOrders", {})).toMatchObject({ ok: false })
		expect(await catalog.request("getPet", { path: { petId: ".." } })).toMatchObject({ ok: false })
		expect(await catalog.request("getPet", {})).toMatchObject({ ok: false })
	})

	it("reads the document only to build the catalog, not on every call", async () => {
		const { catalog, reads } = memory()
		await catalog.store(JSON.stringify(SHOP), config())
		await catalog.tools()
		const first = reads.document
		await catalog.tools()
		await catalog.request("getPet", { path: { petId: "1" } })
		expect(reads.document).toBe(first)
	})
})
