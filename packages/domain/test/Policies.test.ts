import { describe, expect, it } from "@effect/vitest"
import { Checkfu } from "../src/Checkfu.model.ts"

describe("policies", () => {
	it("are fed by an aggregate, or have a twin that is", () => {
		const fedByAView = Checkfu.definitions.policies
			.filter((policy) => {
				const from = policy.definition.from
				const sources = Array.isArray(from) ? from : [from]
				return sources.every((source) => source.kind !== "Aggregate")
			})
			.map((policy) => policy.policyName)
		const names = new Set(Checkfu.definitions.policies.map((policy) => policy.policyName))
		expect(fedByAView.toSorted()).toEqual(["ArmAutomation", "StartAutomationRun", "StartTurn"])
		expect(
			["EnsureAutomationArmed", "EnsureAutomationRunStarted", "EnsureTurnStarted"].filter(
				(twin) => !names.has(twin),
			),
		).toEqual([])
	})
})
