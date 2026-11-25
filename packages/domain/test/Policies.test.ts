import { describe, expect, it } from "@effect/vitest"
import { Checkfu } from "../src/Checkfu.model.ts"

const FED_BY_A_VIEW = ["StartTurn", "StopModelRequest"]

describe("policies", () => {
	it("are fed by an aggregate, except the session turn policies", () => {
		const fedByAView = Checkfu.definitions.policies
			.filter((policy) => {
				const from = policy.definition.from
				const sources = Array.isArray(from) ? from : [from]
				return sources.some((source) => source.kind !== "Aggregate")
			})
			.map((policy) => policy.policyName)
		expect(fedByAView.toSorted()).toEqual(FED_BY_A_VIEW.toSorted())
	})
})
