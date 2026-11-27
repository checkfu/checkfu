import * as Prove from "@alchemy.run/domain/Prove"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { AdmitMountedSessionDecision } from "../src/Session/AdmitMountedSession.decision.ts"

import { CheckArtifactDecision, CheckFileDecision } from "./fixtures/MountedResourceGuard.ts"

it.each([
	{
		name: "file",
		decision: CheckFileDecision,
		rule: "TheAcceptedFileIsReadyAndMatchesItsContent",
		verdict: { _tag: "Bounded", reason: "command.resources was tried with up to 2 items" },
	},
	{
		name: "artifact or skill",
		decision: CheckArtifactDecision,
		rule: "TheAcceptedArtifactIsActiveAtThePinnedVersion",
		verdict: { _tag: "Proved" },
	},
])(
	"checks the production $name keys and refusal against a separate acceptance marker",
	async ({ decision, rule, verdict }) => {
		const report = await Effect.runPromise(
			Prove.decisionReport(decision, {
				source: "./test/fixtures/MountedResourceGuard.ts",
			}).pipe(Effect.provide(NodeServices.layer)),
		)
		const description = Prove.renderDecision(report)
		expect(report.accepted, description).toBe(true)
		expect(report.rules.find((entry) => entry.name === rule)?.verdict, description).toEqual(verdict)
		for (const result of [report.schema, ...report.rules.map((entry) => entry.verdict)]) {
			expect(["Proved", "Bounded"], description).toContain(result._tag)
		}
	},
	60_000,
)

it.runIf(process.env.CHECKFU_FULL_MOUNT_REPORT === "1")(
	"records the pinned solver standing for admission with file and artifact participant lists",
	async () => {
		const report = await Effect.runPromise(
			Prove.decisionReport(AdmitMountedSessionDecision, {
				source: "./src/Session/AdmitMountedSession.decision.ts",
			}).pipe(Effect.provide(NodeServices.layer)),
		)
		const description = Prove.renderDecision(report)
		Effect.runSync(Effect.logInfo(description))
		expect(report.accepted, description).toBe(true)
		expect(report.rules.map((rule) => rule.name)).toEqual(
			expect.arrayContaining([
				"EveryMountedFileIsReadyAndMatchesItsContent",
				"EveryMountedArtifactIsActiveAtThePinnedVersion",
			]),
		)
		for (const verdict of [report.schema, ...report.rules.map((rule) => rule.verdict)]) {
			if (verdict._tag === "Unknown") {
				expect(verdict.reason, description).toBe("AdmitMountedSession has more than 4096 paths")
			} else {
				expect(["Proved", "Bounded"], description).toContain(verdict._tag)
			}
		}
	},
	240_000,
)
