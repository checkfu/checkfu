import { describe, expect, it } from "@effect/vitest"
import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { PRODUCTION_STAGE, protectInProduction } from "../src/Protection.ts"

const policyOn = (stage: string) =>
	Effect.serviceOption(Alchemy.RemovalPolicy.RemovalPolicy).pipe(
		protectInProduction,
		Effect.provideService(Alchemy.Stage, stage),
		Effect.map(Option.getOrUndefined),
	)

describe("protectInProduction", () => {
	it.effect("protects resources on the production stage only", () =>
		Effect.gen(function* () {
			expect(yield* policyOn(PRODUCTION_STAGE)).toBe("protect")
			for (const stage of ["staging", "dev_andrew", "Production", "production-copy"]) {
				expect([stage, yield* policyOn(stage)]).toEqual([stage, undefined])
			}
		}),
	)
})
