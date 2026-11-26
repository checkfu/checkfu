import * as Prove from "@alchemy.run/domain/Prove"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { ConfirmToolDecision } from "../src/Session/ConfirmTool.decision.ts"
import { ReturnCustomToolResultDecision } from "../src/Session/ReturnCustomToolResult.decision.ts"
import { addToolUseId, removeToolUseId } from "../src/Session/SessionTypes.ts"

it.each([
	{
		name: "tool confirmation",
		decision: ConfirmToolDecision,
		source: "./src/Session/ConfirmTool.decision.ts",
	},
	{
		name: "custom tool result",
		decision: ReturnCustomToolResultDecision,
		source: "./src/Session/ReturnCustomToolResult.decision.ts",
	},
] as const)(
	"proves $name answers only its own session and call",
	async ({ decision, source }) => {
		const report = await Effect.runPromise(
			Prove.decisionReport(decision, { source, opaque: [addToolUseId, removeToolUseId] }).pipe(
				Effect.provide(NodeServices.layer),
			),
		)
		const evidence = Prove.renderDecision(report)
		expect(report.accepted, evidence).toBe(true)
		for (const { verdict } of report.rules) {
			expect(verdict._tag, evidence).toBe("Proved")
		}
	},
	60_000,
)
