import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Sessions, SessionsApi } from "../src/Sessions.model.ts"
import { PROVED, STANDING } from "./Sessions.verify.standing.ts"

describe("Sessions Z3 formal verification", () => {
	it.live(
		"proves every Session invariant and transition in Z3 and verifies turn execution with step reruns",
		() =>
			Effect.gen(function* () {
				const report = yield* Verify.model(Sessions, {
					apis: [SessionsApi],
					instances: 1,
					depth: 2,
					budget: 20_000,
					faults: { redeliver: true, reorder: true, rerun: true },
					walks: { count: 25 },
					lock: "./Sessions.verify.lock.json",
					require: { proved: PROVED },
				})
				expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
					STANDING,
				)
				expect(report.undone).toEqual([])
				expect(report.explored.aside).toEqual([])
				expect(report.explored.truncated).toBe(false)
				expect(report.explored.complete).toBe(2)
				expect(report.explored.repeated).toContain(
					"Harness.runTurn, by RunTurn in its step run-harness-turn",
				)
				expect(report.explored.disagreements).toEqual([])
				expect(report.explored.agreement.compared).toBeGreaterThan(0)
			}).pipe(Effect.provide(NodeServices.layer)),
		600_000,
	)
})
