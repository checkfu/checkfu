import { Story } from "@alchemy.run/domain/Story"
import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Checkfu } from "../src/Checkfu.model.ts"
import { Environments, EnvironmentsApi } from "../src/Environments.model.ts"

const story = Story.make(Environments)

const STANDING = {
	"Environment.StatusIsKnown": "proved",
	"Environment.CreatedExactlyWhenVersioned": "proved",
	"Environment.ConfiguredExactlyWhenCreated": "proved",
	"Environment.UpdateKeepsWhatItDoesNotName": "proved",
	"Environments.EnvironmentViewConfigMatchesEnvironment": "checked",
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
		300_000,
	)

	it("tells a projected config apart from the aggregate's by type, by hosts and by each flag", () => {
		const limited = (
			allow_mcp_servers: boolean,
			allow_package_managers: boolean,
			allowed_hosts: ReadonlyArray<string>,
		) => ({
			type: "cloud" as const,
			networking: {
				type: "limited" as const,
				allow_mcp_servers,
				allow_package_managers,
				allowed_hosts,
			},
		})
		const unrestricted = { type: "cloud" as const, networking: { type: "unrestricted" as const } }
		const committed = limited(false, true, ["api.openai.com", "registry.npmjs.org"])
		type Config = ReturnType<typeof limited> | typeof unrestricted
		const world = (aggregate: Config, projected: Config) => ({
			Environment: [
				{
					id: "env_1",
					state: {
						status: "active",
						version: 2,
						name: "Env",
						description: null,
						config: aggregate,
					},
				},
			],
			EnvironmentView: [{ id: "env_1", state: { description: null, config: projected } }],
		})
		const cases = [
			{ aggregate: committed, projected: committed, matches: true },
			{ aggregate: unrestricted, projected: unrestricted, matches: true },
			{ aggregate: committed, projected: unrestricted, matches: false },
			{ aggregate: unrestricted, projected: committed, matches: false },
			{
				aggregate: committed,
				projected: limited(false, true, ["api.openai.com", "example.com"]),
				matches: false,
			},
			{ aggregate: committed, projected: limited(false, true, ["api.openai.com"]), matches: false },
			{
				aggregate: committed,
				projected: limited(true, true, committed.networking.allowed_hosts),
				matches: false,
			},
			{
				aggregate: committed,
				projected: limited(false, false, committed.networking.allowed_hosts),
				matches: false,
			},
		]
		const verdicts = [Environments.invariants, Checkfu.invariants].map((invariants) =>
			Object.entries(invariants)
				.filter(([name]) => name === "EnvironmentViewConfigMatchesEnvironment")
				.map(([, rule]) =>
					cases.map(({ aggregate, projected }) => rule(world(aggregate, projected) as never)),
				),
		)
		const expected = cases.map(({ matches }) => matches)
		expect(verdicts).toEqual([[expected], [expected]])
	})
})
