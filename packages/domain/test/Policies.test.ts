import { describe, expect, it } from "@effect/vitest"
import { Checkfu } from "../src/Checkfu.model.ts"

const MAY_BE_FED_BY_A_VIEW = new Set(["StartTurn", "StopModelRequest"])

describe("policies", () => {
	it("are fed by an aggregate, except the session turn policies", () => {
		const fedByAView = Checkfu.definitions.policies
			.filter((policy) => {
				const from = policy.definition.from
				const sources = Array.isArray(from) ? from : [from]
				return sources.some((source) => source.kind !== "Aggregate")
			})
			.map((policy) => policy.policyName)
		expect(fedByAView).toContain("StartTurn")
		expect(fedByAView.filter((name) => !MAY_BE_FED_BY_A_VIEW.has(name))).toEqual([])
	})
})
