import * as Prove from "@alchemy.run/domain/Prove"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { AdmitMountedSessionDecision } from "../src/Session/AdmitMountedSession.decision.ts"

it("records the pinned solver standing for admission with file participants", async () => {
	const report = await Effect.runPromise(
		Prove.decisionReport(AdmitMountedSessionDecision, {
			source: "./src/Session/AdmitMountedSession.decision.ts",
		}).pipe(Effect.provide(NodeServices.layer)),
	)
	const description = Prove.renderDecision(report)
	Effect.runSync(Effect.logInfo(description))
	expect(report.accepted, description).toBe(true)
	expect(report.rules.map((rule) => rule.name)).toEqual(
		expect.arrayContaining(["EveryMountedFileIsReadyAndMatchesItsContent"]),
	)
	for (const verdict of [report.schema, ...report.rules.map((rule) => rule.verdict)]) {
		if (verdict._tag === "Unknown") {
			expect(verdict.reason, description).toBe("AdmitMountedSession has more than 4096 paths")
		} else {
			expect(["Proved", "Bounded"], description).toContain(verdict._tag)
		}
	}
}, 240_000)
