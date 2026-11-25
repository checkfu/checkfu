import { describe, expect, it } from "@effect/vitest"
import { Checkfu } from "../src/Checkfu.model.ts"

const TWINS = new Map([["StartTurn", "EnsureTurnStarted"]])

const SHIPPED_VERSIONS = { AutomationView: 5 }

const WHY =
	"A policy fed by a view skips every event the view reads while it rebuilds, and a new version rebuilds it, " +
	"so the deploy that bumps it would silently drop firings. Before changing this version, give each policy " +
	"the view feeds an aggregate-fed twin that starts the same work idempotently (as EnsureTurnStarted does for " +
	"StartTurn), deployed on its own, then list the policy in TWINS."

describe("a view that feeds a policy", () => {
	it("keeps the version it shipped with, unless every policy it feeds has an aggregate-fed twin", () => {
		const policies = Checkfu.definitions.policies
		const fedByAnAggregate = new Set(
			policies
				.filter((policy) => {
					const from = policy.definition.from
					const sources = Array.isArray(from) ? from : [from]
					return sources.some((source) => source.kind === "Aggregate")
				})
				.map((policy) => policy.policyName),
		)
		const pinned: Record<string, number | undefined> = {}
		for (const policy of policies) {
			const from = policy.definition.from
			const sources = Array.isArray(from) ? from : [from]
			const twin = TWINS.get(policy.policyName)
			if (twin !== undefined && fedByAnAggregate.has(twin)) {
				continue
			}
			for (const source of sources) {
				if (source.kind === "View") {
					pinned[source.viewName] = source.definition.version
				}
			}
		}
		expect(pinned, WHY).toEqual(SHIPPED_VERSIONS)
	})
})
