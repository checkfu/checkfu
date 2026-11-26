import { renderDeclarations } from "@earendil-works/pi-codemode/declarations"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as JsonSchema from "effect/JsonSchema"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { importOpenApi } from "../src/OpenApi/OpenApiImport.ts"
import type { OpenApiCatalog } from "../src/OpenApi/OpenApiImport.ts"
import { buildRequest } from "../src/OpenApi/OpenApiRequest.ts"
import { MAX_TOOL_NAME_LENGTH, ToolName, isSchemaObject } from "../src/OpenApi/OpenApiTypes.ts"
import type { ParameterSpec, ToolDescriptor } from "../src/OpenApi/OpenApiTypes.ts"

const BASE = "https://api.example.com/v1"
const OK = { "200": { description: "ok" } }

const document = (
	paths: Schema.JsonObject,
	{ components }: { readonly components?: Schema.JsonObject } = {},
	openapi = "3.1.0",
): Schema.JsonObject => ({
	openapi,
	info: { title: "Test", version: "1" },
	paths,
	...(components === undefined ? {} : { components }),
})

const describeTool = (catalog: OpenApiCatalog, name: string): ToolDescriptor =>
	Option.getOrThrow(catalog.descriptor(name))

const at = (schema: unknown, ...path: ReadonlyArray<string>): JsonSchema.JsonSchema | undefined => {
	let current = schema
	for (const key of path) {
		current = isSchemaObject(current) && Object.hasOwn(current, key) ? current[key] : undefined
	}
	return isSchemaObject(current) ? current : undefined
}

const parameter = (
	name: string,
	location: ParameterSpec["in"],
	overrides: Partial<ParameterSpec> = {},
): ParameterSpec => ({
	name,
	in: location,
	required: location === "path",
	style: location === "query" ? "form" : "simple",
	explode: location === "query",
	...overrides,
})

const tool = (overrides: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
	name: "tool",
	description: "",
	inputSchema: {},
	method: "get",
	pathTemplate: "/items/{id}",
	readOnly: true,
	parameters: [parameter("id", "path")],
	...overrides,
})

const reasonOf = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) =>
	Effect.map(Effect.flip(effect), (error) => error.reason)

