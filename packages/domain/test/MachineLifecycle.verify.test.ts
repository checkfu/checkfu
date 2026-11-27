import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Machine } from "../src/Workspace/Machine.aggregate.ts"

const STANDING = {
	IdleMachinesHaveNoIncarnation: "proved",
	AnAwakeMachineHasAnIncarnation: "proved",
	ALocalMachineHasNoNotice: "proved",
	AStartEndsWithItsResult: "proved",
	AReplacementRaisesTheNotice: "proved",
	OnlyReadingClearsTheNotice: "proved",
	OnlyAnAwakeMachineSleeps: "proved",
} as const

it.live(
	"proves the workspace machine's start, sleep and replacement rules",
	() =>
		Effect.gen(function* () {
			const report = yield* Verify.aggregate(Machine, {
				lock: "./MachineLifecycle.verify.lock.json",
				require: { proved: Object.keys(STANDING) },
			})
			yield* Effect.logInfo(Verify.render(report))
			expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
				STANDING,
			)
			expect(report.undone).toEqual([])
		}).pipe(Effect.provide(NodeServices.layer)),
	120_000,
)
