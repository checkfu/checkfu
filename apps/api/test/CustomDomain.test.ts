import { describe, expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { API_DOMAIN_ENV, DETACH_ALL, MCP_DOMAIN_ENV, customDomains } from "../src/CustomDomain.ts"

// An empty entry in `.env` arrives as "".
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
			// Both Workers can be detached at once.
			expect(yield* parse({ [API_DOMAIN_ENV]: DETACH_ALL, [MCP_DOMAIN_ENV]: DETACH_ALL })).toEqual({
				api: { domain: null },
				mcp: { domain: null },
			})
			// Only the exact word: anything else that is not a hostname is a mistake.
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
})
