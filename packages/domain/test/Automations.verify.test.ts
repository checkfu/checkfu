import * as Domain from "@alchemy.run/domain"
import { Story } from "@alchemy.run/domain/Story"
import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { ArmAutomation } from "../src/Automation/ArmAutomation.policy.ts"
import { sessionIdOfNextRun } from "../src/Automation/Automation.id.ts"
import { upcomingOccurrences } from "../src/Automation/Schedule.ts"
import { Automations } from "../src/Automations.model.ts"

// The explorer cannot follow a firing armed for a computed instant, so it leaves
// ArmAutomation out and sends FireAutomation itself, for any instant, at any point.
class AutomationsLifecycleApi extends Domain.Api("AutomationsLifecycleApi", {
	model: Automations,
	commands: [
		"CreateAutomation",
		"PauseAutomation",
		"UnpauseAutomation",
		"ArchiveAutomation",
		"RunAutomation",
		"FireAutomation",
		"SuspendAutomation",
		"RecordAutomationRunStarted",
		"RecordAutomationRunFailed",
	],
	views: ["AutomationView", "AutomationRunView"],
}) {}

const story = Story.make(Automations, {
	layer: ArmAutomation.toLayer(Effect.succeed(() => Effect.void)),
})

const STANDING = {
	"Automation.StatusIsKnown": "proved",
	"Automation.NothingRunsBeforeCreation": "proved",
	"Automation.ReportedNeverExceedsRuns": "proved",
	"Automation.RevisedExactlyWhenCreated": "proved",
	"Automation.CreatedAutomationNeverReturnsToUninitialized": "proved",
	"Automation.ArchivedAutomationStaysArchived": "proved",
	"Automation.ArchivedAutomationNeverFires": "proved",
	"Automation.OnlyUnpauseResumesAPausedAutomation": "proved",
	"Automation.RunsGrowByOneOrNotAtAll": "proved",
	"Automation.OnlyRunAndFireStartRuns": "proved",
	"Automation.ScheduledFiringNeedsAnActiveAutomationAndALaterInstant": "proved",
	"Automation.OnlyAResumeOrAnUpdateStartsANewActivation": "proved",
	"Automation.EveryResumeStartsANewActivation": "proved",
	"Automation.ScheduledInstantNeverGoesBack": "proved",
	"Automation.FiredCarriesTheNewRun": "proved",
	"Automation.RunsAreReportedInOrder": "proved",
	"Automation.AFailedRunPausesOnlyAnActiveAutomation": "proved",
	"Automation.OnlyAnUpdateOfTheCurrentRevisionRevisesIt": "proved",
	"Automation.OnlyANewScheduleOnAnActiveAutomationRestartsIt": "proved",
	"Automation.AnUpdateLeavesRunsAlone": "proved",
	"Automations.AutomationViewMatchesAutomation": "checked",
	"Automations.RunLedgerHoldsEveryReportedRun": "checked",
	"Automations.AnAutomationFiresOnSchedule": "reached",
	"Automations.AnAutomationIsPaused": "reached",
	"Automations.AnAutomationIsArchived": "reached",
} as const

const PROVED = Object.entries(STANDING)
	.filter(([, standing]) => standing === "proved")
	.map(([name]) => name)

describe("Automations Z3 formal verification", () => {
	it.live(
		"proves every Automation invariant and transition in Z3 against firings at any instant",
		() =>
			Effect.gen(function* () {
				const report = yield* Verify.model(Automations, {
					apis: [AutomationsLifecycleApi],
					story,
					instances: 1,
					walks: { count: 50 },
					allow: { skipped: ["ArmAutomation"] },
					opaque: [sessionIdOfNextRun, upcomingOccurrences],
					lock: "./Automations.verify.lock.json",
					require: { proved: PROVED },
				})
				expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
					STANDING,
				)
				expect(report.undone).toEqual([])
				expect(report.explored.aside).toEqual([])
				expect(report.explored.skipped.map((skipped) => skipped.policy)).toEqual(["ArmAutomation"])
				expect(report.explored.disagreements).toEqual([])
				expect(report.explored.agreement.compared).toBeGreaterThan(0)
			}).pipe(Effect.provide(NodeServices.layer)),
		120_000,
	)
})
