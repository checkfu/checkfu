import { describe, expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import {
	API_DOMAIN_ENV,
	DETACH_ALL,
	MCP_DOMAIN_ENV,
	PUBLISH_DOMAIN_ENV,
	customDomains,
	publishDomain,
} from "../src/CustomDomain.ts"
import { CONTENT_WORKER_PROPS, contentWorkerProps } from "../src/Content/ContentWorker.ts"

const parse = (env: Record<string, string>) =>
	customDomains.parse(ConfigProvider.fromUnknown(env, { preserveEmptyStrings: true }))

const refused = (env: Record<string, string>) =>
	Effect.map(Effect.exit(parse(env)), (exit) =>
		Exit.isFailure(exit) ? String(exit.cause) : "accepted",
	)

describe("custom domains", () => {
	it.effect("leaves each Worker's hostnames untouched when its variable is unset or empty", () =>
		Effect.gen(function* () {
			expect(yield* parse({})).toEqual({ api: {}, mcp: {} })
			expect(yield* parse({ [API_DOMAIN_ENV]: "", [MCP_DOMAIN_ENV]: "" })).toEqual({
				api: {},
				mcp: {},
			})
		}),
	)

	it.effect("gives each Worker the hostname named for it", () =>
		Effect.gen(function* () {
			expect(
				yield* parse({ [API_DOMAIN_ENV]: "api.example.com", [MCP_DOMAIN_ENV]: "A-1.Example.dev" }),
			).toEqual({ api: { domain: "api.example.com" }, mcp: { domain: "A-1.Example.dev" } })
			expect(yield* parse({ [API_DOMAIN_ENV]: "xn--caf-dma.example.com" })).toEqual({
				api: { domain: "xn--caf-dma.example.com" },
				mcp: {},
			})
			expect(yield* parse({ [MCP_DOMAIN_ENV]: "mcp.agents.example.co.uk" })).toEqual({
				api: {},
				mcp: { domain: "mcp.agents.example.co.uk" },
			})
		}),
	)

	it.effect("detaches every custom hostname from a Worker whose variable is none", () =>
		Effect.gen(function* () {
			expect(yield* parse({ [API_DOMAIN_ENV]: DETACH_ALL })).toEqual({
				api: { domain: null },
				mcp: {},
			})
			expect(yield* parse({ [API_DOMAIN_ENV]: DETACH_ALL, [MCP_DOMAIN_ENV]: DETACH_ALL })).toEqual({
				api: { domain: null },
				mcp: { domain: null },
			})
			for (const value of ["None", "NONE", " none", "null", "false"]) {
				expect([value, yield* refused({ [API_DOMAIN_ENV]: value })]).not.toEqual([
					value,
					"accepted",
				])
			}
		}),
	)

	it.effect("refuses one hostname named for both Workers, however it is capitalised", () =>
		Effect.gen(function* () {
			for (const [api, mcp] of [
				["api.example.com", "api.example.com"],
				["api.example.com", "API.Example.COM"],
			] as const) {
				const reason = yield* refused({ [API_DOMAIN_ENV]: api, [MCP_DOMAIN_ENV]: mcp })
				expect(reason).toContain(`both name ${api.toLowerCase()}`)
			}
			expect(
				yield* parse({ [API_DOMAIN_ENV]: "api.example.com", [MCP_DOMAIN_ENV]: "mcp.example.com" }),
			).toEqual({ api: { domain: "api.example.com" }, mcp: { domain: "mcp.example.com" } })
			expect(
				yield* refused({
					[API_DOMAIN_ENV]: "sample.example.com",
					[MCP_DOMAIN_ENV]: "\u017Fample.example.com",
				}),
			).not.toBe("accepted")
		}),
	)

	it.effect("needs the API and MCP hostnames named outright while a publish domain is set", () =>
		Effect.gen(function* () {
			const publish = { [PUBLISH_DOMAIN_ENV]: "pages.example" }
			for (const [name, other] of [
				[API_DOMAIN_ENV, MCP_DOMAIN_ENV],
				[MCP_DOMAIN_ENV, API_DOMAIN_ENV],
			] as const) {
				for (const left of [{}, { [name]: "" }]) {
					expect(yield* refused({ ...publish, ...left, [other]: DETACH_ALL })).toContain(
						`${name} must be a hostname outside ${PUBLISH_DOMAIN_ENV} pages.example, or none`,
					)
				}
			}
			expect(yield* refused(publish)).toContain(`${API_DOMAIN_ENV} must be`)
			expect(
				yield* parse({ ...publish, [API_DOMAIN_ENV]: DETACH_ALL, [MCP_DOMAIN_ENV]: DETACH_ALL }),
			).toEqual({ api: { domain: null }, mcp: { domain: null } })
			expect(
				yield* parse({
					...publish,
					[API_DOMAIN_ENV]: "api.example.com",
					[MCP_DOMAIN_ENV]: "mcp.example.com",
				}),
			).toEqual({ api: { domain: "api.example.com" }, mcp: { domain: "mcp.example.com" } })
			expect(yield* parse({ [PUBLISH_DOMAIN_ENV]: "" })).toEqual({ api: {}, mcp: {} })
		}),
	)

	it.effect("refuses anything that is not a bare hostname", () =>
		Effect.gen(function* () {
			for (const value of [
				"https://api.example.com",
				"api.example.com/mcp",
				"api.example.com:8443",
				"api example.com",
				"localhost",
				"-api.example.com",
				"api..example.com",
				".example.com",
				`${"a".repeat(64)}.example.com`,
				"\u017Fample.example.com",
				"\u212Aey.example.com",
				"caf\u00E9.example.com",
			]) {
				for (const name of [API_DOMAIN_ENV, MCP_DOMAIN_ENV]) {
					expect([name, value, yield* refused({ [name]: value })]).not.toEqual([
						name,
						value,
						"accepted",
					])
				}
			}
		}),
	)

	it.effect(
		"serves publications from a wildcard route on the publish domain, and keeps API hostnames out of it",
		() =>
			Effect.gen(function* () {
				const domain = (env: Record<string, string>) =>
					publishDomain.parse(ConfigProvider.fromUnknown(env, { preserveEmptyStrings: true }))
				expect(yield* domain({})).toBeUndefined()
				expect(yield* domain({ [PUBLISH_DOMAIN_ENV]: "" })).toBeUndefined()
				expect(yield* domain({ [PUBLISH_DOMAIN_ENV]: "Example-Pages.dev" })).toBe(
					"example-pages.dev",
				)
				for (const value of ["*.pages.dev", "none", "pages", "https://pages.dev"]) {
					expect([
						value,
						Exit.isFailure(yield* Effect.exit(domain({ [PUBLISH_DOMAIN_ENV]: value }))),
					]).toEqual([value, true])
				}
				expect(contentWorkerProps(undefined)).toBe(CONTENT_WORKER_PROPS)
				expect(contentWorkerProps("example-pages.dev")).toEqual({
					...CONTENT_WORKER_PROPS,
					routes: [{ pattern: "*.example-pages.dev/*", zoneName: "example-pages.dev" }],
				})

				for (const [name, other, hostname, publish] of [
					[API_DOMAIN_ENV, MCP_DOMAIN_ENV, "api.example.com", "example.com"],
					[MCP_DOMAIN_ENV, API_DOMAIN_ENV, "mcp.agents.example.com", "Example.com"],
					[API_DOMAIN_ENV, MCP_DOMAIN_ENV, "example.com", "example.com"],
					[MCP_DOMAIN_ENV, API_DOMAIN_ENV, "MCP.Example.com", "example.com"],
				] as const) {
					expect(
						yield* refused({
							[name]: hostname,
							[other]: DETACH_ALL,
							[PUBLISH_DOMAIN_ENV]: publish,
						}),
					).toContain(`${name} is inside ${PUBLISH_DOMAIN_ENV} example.com`)
				}
				expect(
					yield* parse({
						[API_DOMAIN_ENV]: "api.example.com",
						[MCP_DOMAIN_ENV]: DETACH_ALL,
						[PUBLISH_DOMAIN_ENV]: "example-pages.com",
					}),
				).toEqual({ api: { domain: "api.example.com" }, mcp: { domain: null } })
				expect(
					yield* parse({
						[API_DOMAIN_ENV]: "myexample.com",
						[MCP_DOMAIN_ENV]: "mcp.myexample.com",
						[PUBLISH_DOMAIN_ENV]: "example.com",
					}),
				).toEqual({ api: { domain: "myexample.com" }, mcp: { domain: "mcp.myexample.com" } })
				expect(
					yield* parse({
						[API_DOMAIN_ENV]: "example.com",
						[MCP_DOMAIN_ENV]: DETACH_ALL,
						[PUBLISH_DOMAIN_ENV]: "pages.example.com",
					}),
				).toEqual({ api: { domain: "example.com" }, mcp: { domain: null } })
			}),
	)
})
