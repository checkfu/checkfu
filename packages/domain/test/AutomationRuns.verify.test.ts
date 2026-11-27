import * as Explore from "@alchemy.run/domain/Explore"
import { Story } from "@alchemy.run/domain/Story"
import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { sessionIdOfNextRun } from "../src/Automation/Automation.id.ts"
import { isUsableSchedule, upcomingOccurrences } from "../src/Automation/Schedule.ts"
import {
	AutomationRuns,
	AutomationRunsApi,
	AutomationRunsHandlersLive,
} from "../src/AutomationRuns.model.ts"
import {
	decodeAgentTools,
	decodeMcpServerCredentials,
	decodeMcpServers,
} from "../src/Mcp/McpServers.ts"
import { decodeSystemMessage } from "../src/Session/SendSystemMessage.command.ts"
import { addToolUseId, removeToolUseId } from "../src/Session/SessionTypes.ts"

const story = Story.make(AutomationRuns, { layer: AutomationRunsHandlersLive })

const STANDING = {
	"AdmitAutomation.AdmissionLeavesAgentAndEnvironmentUnchanged": "proved",
	"AdmitAutomation.AdmissionTakesOneSlotWithinTheLimit": "proved",
	"AdmitAutomation.OnlyActiveAgentAndEnvironmentAdmitAutomation": "proved",
	"AdmitAutomation.PinnedVersionWithinAgentHead": "proved",
	"AdmitAutomation.AnAdmittedAutomationHasAUsableSchedule": "proved",
	"Agent.ArchivedAgentStaysArchived": "proved",
	"Agent.ConfigurationIsStableWithinAVersion": "proved",
	"Agent.CreatedAgentNeverReturnsToUninitialized": "proved",
	"Agent.CreatedExactlyWhenVersioned": "proved",
	"Agent.StatusIsKnown": "proved",
	"Agent.VersionGrowsByOneOrNotAtAll": "proved",
	"Automation.AFailedRunPausesOnlyAnActiveAutomation": "proved",
	"Automation.AFailedRunPausesOnlyWhenUnrecoverableAtTheCurrentRevision": "proved",
	"Automation.AnUpdateLeavesRunsAlone": "proved",
	"Automation.ArchivedAutomationNeverFires": "proved",
	"Automation.ArchivedAutomationStaysArchived": "proved",
	"Automation.CreatedAutomationNeverReturnsToUninitialized": "proved",
	"Automation.EveryResumeStartsANewActivation": "proved",
	"Automation.FiredCarriesTheNewRun": "proved",
	"Automation.NothingRunsBeforeCreation": "proved",
	"Automation.OnlyAResumeOrAnUpdateStartsANewActivation": "proved",
	"Automation.OnlyCreationOrAnUpdateRevisesIt": "proved",
	"Automation.OnlyRunAndFireStartRuns": "proved",
	"Automation.OnlyUnpauseResumesAPausedAutomation": "proved",
	"Automation.ReportedNeverExceedsRuns": "proved",
	"Automation.RevisedExactlyWhenCreated": "proved",
	"Automation.RunsAreReportedInOrder": "proved",
	"Automation.RunsGrowByOneOrNotAtAll": "proved",
	"Automation.ScheduledFiringNeedsAnActiveAutomationAndALaterInstant": "proved",
	"Automation.ScheduledInstantNeverGoesBack": "proved",
	"Automation.StatusIsKnown": "proved",
	"AutomationCapacity.ReservedSlotsStayWithinTheLimit": "proved",
	"AutomationCapacity.SlotsChangeOneAtATime": "proved",
	"CreateAgent.NewAgentKeepsItsDeclaredServers": "proved",
	"CreateAgent.NewAgentKeepsItsDeclaredTools": "proved",
	"CreateAgent.NewAgentStartsAtVersionOne": "proved",
	"Environment.ArchivedNeverReactivates": "proved",
	"Environment.ConfiguredExactlyWhenCreated": "proved",
	"Environment.CreatedEnvironmentNeverReturnsToUninitialized": "proved",
	"Environment.CreatedExactlyWhenVersioned": "proved",
	"Environment.DeletedStaysDeleted": "proved",
	"Environment.StatusIsKnown": "proved",
	"Environment.UpdateKeepsWhatItDoesNotName": "proved",
	"Environment.AnUpdateAppliesOnlyAtTheExpectedVersion": "proved",
	"Environment.VersionGrowsByOneOrNotAtAll": "proved",
	"OpenAutomationSession.AnAutomationSessionOpensOnItsFirstTurnWithNothingQueued": "proved",
	"OpenAutomationSession.AnAutomationSessionPinsAVersionWithinTheAgentHead": "proved",
	"OpenAutomationSession.AnAutomationSessionRecordsItsAutomation": "proved",
	"OpenAutomationSession.FirstTurnAdmissionKeepsGivenCredentials": "proved",
	"OpenAutomationSession.OnlyActiveAgentAndEnvironmentOpenAnAutomationSession": "proved",
	"OpenAutomationSession.OpeningAnAutomationSessionLeavesAgentAndEnvironmentUnchanged": "proved",
	"Session.AContinuationKeepsTheTurn": "proved",
	"Session.ADeadlineAbandonsOnlyItsOwnSegment": "proved",
	"Session.AWorkerCommandRecordsOnlyForTheRunningTurn": "proved",
	"Session.AUserMessageWaitsForTheInitialMessages": "proved",
	"Session.APauseKeepsTheTurn": "proved",
	"Session.APausedTurnAskedWhatItWaitsOn": "proved",
	"Session.APausedTurnGoesOnOnceAnswered": "proved",
	"Session.APausedTurnHoldsNoModelRequest": "proved",
	"Session.APausedTurnIsNotAbandoned": "proved",
	"Session.APausedTurnTakesNoUserMessage": "proved",
	"Session.APausedTurnWaitsOnACall": "proved",
	"Session.AStopNamesTheUnansweredCalls": "proved",
	"Session.AbandonedTurnEnds": "proved",
	"Session.AgentMessageEndsTheTurn": "proved",
	"Session.AnEndedTurnStartsTheQueuedOne": "proved",
	"Session.AnInterruptEndsAPausedTurn": "proved",
	"Session.AnInterruptedTurnIsNotPaused": "proved",
	"Session.AnInterruptedTurnNeitherWaitsNorGoesOn": "proved",
	"Session.AnInterruptedTurnStaysInterrupted": "proved",
	"Session.ArchivedSessionStaysArchived": "proved",
	"Session.CreatedSessionNeverReturnsToUninitialized": "proved",
	"Session.IdleSessionStartsTheNextTurn": "proved",
	"Session.IdleTurnIsNonNegative": "proved",
	"Session.InitialMessagesAreBoundedAndOnlyBeforeTheFirstTurn": "proved",
	"Session.ModelRequestsStartedGrowsByAtMostOneWithinTurn": "proved",
	"Session.ModelRequestsStartedNeverDecreasesWithinTurn": "proved",
	"Session.ModelRequestsStartedNonNegative": "proved",
	"Session.OnlyAPauseMakesATurnWait": "proved",
	"Session.OnlyArchiveSessionSetsArchivedFlag": "proved",
	"Session.OnlySendUserMessageAddsPendingMessages": "proved",
	"Session.OnlyTheLastInitialMessageStartsTheTurn": "proved",
	"Session.OnlyTheNextInitialMessageCanAdvanceAdmission": "proved",
	"Session.OpenModelRequestClosedBeforeLeavingRunning": "proved",
	"Session.OpenModelRequestRequiresStartedCount": "proved",
	"Session.PendingUserMessagesGrowsByAtMostOneWithinTurn": "proved",
	"Session.PendingUserMessagesWithinBounds": "proved",
	"Session.RunningTurnIsPositive": "proved",
	"Session.StatusIdleCarriesEndedTurn": "proved",
	"Session.StatusRunningCarriesStartedTurn": "proved",
	"Session.TerminatedSessionStaysTerminated": "proved",
	"Session.TurnAdvancesByAtMostOne": "proved",
	"Session.TurnNeverDecreases": "proved",
	"AutomationRuns.ReservedSlotsCoverLiveAutomations": "checked",
	"AutomationRuns.EveryFiredRunIsReported": "checked",
	"AutomationRuns.ReservedSlotsEqualLiveAutomations": "checked",
	"AutomationRuns.AStartedRunIsReported": "reached",
	"AutomationRuns.AFailedRunPausesTheAutomation": "reached",
	"AutomationRuns.AnArchivedAutomationFreesItsSlot": "reached",
} as const

