import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { ByteOwnership } from "./ByteOwnership.aggregate.ts"

const rules = [
	"PurgeIsTerminal",
	"PurgedOwnersRefuseWrites",
	"WatermarksNeverDecrease",
	"NewStageAdvancesItsFence",
	"CheckOnlyLeavesTheStageFence",
	"StaleReservationsCannotWrite",
	"LateReleaseKeepsNewerBytes",
	"CurrentReleaseRemovesBytes",
	"PurgeAlwaysCleansUp",
]

it.live(
	"proves file and artifact owner fences for symbolic reservations",
	() =>
		Effect.gen(function* () {
			const report = yield* Verify.aggregate(ByteOwnership, {
				lock: "./ByteOwnership.verify.lock.json",
				require: { proved: rules },
			})
			yield* Effect.logInfo(Verify.render(report))
			expect(report.rules.map((rule) => [rule.name, rule.standing])).toEqual(
				rules.map((rule) => [rule, "proved"]),
			)
			expect(report.undone).toEqual([])
			expect(report.explored.complete).toBeGreaterThanOrEqual(2)
			expect(report.explored.outcomes.every((outcome) => outcome.story !== undefined)).toBe(true)
		}).pipe(Effect.provide(NodeServices.layer)),
	120_000,
)
