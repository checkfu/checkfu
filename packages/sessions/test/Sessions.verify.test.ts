import { Story } from "@alchemy.run/domain/Story"
import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ModelProvider } from "../src/Session/ModelProvider.external.ts"
import { RunTurnLive } from "../src/Session/RunTurn.saga.ts"
import { StartTurnLive } from "../src/Session/StartTurn.policy.ts"
import { Sessions, SessionsApi } from "../src/Sessions.model.ts"

const story = Story.make(Sessions, {
	layer: Layer.mergeAll(StartTurnLive, RunTurnLive),
	stub: [ModelProvider],
})

const STANDING = {
	"Session.RunningTurnIsPositive": "proved",
	"Session.IdleTurnIsNonNegative": "proved",
	"Session.ModelRequestsStartedNonNegative": "proved",
	"Session.PendingUserMessagesWithinBounds": "proved",
	"Session.OpenModelRequestRequiresStartedCount": "proved",
	"Session.TerminatedSessionStaysTerminated": "proved",
	"Session.ArchivedSessionStaysArchived": "proved",
	"Session.CreatedSessionNeverReturnsToUninitialized": "proved",
	"Session.TurnNeverDecreases": "proved",
	"Session.TurnAdvancesByAtMostOne": "proved",
	"Session.ModelRequestsStartedNeverDecreasesWithinTurn": "proved",
	"Sessions.ASessionCompletesATurn": "reached",
	"Sessions.ASessionTerminates": "reached",
	"Sessions.EveryTurnSettles": "checked",
} as const

const PROVED = Object.entries(STANDING)
	.filter(([, standing]) => standing === "proved")
	.map(([name]) => name)

describe("Sessions Z3 formal verification", () => {
	it("proves every Session invariant and transition in Z3 and verifies turn execution", async () => {
		const report = await Effect.runPromise(
			Verify.model(Sessions, {
				apis: [SessionsApi],
				story,
				instances: 1,
				depth: 2,
				budget: 400,
				faults: { redeliver: true, reorder: true, rerun: false },
				walks: { count: 10 },
				allow: { truncated: true },
				lock: "./Sessions.verify.lock.json",
				require: { proved: PROVED },
			}).pipe(Effect.provide(NodeServices.layer)),
		)
		expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
			STANDING,
		)
		expect(report.explored.disagreements).toEqual([])
		expect(report.explored.agreement.compared).toBeGreaterThan(0)
	}, 120_000)
})
