import { Story } from "@alchemy.run/domain/Story"
import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Agents, AgentsApi } from "../src/Agents.model.ts"

const story = Story.make(Agents)

const STANDING = {
	"Agent.StatusIsKnown": "proved",
	"Agent.CreatedExactlyWhenVersioned": "proved",
	"Agent.CreatedAgentNeverReturnsToUninitialized": "proved",
	"Agent.ArchivedAgentStaysArchived": "proved",
	"Agent.VersionGrowsByOneOrNotAtAll": "proved",
	"AgentVersion.MintedExactlyWhenNumbered": "proved",
	"AgentVersion.MintedVersionNeverChanges": "proved",
	"CreateAgent.NewAgentStartsAtVersionOne": "proved",
	"UpdateAgent.ChangeMintsNextVersionOrNoOps": "proved",
	"UpdateAgent.UnchangedConfigMintsNothing": "proved",
	"Agents.AMintedVersionBelongsToItsAgent": "proved",
	"Agents.AnAgentsHeadIsItsLatestVersion": "proved",
	"Agents.VersionNumbersAreDistinct": "proved",
	"Agents.AgentViewMatchesAgent": "checked",
	"Agents.AgentVersionViewMatchesAgentVersion": "checked",
	"Agents.AgentVersionByNumberMatchesAgentVersion": "checked",
	"Agents.AnAgentIsUpdated": "reached",
	"Agents.AnAgentIsArchived": "reached",
} as const

const PROVED = Object.entries(STANDING)
	.filter(([, standing]) => standing === "proved")
	.map(([name]) => name)

describe("Agents Z3 formal verification", () => {
	it.live(
		"proves every Agent invariant, transition, decision, and relation in Z3",
		() =>
			Effect.gen(function* () {
				const report = yield* Verify.model(Agents, {
					apis: [AgentsApi],
					story,
					walks: { count: 50 },
					lock: "./Agents.verify.lock.json",
					require: { proved: PROVED },
				})
				expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
					STANDING,
				)
				expect(report.undone).toEqual([])
				expect(report.explored.aside).toEqual([])
				expect(report.explored.disagreements).toEqual([])
				expect(report.explored.agreement.compared).toBeGreaterThan(0)
			}).pipe(Effect.provide(NodeServices.layer)),
		120_000,
	)
})
