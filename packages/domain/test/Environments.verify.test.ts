import { Story } from "@alchemy.run/domain/Story"
import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Environments, EnvironmentsApi } from "../src/Environments.model.ts"

const story = Story.make(Environments)

const STANDING = {
	"Environment.StatusIsKnown": "proved",
	"Environment.CreatedExactlyWhenVersioned": "proved",
	"Environment.ConfiguredExactlyWhenCreated": "proved",
	"Environment.CreatedEnvironmentNeverReturnsToUninitialized": "proved",
	"Environment.ArchivedNeverReactivates": "proved",
	"Environment.DeletedStaysDeleted": "proved",
	"Environment.VersionGrowsByOneOrNotAtAll": "proved",
	"Environments.EnvironmentViewMatchesEnvironment": "checked",
	"Environments.AnEnvironmentIsUpdated": "reached",
	"Environments.AnEnvironmentIsArchived": "reached",
	"Environments.AnEnvironmentIsDeleted": "reached",
} as const

const PROVED = Object.entries(STANDING)
	.filter(([, standing]) => standing === "proved")
	.map(([name]) => name)

describe("Environments Z3 formal verification", () => {
	it.live(
		"proves every Environment invariant and transition in Z3",
		() =>
			Effect.gen(function* () {
				const report = yield* Verify.model(Environments, {
					apis: [EnvironmentsApi],
					story,
					instances: 1,
					walks: { count: 50 },
					lock: "./Environments.verify.lock.json",
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
