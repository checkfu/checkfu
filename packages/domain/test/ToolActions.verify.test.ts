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
		expected: [
			"AnAnswerKeepsTheTurn",
			"AnAnswerMatchesItsSessionAndCall",
			"OnlyAPendingCallOfTheRunningTurnIsConfirmed",
		],
	},
	{
		name: "custom tool result",
		decision: ReturnCustomToolResultDecision,
		source: "./src/Session/ReturnCustomToolResult.decision.ts",
		expected: [
			"AResultKeepsTheTurn",
			"AResultMatchesItsSessionAndCall",
			"OnlyAPendingCallOfTheRunningTurnGetsAResult",
		],
	},
] as const)(
	"proves $name answers only its own session and call",
	async ({ decision, source, expected }) => {
		const report = await Effect.runPromise(
			Prove.decisionReport(decision, { source, opaque: [addToolUseId, removeToolUseId] }).pipe(
				Effect.provide(NodeServices.layer),
			),
		)
		const evidence = Prove.renderDecision(report)
		expect(Prove.decisionProved(report), evidence).toBe(true)
		expect(report.accepted, evidence).toBe(true)
		expect(
			report.rules
				.filter((rule) => rule.kind === "decision")
				.map((rule) => rule.name)
				.toSorted(),
			evidence,
		).toEqual(expected)
	},
	60_000,
)
