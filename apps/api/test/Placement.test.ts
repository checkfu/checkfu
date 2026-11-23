import type * as Cloudflare from "@alchemy.run/cloudflare"
import { describe, expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { JURISDICTION_ENV, LOCATION_HINT_ENV, placedStub, placement } from "../src/Placement.ts"

const parse = (env: Record<string, string>) => placement.parse(ConfigProvider.fromEnv({ env }))

const recordingNamespace = () => {
	const calls: Array<string> = []
	const namespace = (inside: string): Cloudflare.DurableObject<object> =>
		({
			getByName: (name: string, options?: { readonly locationHint?: string }) => {
				calls.push(`${inside}:${name}:${options?.locationHint ?? "-"}`)
				return {}
			},
			jurisdiction: (jurisdiction: string) => namespace(jurisdiction),
		}) as unknown as Cloudflare.DurableObject<object>
	return { calls, namespace: namespace("-") }
}

describe("Durable Object placement", () => {
	it.effect("reads no placement when both variables are unset or empty", () =>
		Effect.gen(function* () {
			expect(yield* parse({})).toEqual({})
			expect(yield* parse({ [JURISDICTION_ENV]: "", [LOCATION_HINT_ENV]: "" })).toEqual({})
		}),
	)

	it.effect("reads a jurisdiction and a location hint", () =>
		Effect.gen(function* () {
			expect(yield* parse({ [JURISDICTION_ENV]: "eu", [LOCATION_HINT_ENV]: "weur" })).toEqual({
				jurisdiction: "eu",
				locationHint: "weur",
			})
		}),
	)

	it.effect("refuses a value Cloudflare does not accept instead of ignoring it", () =>
		Effect.gen(function* () {
			expect(Exit.isFailure(yield* Effect.exit(parse({ [JURISDICTION_ENV]: "us" })))).toBe(true)
			expect(Exit.isFailure(yield* Effect.exit(parse({ [LOCATION_HINT_ENV]: "europe" })))).toBe(
				true,
			)
		}),
	)

	it("addresses every object inside the jurisdiction and near the hint", () => {
		const unplaced = recordingNamespace()
		placedStub(unplaced.namespace, {})("a")
		expect(unplaced.calls).toEqual(["-:a:-"])

		const placed = recordingNamespace()
		placedStub(placed.namespace, { jurisdiction: "eu", locationHint: "weur" })("a")
		expect(placed.calls).toEqual(["eu:a:weur"])
	})
})
