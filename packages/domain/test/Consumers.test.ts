import { describe, expect, it } from "@effect/vitest"
import { Checkfu } from "../src/Checkfu.model.ts"
import { LISTING_VERSION, Listing } from "../src/Listing/Listing.projection.ts"

const SOURCES = [
	{
		name: "Listing",
		version: 2,
		from: ["Agent", "Artifact", "Automation", "Environment", "Session"],
	},
	{ name: "AgentView", version: 0, from: ["Agent"] },
	{ name: "AgentView", version: 2, from: ["Agent"] },
	{ name: "AgentView", version: 3, from: ["Agent"] },
	{ name: "AgentVersionByNumberView", version: 2, from: ["Agent"] },
	{ name: "AgentVersionByNumberView", version: 3, from: ["Agent"] },
	{ name: "AgentVersionByNumberView", version: 4, from: ["Agent"] },
	{ name: "EnvironmentView", version: 0, from: ["Environment"] },
	{ name: "SessionView", version: 2, from: ["Session"] },
	{ name: "SessionView", version: 3, from: ["Session"] },
	{ name: "SessionView", version: 4, from: ["Session"] },
	{ name: "TurnInput", version: 3, from: ["Session"] },
	{ name: "TurnInput", version: 4, from: ["Session"] },
	{ name: "AutomationView", version: 5, from: ["Automation"] },
	{ name: "AutomationRunView", version: 1, from: ["Automation"] },
	{ name: "ArtifactVersionView", version: 1, from: ["Artifact"] },
]

const nameOf = (
	source: { readonly aggregateName: string } | { readonly viewName: string },
): string => ("aggregateName" in source ? source.aggregateName : source.viewName)

const declared = [
	{ name: Listing.projectionName, version: LISTING_VERSION, from: Listing.definition.from },
	...Checkfu.definitions.views.map((view) => ({
		name: view.viewName,
		version: view.definition.version ?? 0,
		from: view.definition.from,
	})),
]

describe("views and projections", () => {
	it("read the sources recorded for their version", () => {
		expect(declared.map((consumer) => consumer.name).toSorted()).toEqual(
			[...new Set(SOURCES.map((entry) => entry.name))].toSorted(),
		)
		for (const consumer of declared) {
			const recorded = SOURCES.find(
				(entry) => entry.name === consumer.name && entry.version === consumer.version,
			)
			expect(
				recorded,
				`${consumer.name} is at version ${consumer.version}, which has no entry: add one with the sources it reads`,
			).toBeDefined()
			expect(
				recorded?.from,
				`${consumer.name} reads different sources than version ${consumer.version} recorded: bump its version and add an entry for the new one, leaving this entry as it is`,
			).toEqual(consumer.from.map(nameOf).toSorted())
		}
	})
})
