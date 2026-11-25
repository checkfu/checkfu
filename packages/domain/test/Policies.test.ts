import type * as View from "@alchemy.run/domain/View"
import { describe, expect, it } from "@effect/vitest"
import { Checkfu } from "../src/Checkfu.model.ts"

const TWINS = new Map([["StartTurn", "EnsureTurnStarted"]])

const SHIPPED_VERSIONS = { AutomationView: 5 }

const WHY =
	"A policy fed by a view skips every event the view reads while it rebuilds, and a new version rebuilds it, " +
	"so the deploy that bumps it would silently drop firings. Before changing this version, give each policy " +
	"the view feeds an aggregate-fed twin that reacts to all of the same events and starts the same work " +
	"idempotently (as EnsureTurnStarted does for StartTurn), deployed on its own, then list the policy in TWINS."

type AnyPolicy = (typeof Checkfu.definitions.policies)[number]

const sourcesOf = (policy: AnyPolicy) => {
	const none: ReadonlyArray<View.Source> = []
	return none.concat(policy.definition.from)
}

const tagsOf = (policy: AnyPolicy) => new Set(policy.definition.on.map((event) => event.tag))

describe("a view that feeds a policy", () => {
	it("keeps the version it shipped with, unless every policy it feeds has an aggregate-fed twin for all its events", () => {
		const policies = Checkfu.definitions.policies
		const byName = new Map(policies.map((policy) => [policy.policyName, policy]))
		const coveredByTwin = (policy: AnyPolicy) => {
			const name = TWINS.get(policy.policyName)
			const twin = name === undefined ? undefined : byName.get(name)
			if (twin === undefined || !sourcesOf(twin).some((source) => source.kind === "Aggregate")) {
				return false
			}
			const twinTags = tagsOf(twin)
			return [...tagsOf(policy)].every((tag) => twinTags.has(tag))
		}
		const pinned: Record<string, number | undefined> = {}
		for (const policy of policies) {
			if (coveredByTwin(policy)) {
				continue
			}
			for (const source of sourcesOf(policy)) {
				if (source.kind === "View") {
					pinned[source.viewName] = source.definition.version
				}
			}
		}
		expect(pinned, WHY).toEqual(SHIPPED_VERSIONS)
	})
})
