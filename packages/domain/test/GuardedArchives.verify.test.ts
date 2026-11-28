import * as Prove from "@alchemy.run/domain/Prove"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
	ArchiveAgentIfCurrentDecision,
	ArchiveEnvironmentIfCurrentDecision,
} from "../src/Automation/GuardedArchives.ts"

it.each([
	{
		resource: "agent",
		decision: ArchiveAgentIfCurrentDecision,
		referenceRule: "NoLiveAutomationReferencesTheAgent",
	},
	{
		resource: "environment",
		decision: ArchiveEnvironmentIfCurrentDecision,
		referenceRule: "NoLiveAutomationReferencesTheEnvironment",
	},
])(
	"checks the $resource archive against the states the inventory proof can cover",
	async ({ decision, referenceRule }) => {
		const report = await Effect.runPromise(
			Prove.decisionReport(decision, {
				source: "./src/Automation/GuardedArchives.ts",
			}).pipe(Effect.provide(NodeServices.layer)),
		)
		const description = Prove.renderDecision(report)
		Effect.runSync(Effect.logInfo(description))
		expect(
			report.rules.map((rule) => rule.name),
			description,
		).toEqual(expect.arrayContaining(["AnArchiveHappensAtTheExpectedVersion", referenceRule]))
		expect(report.accepted, description).toBe(true)
		expect(["Proved", "Bounded"], description).toContain(report.schema._tag)
		for (const { verdict } of report.rules) {
			expect(["Proved", "Bounded"], description).toContain(verdict._tag)
		}
	},
	180_000,
)