describe("importOpenApi", () => {
	it.effect("names tools from operation ids, falls back to a slug, and settles collisions", () =>
		Effect.gen(function* () {
			const spec = document({
				"/users": {
					get: { operationId: "users.list", responses: OK },
					post: { responses: OK },
				},
				"/users/{id}": { get: { operationId: "users-list", responses: OK } },
				"/digits": { get: { operationId: "123", responses: OK } },
				"/2fa": { get: { operationId: "2fa/enable", responses: OK } },
				"/long": { get: { operationId: "x".repeat(200), responses: OK } },
				"/": { delete: { responses: OK } },
			})
			const catalog = yield* importOpenApi(spec)
			const names = catalog.operations.map((operation) => operation.name)

			expect(names.slice(0, 2)).toEqual(["users_list", "post_users"])
			expect(names[2]).toMatch(/^users_list_[0-9a-f]{8}$/)
			expect(names.slice(3, 5)).toEqual(["get_digits", "_2fa_enable"])
			expect(names[5]).toHaveLength(MAX_TOOL_NAME_LENGTH)
			expect(names[6]).toBe("delete")
			expect(new Set(names).size).toBe(names.length)
			expect(names.every(Schema.is(ToolName))).toBe(true)

			const again = yield* importOpenApi(JSON.stringify(spec))
			expect(again.operations.map((operation) => operation.name)).toEqual(names)

			const narrowed = yield* importOpenApi(spec, { exclude: { names: ["users_list"] } })
			expect(narrowed.operations.map((operation) => operation.name)).toEqual(names.slice(1))
		}),
	)

	it.effect("selects operations by name and by tag", () =>
		Effect.gen(function* () {
			const spec = document({
				"/a": { get: { operationId: "a", tags: ["read"], responses: OK } },
				"/b": { get: { operationId: "b", tags: ["read", "beta"], responses: OK } },
				"/c": { post: { operationId: "c", tags: ["write"], responses: OK } },
			})
			const names = (catalog: OpenApiCatalog) => catalog.operations.map(({ name }) => name)

			expect(names(yield* importOpenApi(spec, { include: { tags: ["read"] } }))).toEqual(["a", "b"])
			expect(
				names(
					yield* importOpenApi(spec, { include: { tags: ["read"] }, exclude: { tags: ["beta"] } }),
				),
			).toEqual(["a"])
			expect(
				names(yield* importOpenApi(spec, { include: { names: ["c"], tags: ["beta"] } })),
			).toEqual(["b", "c"])
			expect(
				Option.isNone((yield* importOpenApi(spec, { exclude: { names: ["a"] } })).descriptor("a")),
			).toBe(true)
		}),
	)

	it.effect("calls an operation read-only only when its method says so", () =>
		Effect.gen(function* () {
			const operation = { "x-read-only": true, description: "Read-only.", responses: OK }
			const catalog = yield* importOpenApi(
				document({
					"/a": {
						get: operation,
						head: operation,
						options: operation,
						post: operation,
						put: operation,
						patch: operation,
						delete: operation,
						trace: operation,
					},
				}),
			)
			expect(catalog.operations.map(({ method, readOnly }) => [method, readOnly])).toEqual([
				["get", true],
				["put", false],
				["post", false],
				["delete", false],
				["options", true],
				["head", true],
				["patch", false],
			])
		}),
	)

	it.effect("refuses documents it does not support", () =>
		Effect.gen(function* () {
			expect(yield* reasonOf(importOpenApi({ swagger: "2.0", paths: {} }))).toBe(
				"unsupported_version",
			)
			expect(yield* reasonOf(importOpenApi(document({}, {}, "4.0.0")))).toBe("unsupported_version")
			expect(yield* reasonOf(importOpenApi("{not json"))).toBe("not_json")
			expect(yield* reasonOf(importOpenApi("[1]"))).toBe("invalid_document")
			expect((yield* Effect.flip(importOpenApi({ swagger: "2.0" }))).message).toContain(
				"Swagger 2.0",
			)
		}),
	)

	it.effect("refuses references to other documents, but not data that looks like one", () =>
		Effect.gen(function* () {
			const remote = (ref: string) =>
				importOpenApi(
					document({
						"/a": { get: { parameters: [{ $ref: ref }], responses: OK } },
					}),
				)
			expect(yield* reasonOf(remote("https://evil.example/parameters.json#/Id"))).toBe(
				"remote_reference",
			)
			expect(yield* reasonOf(remote("./shared.yaml#/components/parameters/Id"))).toBe(
				"remote_reference",
			)

			const catalog = yield* importOpenApi(
				document({
					"/a": {
						post: {
							operationId: "create",
							requestBody: {
								content: {
									"application/json": {
										schema: {
											type: "object",
											properties: { $ref: { type: "string" } },
											example: { $ref: "https://example.com/not-a-reference" },
										},
									},
								},
							},
							responses: OK,
						},
					},
				}),
			)
			expect(
				at(describeTool(catalog, "create").inputSchema, "properties", "body", "properties", "$ref"),
			).toEqual({ type: "string" })
		}),
	)

	it.effect("bounds the size and depth of a document", () =>
		Effect.gen(function* () {
			let nested: Schema.Json = { type: "string" }
			for (let depth = 0; depth < 300; depth += 1) {
				nested = { type: "object", properties: { next: nested } }
			}
			const deep = document({}, { components: { schemas: { Deep: nested } } })
			expect(yield* reasonOf(importOpenApi(deep))).toBe("too_deep")
			expect(yield* reasonOf(importOpenApi(JSON.stringify(deep)))).toBe("too_deep")

			const loop: Array<Schema.Json> = []
			loop.push(loop)
			const cyclic = { openapi: "3.1.0", loop }
			expect(yield* reasonOf(importOpenApi(cyclic))).toBe("too_deep")

			const small = document({ "/a": { get: { responses: OK } }, "/b": { get: { responses: OK } } })
			expect(yield* reasonOf(importOpenApi(small, { limits: { maxNodes: 5 } }))).toBe("too_large")
			expect(
				yield* reasonOf(
					importOpenApi(JSON.stringify(small), { limits: { maxDocumentLength: 10 } }),
				),
			).toBe("too_large")
			expect(yield* reasonOf(importOpenApi(small, { limits: { maxOperations: 1 } }))).toBe(
				"too_many_operations",
			)
			expect(
				(yield* importOpenApi(small, {
					limits: { maxOperations: 1 },
					include: { names: ["get_a"] },
				})).operations,
			).toHaveLength(1)
		}),
	)

	it.effect("follows reference cycles once", () =>
		Effect.gen(function* () {
			const catalog = yield* importOpenApi(
				document(
					{
						"/pets": {
							get: {
								operationId: "list",
								parameters: [{ $ref: "#/components/parameters/A" }],
								responses: { "200": { $ref: "#/components/responses/Loop" } },
							},
							post: {
								operationId: "create",
								requestBody: { $ref: "#/components/requestBodies/Pet" },
								responses: {
									"201": {
										description: "created",
										content: {
											"application/json": { schema: { $ref: "#/components/schemas/Pet" } },
										},
									},
								},
							},
						},
					},
					{
						components: {
							parameters: {
								A: { $ref: "#/components/parameters/B" },
								B: { $ref: "#/components/parameters/A" },
							},
							responses: { Loop: { $ref: "#/components/responses/Loop" } },
							requestBodies: {
								Pet: {
									required: true,
									content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
								},
							},
							schemas: {
								Pet: {
									type: "object",
									properties: { owner: { $ref: "#/components/schemas/Owner" } },
								},
								Owner: {
									type: "object",
									properties: {
										pets: { type: "array", items: { $ref: "#/components/schemas/Pet" } },
										self: { $ref: "#/components/schemas/Owner" },
										missing: { $ref: "#/components/schemas/Nowhere" },
										elsewhere: { $ref: "#/components/parameters/A" },
									},
								},
							},
						},
					},
				),
			)
			const list = describeTool(catalog, "list")
			expect(list.parameters).toEqual([])
			expect(list.outputSchema).toBeUndefined()

			const create = describeTool(catalog, "create")
			expect(at(create.inputSchema, "properties", "body")).toEqual({ $ref: "#/$defs/Pet" })
			const definitions = at(create.inputSchema, "$defs")
			expect(Object.keys(definitions ?? {})).toEqual(["Pet", "Owner", "Nowhere"])
			expect(at(definitions, "Owner", "properties", "elsewhere")).toEqual({
				description: "A reference that could not be resolved was left out.",
			})
			expect(at(definitions, "Nowhere")).toEqual({
				description: "This schema is not defined in the document.",
			})
			// One copy of each definition, however many tools reach it.
			expect(at(create.outputSchema, "$defs", "Owner")).toBe(at(definitions, "Owner"))
			expect(at(describeTool(catalog, "create").inputSchema, "$defs", "Pet")).toBe(
				at(definitions, "Pet"),
			)
			expect(() => JSON.stringify(create)).not.toThrow()
		}),
	)

	it.effect("leaves out definitions past the per-tool limit", () =>
		Effect.gen(function* () {
			const catalog = yield* importOpenApi(
				document(
					{
						"/a": {
							post: {
								operationId: "a",
								requestBody: {
									content: { "application/json": { schema: { $ref: "#/components/schemas/A" } } },
								},
								responses: OK,
							},
						},
					},
					{
						components: {
							schemas: {
								A: { type: "object", properties: { b: { $ref: "#/components/schemas/B" } } },
								B: { type: "object", properties: { c: { $ref: "#/components/schemas/C" } } },
								C: { type: "string" },
							},
						},
					},
				),
				{ limits: { maxDefinitionsPerTool: 1 } },
			)
			expect(at(describeTool(catalog, "a").inputSchema, "$defs")).toEqual({
				A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } },
				B: { description: "Left out: this tool reaches too many schemas." },
			})
		}),
	)

	it.effect("reads nullable the OpenAPI 3.0 way and the 3.1 way", () =>
		Effect.gen(function* () {
			const paths = (schema: Schema.JsonObject): Schema.JsonObject => ({
				"/a": {
					get: {
						operationId: "a",
						parameters: [{ name: "q", in: "query", schema }],
						responses: OK,
					},
				},
			})
			const q = (catalog: OpenApiCatalog) =>
				at(describeTool(catalog, "a").inputSchema, "properties", "query", "properties", "q")

			expect(
				q(yield* importOpenApi(document(paths({ type: "string", nullable: true }), {}, "3.0.3"))),
			).toEqual({ type: ["string", "null"] })
			expect(
				q(
					yield* importOpenApi(
						document(paths({ type: "integer", minimum: 0, exclusiveMinimum: true }), {}, "3.0.3"),
					),
				),
			).toEqual({ type: "integer", exclusiveMinimum: 0 })
			expect(q(yield* importOpenApi(document(paths({ type: ["string", "null"] }))))).toEqual({
				type: ["string", "null"],
			})
			// In 3.1 `nullable` is not a keyword: it is carried along and changes nothing.
			expect(q(yield* importOpenApi(document(paths({ type: "string", nullable: true }))))).toEqual({
				type: "string",
				nullable: true,
			})
		}),
	)

	it.effect("never offers a parameter that carries a credential", () =>
		Effect.gen(function* () {
			const catalog = yield* importOpenApi(
				document(
					{
						"/a": {
							get: {
								operationId: "a",
								parameters: [
									{
										name: "Authorization",
										in: "header",
										required: true,
										schema: { type: "string" },
									},
									{ name: "cookie", in: "header", schema: { type: "string" } },
									{ name: "X-Api-Key", in: "header", required: true, schema: { type: "string" } },
									{ name: "api_key", in: "query", required: true, schema: { type: "string" } },
									{ name: "session", in: "cookie", required: true, schema: { type: "string" } },
									{ name: "Content-Type", in: "header", schema: { type: "string" } },
									{ name: "X-Trace", in: "header", schema: { type: "string" } },
									{ name: "q", in: "query", schema: { type: "string" } },
								],
								responses: OK,
							},
						},
					},
					{
						components: {
							securitySchemes: {
								header: { type: "apiKey", in: "header", name: "x-api-key" },
								query: { type: "apiKey", in: "query", name: "api_key" },
								bearer: { type: "http", scheme: "bearer" },
							},
						},
					},
				),
			)
			const descriptor = describeTool(catalog, "a")

			expect(descriptor.parameters.map(({ name }) => name)).toEqual(["X-Trace", "q"])
			expect(
				Object.keys(at(descriptor.inputSchema, "properties", "headers", "properties") ?? {}),
			).toEqual(["X-Trace"])
			expect(
				Object.keys(at(descriptor.inputSchema, "properties", "query", "properties") ?? {}),
			).toEqual(["q"])
			expect(catalog.security).toEqual([
				{ id: "header", type: "apiKey", in: "header", name: "x-api-key" },
				{ id: "query", type: "apiKey", in: "query", name: "api_key" },
				{ id: "bearer", type: "http", scheme: "bearer" },
			])
		}),
	)

	it.effect("skips operations it could not call, and says why", () =>
		Effect.gen(function* () {
			const catalog = yield* importOpenApi(
				document({
					"/upload": {
						post: {
							requestBody: { required: true, content: { "multipart/form-data": {} } },
							responses: OK,
						},
						put: {
							operationId: "optionalUpload",
							requestBody: { content: { "application/octet-stream": {} } },
							responses: OK,
						},
					},
					"/label/{id}": {
						get: {
							parameters: [{ name: "id", in: "path", required: true, style: "label", schema: {} }],
							responses: OK,
						},
					},
					"/search?kind=all": { get: { responses: OK } },
					relative: { get: { responses: OK } },
					"/implicit/{id}": { get: { operationId: "implicit", responses: OK } },
				}),
			)
			expect(catalog.skipped).toEqual([
				{ method: "post", path: "/upload", reason: "The request body is not JSON." },
				{
					method: "get",
					path: "/label/{id}",
					reason: 'The path parameter "id" is sent in a way that is not supported.',
				},
				{
					method: "get",
					path: "/search?kind=all",
					reason: "The path is not a plain path template.",
				},
				{ method: "get", path: "relative", reason: "The path is not a plain path template." },
			])
			expect(catalog.operations.map(({ name }) => name)).toEqual(["optionalUpload", "implicit"])
			expect(describeTool(catalog, "optionalUpload").body).toBeUndefined()
			expect(describeTool(catalog, "implicit").parameters).toEqual([parameter("id", "path")])
		}),
	)

	it.effect("caps descriptions", () =>
		Effect.gen(function* () {
			const catalog = yield* importOpenApi(
				document({
					"/a": {
						get: {
							operationId: "a",
							summary: "Summary",
							description: `${"d".repeat(40)}\u{1F600}`,
							parameters: [
								{ name: "q", in: "query", description: "p".repeat(40), schema: { type: "string" } },
								{
									name: "r",
									in: "query",
									schema: { type: "string", description: "s".repeat(40) },
								},
							],
							responses: OK,
						},
					},
				}),
				{ limits: { maxDescriptionLength: 50, maxSchemaDescriptionLength: 10 } },
			)
			const descriptor = describeTool(catalog, "a")

			expect(descriptor.description).toBe(`Summary\n\n${"d".repeat(40)}…`)
			expect(descriptor.description.isWellFormed()).toBe(true)
			expect(
				at(descriptor.inputSchema, "properties", "query", "properties", "q")?.["description"],
			).toBe(`${"p".repeat(9)}…`)
			expect(
				at(descriptor.inputSchema, "properties", "query", "properties", "r")?.["description"],
			).toBe(`${"s".repeat(9)}…`)
		}),
	)

	it.effect("keeps a parameter named like a prototype key as plain data", () =>
		Effect.gen(function* () {
			const catalog = yield* importOpenApi(
				document({
					"/a": {
						get: {
							operationId: "a",
							parameters: [
								{ name: "__proto__", in: "query", schema: { type: "string" } },
								{ name: "constructor", in: "query", schema: { type: "string" } },
							],
							responses: OK,
						},
					},
				}),
			)
			const descriptor = describeTool(catalog, "a")
			const properties = at(descriptor.inputSchema, "properties", "query", "properties") ?? {}

			expect(Object.keys(properties)).toEqual(["__proto__", "constructor"])
			expect(Object.getPrototypeOf(properties)).toBe(Object.prototype)
			expect((yield* buildRequest(descriptor, {}, BASE)).url).toBe(`${BASE}/a`)
			const args = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
				'{"query":{"__proto__":"x","constructor":"y"}}',
			)
			expect((yield* buildRequest(descriptor, args, BASE)).url).toBe(
				`${BASE}/a?__proto__=x&constructor=y`,
			)
		}),
	)

	it.effect("renders a small document as typed declarations", () =>
		Effect.gen(function* () {
			const catalog = yield* importOpenApi(
				document(
					{
						"/pets/{petId}": {
							parameters: [
								{ name: "petId", in: "path", required: true, schema: { type: "integer" } },
							],
							get: {
								operationId: "getPet",
								summary: "Get a pet",
								parameters: [
									{
										name: "expand",
										in: "query",
										description: "Related records to include",
										schema: { type: "array", items: { type: "string" } },
									},
								],
								responses: {
									"200": {
										description: "ok",
										content: {
											"application/json": { schema: { $ref: "#/components/schemas/Pet" } },
										},
									},
								},
							},
							put: {
								operationId: "updatePet",
								requestBody: {
									required: true,
									content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
								},
								responses: { "204": { description: "done" } },
							},
						},
					},
					{
						components: {
							schemas: {
								Pet: {
									type: "object",
									required: ["id", "name"],
									properties: {
										id: { type: "integer" },
										name: { type: "string", description: "Display name" },
										nickname: { type: "string", nullable: true },
									},
								},
							},
						},
					},
					"3.0.3",
				),
			)
			expect(
				renderDeclarations({
					tools: catalog.operations.map(({ name }) => ({
						...describeTool(catalog, name),
						execute: () => Promise.resolve(null),
					})),
				}),
			).toBe(
				[
					"declare const tools: {",
					"  /** Get a pet */",
					"  getPet(args: { path: {",
					"  // @integer",
					"  petId: number;",
					"}; query?: {",
					"  // Related records to include",
					"  expand?: Array<string>;",
					"}; }): Promise<{",
					"  // @integer",
					"  id: number;",
					"  // Display name",
					"  name: string;",
					"  nickname?: string | null;",
					"}>;",
					"  /** PUT /pets/{petId} */",
					"  updatePet(args: { body: {",
					"  // @integer",
					"  id: number;",
					"  // Display name",
					"  name: string;",
					"  nickname?: string | null;",
					"}; path: {",
					"  // @integer",
					"  petId: number;",
					"}; }): Promise<unknown>;",
					"};",
				].join("\n"),
			)
		}),
	)

	it.effect("imports the Checkfu API's own document", () =>
		Effect.gen(function* () {
			const document = readFileSync(new URL("../public/openapi.json", import.meta.url), "utf8")
			const catalog = yield* importOpenApi(document)
			const descriptors = catalog.operations.map(({ name }) => describeTool(catalog, name))

			expect(catalog.title).toBe("Checkfu API")
			expect(catalog.skipped).toEqual([
				{
					method: "put",
					path: "/v1/artifacts/{artifact_id}/blobs/{sha256}",
					reason: "The request body is not JSON.",
				},
			])
			expect(descriptors.length + catalog.skipped.length).toBe(
				document.split('"operationId"').length - 1,
			)
			expect(descriptors.every((descriptor) => Schema.is(ToolName)(descriptor.name))).toBe(true)
			expect(JSON.stringify(descriptors)).not.toContain("#/components/")
			const declarations = renderDeclarations({
				tools: descriptors.map((descriptor) => ({
					...descriptor,
					execute: () => Promise.resolve(null),
				})),
			})
			expect(declarations).toContain("agents_get(args: { path: {")

			const request = yield* buildRequest(
				describeTool(catalog, "agents_get"),
				{ path: { agent_id: "agent/../1" } },
				"https://checkfu.example",
			)
			expect(request).toEqual({
				method: "GET",
				url: "https://checkfu.example/v1/agents/agent%2F..%2F1",
				headers: {},
			})
		}),
	)
})

