import type * as Cloudflare from "@alchemy.run/cloudflare"
import { retentionWindows } from "@alchemy.run/domain/DurableObjects"
import { describe, expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { expectTypeOf } from "vitest"
import { DOMAIN_RETENTION } from "../src/PlacedDurableObjects.ts"
import {
	DEFAULT_STORAGE_SCOPE,
	JURISDICTION_ENV,
	Jurisdiction,
	LOCATION_HINT_ENV,
	LocationHint,
	placedStub,
	placement,
	storageScope,
} from "../src/Placement.ts"

const parse = (env: Record<string, string>) =>
	placement.parse(ConfigProvider.fromUnknown(env, { preserveEmptyStrings: true }))

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

	it("lists exactly the values the Workers runtime types accept", () => {
		expectTypeOf<typeof Jurisdiction.Type>().toEqualTypeOf<Cloudflare.DurableObjectJurisdiction>()
		expectTypeOf<typeof LocationHint.Type>().toEqualTypeOf<Cloudflare.DurableObjectLocationHint>()
	})

	it.effect("reads every listed value", () =>
		Effect.gen(function* () {
			for (const jurisdiction of Jurisdiction.literals) {
				expect(yield* parse({ [JURISDICTION_ENV]: jurisdiction })).toEqual({ jurisdiction })
			}
			for (const locationHint of LocationHint.literals) {
				expect(yield* parse({ [LOCATION_HINT_ENV]: locationHint })).toEqual({ locationHint })
			}
		}),
	)

	it.effect("refuses a value Cloudflare does not accept instead of ignoring it", () =>
		Effect.gen(function* () {
			expect(Exit.isFailure(yield* Effect.exit(parse({ [JURISDICTION_ENV]: "uk" })))).toBe(true)
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

	it.effect("scopes storage by the jurisdiction, and by one fixed word outside any", () =>
		Effect.gen(function* () {
			const scopeOf = (env: Record<string, string>) =>
				storageScope.parse(ConfigProvider.fromUnknown(env, { preserveEmptyStrings: true }))
			expect(yield* scopeOf({})).toBe(DEFAULT_STORAGE_SCOPE)
			expect(yield* scopeOf({ [JURISDICTION_ENV]: "" })).toBe(DEFAULT_STORAGE_SCOPE)
			for (const jurisdiction of Jurisdiction.literals) {
				expect(yield* scopeOf({ [JURISDICTION_ENV]: jurisdiction })).toBe(jurisdiction)
			}
			expect(Jurisdiction.literals).not.toContain(DEFAULT_STORAGE_SCOPE)
		}),
	)

	it("keeps every receipt and delivery mark the domain dedupes with, so a late retry stays a retry", () => {
		expect(retentionWindows(DOMAIN_RETENTION)).toEqual({
			receipts: undefined,
			deliveries: undefined,
			cancelled: undefined,
		})
	})
})
