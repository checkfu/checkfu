import * as Prove from "@alchemy.run/domain/Prove"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
	ArchiveAgentIfCurrentDecision,
	ArchiveEnvironmentIfCurrentDecision,
} from "../src/Automation/GuardedArchives.ts"

it.each([ArchiveAgentIfCurrentDecision, ArchiveEnvironmentIfCurrentDecision])(
	"checks $decisionName against the states the inventory proof can cover",
	async (decision) => {
		const report = await Effect.runPromise(
			Prove.decisionReport(decision, {
				source: "./src/Automation/GuardedArchives.ts",
			}).pipe(Effect.provide(NodeServices.layer)),
		)
		const description = Prove.renderDecision(report)
		expect(report.accepted, description).toBe(true)
		expect(["Proved", "Bounded"], description).toContain(report.schema._tag)
		for (const { verdict } of report.rules) {
			expect(["Proved", "Bounded"], description).toContain(verdict._tag)
		}
	},
	60_000,
)