describe("buildRequest", () => {
	const urlOf = (descriptor: ToolDescriptor, args: Schema.Json, base = BASE) =>
		Effect.map(buildRequest(descriptor, args, base), (request) => request.url)

	it.effect("encodes a path argument so it stays one segment", () =>
		Effect.gen(function* () {
			const item = tool()
			expect(yield* urlOf(item, { path: { id: "a/b?c=d#e" } })).toBe(
				`${BASE}/items/a%2Fb%3Fc%3Dd%23e`,
			)
			expect(yield* urlOf(item, { path: { id: String.raw`a\b c%2e%2e` } })).toBe(
				`${BASE}/items/a%5Cb%20c%252e%252e`,
			)
			expect(yield* urlOf(item, { path: { id: 42 } })).toBe(`${BASE}/items/42`)
			expect(yield* urlOf(item, { path: { id: ["a", "b/c"] } })).toBe(`${BASE}/items/a,b%2Fc`)
			expect(yield* urlOf(item, { path: { id: "..." } })).toBe(`${BASE}/items/...`)

			for (const id of ["..", ".", ""]) {
				expect(yield* reasonOf(buildRequest(item, { path: { id } }, BASE))).toBe("unsafe_path")
			}
			expect(yield* reasonOf(buildRequest(item, { path: { id: [] } }, BASE))).toBe("unsafe_path")
			expect(yield* reasonOf(buildRequest(item, { path: {} }, BASE))).toBe("missing_argument")
			expect(yield* reasonOf(buildRequest(item, { path: { id: null } }, BASE))).toBe(
				"missing_argument",
			)
			expect(yield* reasonOf(buildRequest(item, { path: { id: { a: 1 } } }, BASE))).toBe(
				"unsupported_value",
			)
			expect(yield* reasonOf(buildRequest(item, { path: { id: "\ud800" } }, BASE))).toBe(
				"unsupported_value",
			)

			const joined = tool({
				pathTemplate: "/files/{a}{b}/raw",
				parameters: [parameter("a", "path"), parameter("b", "path")],
			})
			expect(yield* reasonOf(buildRequest(joined, { path: { a: ".", b: "." } }, BASE))).toBe(
				"unsafe_path",
			)
			expect(yield* urlOf(joined, { path: { a: ".", b: "x" } })).toBe(`${BASE}/files/.x/raw`)
		}),
	)

	it.effect("stays on the base URL's origin and under its path", () =>
		Effect.gen(function* () {
			const item = tool()
			expect(yield* urlOf(item, { path: { id: "1" } }, "https://api.example.com/v1/")).toBe(
				"https://api.example.com/v1/items/1",
			)
			expect(yield* urlOf(item, { path: { id: "1" } }, "http://localhost:8787")).toBe(
				"http://localhost:8787/items/1",
			)
			for (const base of [
				"ftp://api.example.com",
				"https://user:secret@api.example.com",
				"https://api.example.com/v1?key=1",
				"https://api.example.com/v1#frag",
				"api.example.com",
				"",
			]) {
				expect(yield* reasonOf(buildRequest(item, { path: { id: "1" } }, base))).toBe(
					"invalid_base_url",
				)
			}
			for (const pathTemplate of [
				"@evil.example/{id}",
				".evil.example/{id}",
				"/../{id}",
				"/a/./{id}",
				"/a?x={id}",
				"/a#{id}",
				String.raw`/a\..\..\{id}`,
			]) {
				expect(
					yield* reasonOf(buildRequest(tool({ pathTemplate }), { path: { id: "1" } }, BASE)),
				).toBe("unsafe_path")
			}
			expect(
				yield* urlOf(tool({ pathTemplate: "//evil.example/{id}" }), { path: { id: "1" } }),
			).toBe(`${BASE}//evil.example/1`)
		}),
	)

	it.effect("sends path and header parameters with a JSON media type as JSON", () =>
		Effect.gen(function* () {
			const filter = parameter("filter", "path", { style: "json" })
			const trace = parameter("x-trace", "header", { style: "json" })
			const send = (path: Schema.Json, header?: Schema.Json) =>
				buildRequest(
					tool({ pathTemplate: "/items/{filter}", parameters: [filter, trace] }),
					{
						path: { filter: path },
						...(header === undefined ? {} : { headers: { "x-trace": header } }),
					},
					BASE,
				)

			const request = yield* send({ tag: "a/b", n: 1 }, { id: "x", depth: 2 })
			expect(request.url).toBe(`${BASE}/items/${encodeURIComponent('{"tag":"a/b","n":1}')}`)
			expect(request.headers["x-trace"]).toBe('{"id":"x","depth":2}')
			// A string is sent quoted, as its JSON text.
			expect((yield* send("../admin")).url).toBe(
				`${BASE}/items/${encodeURIComponent('"../admin"')}`,
			)
			// JSON escapes a line break, so no header can be split.
			expect((yield* send(1, "a\r\nset-cookie: x")).headers["x-trace"]).toBe(
				String.raw`"a\r\nset-cookie: x"`,
			)
			expect(yield* reasonOf(send(1, "é ✓"))).toBe("unsupported_value")
		}),
	)

	it.effect("serializes query parameters by style", () =>
		Effect.gen(function* () {
			const search = (spec: ParameterSpec, value: Schema.Json) =>
				Effect.map(
					buildRequest(
						tool({ pathTemplate: "/search", parameters: [spec] }),
						{ query: { [spec.name]: value } },
						BASE,
					),
					(request) => request.url.slice(`${BASE}/search`.length),
				)
			const form = parameter("q", "query")
			const packed = parameter("q", "query", { explode: false })

			expect(yield* search(form, "a&b=c d")).toBe("?q=a%26b%3Dc%20d")
			expect(yield* search(form, 3)).toBe("?q=3")
			expect(yield* search(form, false)).toBe("?q=false")
			expect(yield* search(form, ["a", "b c"])).toBe("?q=a&q=b%20c")
			expect(yield* search(form, [])).toBe("")
			expect(yield* search(form, { role: "admin", "first name": "A B" })).toBe(
				"?role=admin&first%20name=A%20B",
			)
			expect(yield* search(packed, ["a", "b,c"])).toBe("?q=a,b%2Cc")
			expect(yield* search(packed, { role: "admin", n: 1 })).toBe("?q=role,admin,n,1")
			expect(
				yield* search(parameter("q", "query", { style: "spaceDelimited", explode: false }), [
					"a",
					"b",
				]),
			).toBe("?q=a%20b")
			expect(
				yield* search(parameter("q", "query", { style: "pipeDelimited", explode: false }), [
					"a",
					"b",
				]),
			).toBe("?q=a%7Cb")
			expect(
				yield* search(parameter("filter", "query", { style: "deepObject", explode: true }), {
					status: "open",
					"a b": 1,
				}),
			).toBe("?filter%5Bstatus%5D=open&filter%5Ba%20b%5D=1")
			expect(yield* search(parameter("q", "query", { style: "json" }), { a: [1, "x"] })).toBe(
				`?q=${encodeURIComponent('{"a":[1,"x"]}')}`,
			)
			expect(yield* search(form, null)).toBe("")

			const reason = (spec: ParameterSpec, value: Schema.Json) => reasonOf(search(spec, value))
			expect(yield* reason(form, [{ nested: 1 }])).toBe("unsupported_value")
			expect(yield* reason(form, { nested: { deeper: 1 } })).toBe("unsupported_value")
			expect(yield* reason(parameter("q", "query", { style: "deepObject" }), "text")).toBe(
				"unsupported_value",
			)
			expect(
				yield* reason(parameter("q", "query", { style: "pipeDelimited", explode: false }), {
					a: 1,
				}),
			).toBe("unsupported_value")
			expect(yield* reason(form, "\udfff")).toBe("unsupported_value")
			expect(yield* reason(parameter("q", "query", { required: true }), null)).toBe(
				"missing_argument",
			)
		}),
	)

	it.effect("sends only what the tool declares", () =>
		Effect.gen(function* () {
			const declared = tool({
				pathTemplate: "/search",
				parameters: [parameter("q", "query")],
			})
			for (const args of [
				{ query: { q: "x", api_key: "stolen" } },
				{ headers: { "X-Forwarded-For": "1.2.3.4" } },
				{ path: { id: "1" } },
				{ body: {} },
				{ cookies: { session: "x" } },
				{ query: "q=x" },
			] satisfies ReadonlyArray<Schema.Json>) {
				expect(yield* reasonOf(buildRequest(declared, args, BASE))).toBe("invalid_arguments")
			}
			expect(yield* reasonOf(buildRequest(declared, "q=x", BASE))).toBe("invalid_arguments")
			expect((yield* buildRequest(declared, undefined, BASE)).url).toBe(`${BASE}/search`)
		}),
	)

	it.effect("never sends a credential a caller or a descriptor asks for", () =>
		Effect.gen(function* () {
			const greedy = tool({
				pathTemplate: "/a",
				parameters: [
					parameter("Authorization", "header", { required: true }),
					parameter("Cookie", "header"),
					parameter("Proxy-Authorization", "header"),
					parameter("Host", "header"),
					parameter("X-Trace", "header"),
				],
			})
			const request = yield* buildRequest(
				greedy,
				{
					headers: {
						Authorization: "Bearer stolen",
						Cookie: "session=stolen",
						"Proxy-Authorization": "Basic stolen",
						Host: "evil.example",
						"X-Trace": ["a", "b"],
					},
				},
				BASE,
			)
			expect(request.headers).toEqual({ "x-trace": "a,b" })

			const plain = tool({ pathTemplate: "/a", parameters: [parameter("X-Trace", "header")] })
			expect(
				(yield* buildRequest(
					plain,
					{ headers: { authorization: "Bearer stolen", COOKIE: "x", "X-Trace": "t" } },
					BASE,
				)).headers,
			).toEqual({ "x-trace": "t" })
			expect(
				yield* reasonOf(
					buildRequest(plain, { headers: { "X-Trace": "a\r\nAuthorization: x" } }, BASE),
				),
			).toBe("unsupported_value")
			expect(yield* reasonOf(buildRequest(plain, { headers: { "X-Trace": "snow ☃" } }, BASE))).toBe(
				"unsupported_value",
			)
			expect(
				yield* reasonOf(
					buildRequest(
						tool({ pathTemplate: "/a", parameters: [parameter("Bad Name", "header")] }),
						{ headers: { "Bad Name": "x" } },
						BASE,
					),
				),
			).toBe("unsupported_value")
			expect(
				yield* reasonOf(
					buildRequest(
						tool({
							pathTemplate: "/a",
							parameters: [parameter("X-Need", "header", { required: true })],
						}),
						{},
						BASE,
					),
				),
			).toBe("missing_argument")
		}),
	)

	it.effect("sends a JSON body with the declared content type", () =>
		Effect.gen(function* () {
			const create = tool({
				method: "post",
				pathTemplate: "/items",
				readOnly: false,
				parameters: [],
				body: { contentType: "application/vnd.api+json", required: true },
			})
			expect(yield* buildRequest(create, { body: { name: "x", tags: [1, null] } }, BASE)).toEqual({
				method: "POST",
				url: `${BASE}/items`,
				headers: { "content-type": "application/vnd.api+json" },
				body: '{"name":"x","tags":[1,null]}',
			})
			expect((yield* buildRequest(create, { body: null }, BASE)).body).toBe("null")
			expect(yield* reasonOf(buildRequest(create, {}, BASE))).toBe("missing_argument")

			const optional = tool({
				...create,
				body: { contentType: "application/json", required: false },
			})
			expect(yield* buildRequest(optional, {}, BASE)).toEqual({
				method: "POST",
				url: `${BASE}/items`,
				headers: {},
			})
		}),
	)

	const files = tool({
		pathTemplate: "/users/{id}/files/{name}",
		parameters: [
			parameter("id", "path"),
			parameter("name", "path"),
			parameter("q", "query"),
			parameter("tag", "query"),
		],
	})

	it.prop(
		"never leaves the base URL, whatever the arguments",
		{ id: Schema.String, name: Schema.String, q: Schema.String, tags: Schema.Array(Schema.String) },
		({ id, name, q, tags }) => {
			const exit = Effect.runSyncExit(
				buildRequest(files, { path: { id, name }, query: { q, tag: tags } }, BASE),
			)
			const refused =
				[id, name].some((segment) => segment === "" || segment === "." || segment === "..") ||
				[id, name, q, ...tags].some((text) => !text.isWellFormed())
			expect(Exit.isFailure(exit)).toBe(refused)
			if (Exit.isSuccess(exit)) {
				const url = new URL(exit.value.url)
				expect(url.origin).toBe("https://api.example.com")
				expect(url.hash).toBe("")
				expect(url.pathname.split("/").map(decodeURIComponent)).toEqual([
					"",
					"v1",
					"users",
					id,
					"files",
					name,
				])
				expect(url.searchParams.getAll("q")).toEqual([q])
				expect(url.searchParams.getAll("tag")).toEqual(tags)
				expect([...url.searchParams.keys()].every((key) => key === "q" || key === "tag")).toBe(true)
			}
		},
	)
})