const PROVED = Object.entries(STANDING)
	.filter(([, standing]) => standing === "proved")
	.map(([name]) => name)

describe("Automation runs Z3 formal verification", () => {
	it.live(
		"checks run reporting and capacity reclamation with the production policies",
		() =>
			Effect.gen(function* () {
				const report = yield* Verify.model(AutomationRuns, {
					apis: [AutomationRunsApi],
					story,
					instances: 1,
					depth: 4,
					faults: { redeliver: false, reorder: false, rerun: false },
					walks: { count: 200, length: 12 },
					opaque: [
						sessionIdOfNextRun,
						isUsableSchedule,
						upcomingOccurrences,
						decodeMcpServers,
						decodeMcpServerCredentials,
						decodeAgentTools,
						addToolUseId,
						removeToolUseId,
						decodeSystemMessage,
					],
					lock: "./AutomationRuns.verify.lock.json",
					require: { proved: PROVED },
				})
				yield* Effect.logInfo(Verify.render(report))
				expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
					STANDING,
				)
				expect(report.undone).toEqual([])
				expect(report.explored.followed.toSorted()).toEqual([
					"FreeAutomationSlot",
					"PrepareAutomationRunFixture",
					"StartAutomationRun",
				])
				expect(report.explored.skipped.map((skipped) => skipped.policy)).toEqual([])
				expect(report.explored.complete).toBe(4)
				expect(report.explored.disagreements).toEqual([])
				expect(report.explored.agreement.compared).toBeGreaterThan(0)
				const replayedScripts = new Set(
					report.runs
						.filter((run) => run.failure === undefined)
						.map((run) => Explore.script(run.story)),
				)
				const replayedOutcomes = report.explored.outcomes
					.filter(
						(outcome) =>
							outcome.kind === "records" &&
							outcome.story !== undefined &&
							replayedScripts.has(Explore.script(outcome.story)),
					)
					.map((outcome) => `${outcome.command} → ${outcome.tag}`)
				expect(replayedOutcomes).toEqual(
					expect.arrayContaining([
						"RecordAutomationRunStarted → automation.run_started",
						"RecordAutomationRunFailed → automation.run_failed",
					]),
				)
			}).pipe(Effect.provide(NodeServices.layer)),
		1_200_000,
	)
})
