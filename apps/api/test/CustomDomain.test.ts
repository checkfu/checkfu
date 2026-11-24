import { describe, expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { API_DOMAIN_ENV, MCP_DOMAIN_ENV, customDomain } from "../src/CustomDomain.ts"

// An empty entry in `.env` arrives as "".
const parse = (name: string, env: Record<string, string>) =>
	customDomain(name).parse(ConfigProvider.fromUnknown(env, { preserveEmptyStrings: true }))

describe("custom domains", () => {
	it.effect("leaves a Worker on its workers.dev address when no hostname is configured", () =>
		Effect.gen(function* () {
			expect(yield* parse(API_DOMAIN_ENV, {})).toEqual({})
			expect(yield* parse(API_DOMAIN_ENV, { [API_DOMAIN_ENV]: "" })).toEqual({})
			// Each Worker reads only its own variable.
			expect(yield* parse(MCP_DOMAIN_ENV, { [API_DOMAIN_ENV]: "api.example.com" })).toEqual({})
		}),
	)

	it.effect("reads a hostname as the Worker's domain", () =>
		Effect.gen(function* () {
			for (const hostname of ["api.example.com", "mcp.agents.example.co.uk", "A-1.Example.dev"]) {
				expect(yield* parse(MCP_DOMAIN_ENV, { [MCP_DOMAIN_ENV]: hostname })).toEqual({
					domain: hostname,
				})
			}
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
				const exit = yield* Effect.exit(parse(API_DOMAIN_ENV, { [API_DOMAIN_ENV]: value }))
				expect([value, Exit.isFailure(exit)]).toEqual([value, true])
			}
		}),
	)
})
