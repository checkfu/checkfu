import * as Domain from "@alchemy.run/domain"
import { ReserveArtifact } from "../src/Artifact/ReserveArtifact.command.ts"
import { ArtifactBytesKept } from "../src/Artifact/ArtifactBytes.external.ts"
import { FileBytesKept } from "../src/File/FileBytes.external.ts"
import { OutputsUnsaved } from "../src/Session/OutputsSaver.external.ts"
import {
	NO_AGENT_TOOLS,
	NO_MCP_SERVERS,
	decodeAgentTools,
	decodeMcpServerCredentials,
	decodeMcpServers,
} from "../src/Mcp/McpServers.ts"
import * as InMemory from "@alchemy.run/domain/InMemory"
import * as Model from "@alchemy.run/domain/Model"
import { decodeSystemMessage } from "../src/Session/SendSystemMessage.command.ts"
import * as Explore from "@alchemy.run/domain/Explore"
import * as Verify from "@alchemy.run/domain/Verify"
import { Agent } from "../src/Agent/Agent.aggregate.ts"
import { AgentId } from "../src/Agent/Agent.id.ts"
import { AgentVersionId } from "../src/Agent/AgentVersion.id.ts"
import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "../src/Agent/AgentVersionByNumberView.view.ts"
import { AgentView } from "../src/Agent/AgentView.view.ts"
import { ArchiveAgent } from "../src/Agent/ArchiveAgent.command.ts"
import { CreateAgent } from "../src/Agent/CreateAgent.command.ts"
import { CreateAgentDecision } from "../src/Agent/CreateAgent.decision.ts"
import { UpdateAgent } from "../src/Agent/UpdateAgent.command.ts"
import { UpdateAgentDecision } from "../src/Agent/UpdateAgent.decision.ts"
import { Automation } from "../src/Automation/Automation.aggregate.ts"
import { ArchiveAutomation } from "../src/Automation/ArchiveAutomation.command.ts"
import { AdmitAutomation } from "../src/Automation/AdmitAutomation.command.ts"
import { AdmitAutomationDecision } from "../src/Automation/AdmitAutomation.decision.ts"
import { UpdateAutomationDecision } from "../src/Automation/UpdateAutomation.decision.ts"
import { UpdateAutomation } from "../src/Automation/UpdateAutomation.command.ts"
import {
	ArchiveAgentIfCurrentDecision,
	ArchiveEnvironmentIfCurrentDecision,
} from "../src/Automation/GuardedArchives.ts"
import { AUTOMATION_CAPACITY } from "../src/Automation/AutomationCapacity.id.ts"
import { RunAutomation } from "../src/Automation/RunAutomation.command.ts"
import { AutomationId, sessionIdOfNextRun } from "../src/Automation/Automation.id.ts"
import { AutomationCapacity } from "../src/Automation/AutomationCapacity.aggregate.ts"
import { AutomationRunView } from "../src/Automation/AutomationRunView.view.ts"
import { AutomationView } from "../src/Automation/AutomationView.view.ts"
import { isUsableSchedule, upcomingOccurrences } from "../src/Automation/Schedule.ts"
import { AddArtifactVersion } from "../src/Artifact/AddArtifactVersion.command.ts"
import { Artifact } from "../src/Artifact/Artifact.aggregate.ts"
import { ArtifactId } from "../src/Artifact/Artifact.id.ts"
import { CreateArtifact } from "../src/Artifact/CreateArtifact.command.ts"
import { ArtifactVersionView } from "../src/Artifact/ArtifactVersionView.view.ts"
import { ArchiveEnvironment } from "../src/Environment/ArchiveEnvironment.command.ts"
import { CreateEnvironment } from "../src/Environment/CreateEnvironment.command.ts"
import { DeleteEnvironment } from "../src/Environment/DeleteEnvironment.command.ts"
import { Environment } from "../src/Environment/Environment.aggregate.ts"
import { EnvironmentId } from "../src/Environment/Environment.id.ts"
import { EnvironmentView } from "../src/Environment/EnvironmentView.view.ts"
import { ArchiveSession } from "../src/Session/ArchiveSession.command.ts"
import { Harness } from "../src/Session/Harness.external.ts"
import { SendUserMessage } from "../src/Session/SendUserMessage.command.ts"
import { Session } from "../src/Session/Session.aggregate.ts"
import { addToolUseId, removeToolUseId } from "../src/Session/SessionTypes.ts"
import { SessionId } from "../src/Session/Session.id.ts"
import { SessionResourceId } from "../src/Session/SessionResource.ts"
import { SessionView } from "../src/Session/SessionView.view.ts"
import { TurnInput } from "../src/Session/TurnInput.view.ts"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Checkfu, CheckfuDomainApi, CheckfuHandlersLive } from "../src/Checkfu.model.ts"
import { ListingStore } from "../src/Listing/ListingStore.ts"
import { WebhookEventsNoop } from "../src/Webhook/WebhookEvents.external.ts"
import { Memory } from "../src/Memory/Memory.aggregate.ts"
import { MemoryIndex } from "../src/Memory/MemoryIndex.view.ts"
import { MemoryStore } from "../src/Memory/MemoryStore.aggregate.ts"
import { MemoryStoreView } from "../src/Memory/MemoryStoreView.view.ts"
import { MemoryView } from "../src/Memory/MemoryView.view.ts"
import {
	AdmitSession,
	BoundedAgentId,
	BoundedEnvironmentId,
} from "../src/Session/AdmitSession.command.ts"
import { AdmitMountedSessionDecision } from "../src/Session/AdmitMountedSession.decision.ts"
import { AdmitSessionDecision } from "../src/Session/AdmitSession.decision.ts"

class CheckfuLifecycleApi extends Domain.Api("CheckfuLifecycleApi", {
	model: Checkfu,
	commands: [
		"CreateAgent",
		"CreateEnvironment",
		"AdmitSession",
		"SendUserMessage",
		"ClaimIdempotencyKey",
	],
	views: ["AgentView", "AgentVersionByNumberView", "EnvironmentView", "SessionView"],
}) {}

// Variable-participant admissions and guarded archives have dedicated verification and integration tests.
const CheckfuProofBase: Model.Any & (new (_: never) => object) = Checkfu
class CheckfuInductiveModel extends CheckfuProofBase {
	static override readonly decisions = Checkfu.decisions.filter(
		(decision) =>
			decision !== AdmitMountedSessionDecision &&
			decision !== ArchiveAgentIfCurrentDecision &&
			decision !== ArchiveEnvironmentIfCurrentDecision,
	)
	static override readonly commands = Checkfu.commands.filter(
		(command) =>
			command !== AdmitMountedSessionDecision.command &&
			command !== ArchiveAgentIfCurrentDecision.command &&
			command !== ArchiveEnvironmentIfCurrentDecision.command,
	)
	static override readonly definitions = { ...Checkfu.definitions, decisions: this.decisions }
}

const REPOSITORY = {
	id: SessionResourceId.make("sesrsc_post_1"),
	type: "github_repository" as const,
	access: "read_write" as const,
	url: "https://github.com/acme/api",
	mount_path: "/workspace/api",
	checkout: { type: "branch" as const, name: "main" },
}

const STANDING = {
	"Agent.StatusIsKnown": "proved",
	"Agent.CreatedExactlyWhenVersioned": "proved",
	"Agent.ConfigurationIsStableWithinAVersion": "proved",
	"Agent.CreatedAgentNeverReturnsToUninitialized": "proved",
	"Agent.ArchivedAgentStaysArchived": "proved",
	"Agent.VersionGrowsByOneOrNotAtAll": "proved",
	"Environment.StatusIsKnown": "proved",
	"Environment.CreatedExactlyWhenVersioned": "proved",
	"Environment.ConfiguredExactlyWhenCreated": "proved",
	"Environment.UpdateKeepsWhatItDoesNotName": "proved",
	"Environment.AnUpdateAppliesOnlyAtTheExpectedVersion": "proved",
	"Checkfu.EnvironmentViewConfigMatchesEnvironment": "checked",
	"Environment.CreatedEnvironmentNeverReturnsToUninitialized": "proved",
	"Environment.ArchivedNeverReactivates": "proved",
	"Environment.DeletedStaysDeleted": "proved",
	"Environment.VersionGrowsByOneOrNotAtAll": "proved",
	"Session.RunningTurnIsPositive": "proved",
	"Session.IdleTurnIsNonNegative": "proved",
	"SystemContext.LengthStaysWithinCapacity": "proved",
	"SendSystemMessage.SystemContextGrowsOnAnActiveSession": "proved",
	"Session.InitialMessagesAreBoundedAndOnlyBeforeTheFirstTurn": "proved",
	"Session.ModelRequestsStartedNonNegative": "proved",
	"Session.PendingUserMessagesWithinBounds": "proved",
	"Session.OpenModelRequestRequiresStartedCount": "proved",
	"Session.OnlyTheNextInitialMessageCanAdvanceAdmission": "proved",
	"Session.OnlyTheLastInitialMessageStartsTheTurn": "proved",
	"Session.TerminatedSessionStaysTerminated": "proved",
	"Session.ArchivedSessionStaysArchived": "proved",
	"Session.CreatedSessionNeverReturnsToUninitialized": "proved",
	"Session.FencingClosesAnUninitializedSessionBeforeItCanAdmit": "proved",
	"Session.TurnNeverDecreases": "proved",
	"Session.TurnAdvancesByAtMostOne": "proved",
	"Session.ModelRequestsStartedNeverDecreasesWithinTurn": "proved",
	"Session.ModelRequestsStartedGrowsByAtMostOneWithinTurn": "proved",
	"Session.PendingUserMessagesGrowsByAtMostOneWithinTurn": "proved",
	"Session.OnlySendUserMessageAddsPendingMessages": "proved",
	"Session.OnlyArchiveSessionSetsArchivedFlag": "proved",
	"Session.IdleSessionStartsTheNextTurn": "proved",
	"Session.StatusRunningCarriesStartedTurn": "proved",
	"Session.StatusIdleCarriesEndedTurn": "proved",
	"Session.AbandonedTurnEnds": "proved",
	"Session.ATruncatedReplyNeverEndsTheTurnAsFinished": "proved",
	"Session.AgentMessageEndsTheTurn": "proved",
	"Session.OpenModelRequestClosedBeforeLeavingRunning": "proved",
	"Artifact.StatusIsKnown": "proved",
	"Artifact.CreatedExactlyWhenVersioned": "proved",
	"Artifact.CreatedArtifactNeverReturnsToUninitialized": "proved",
	"Artifact.DeletedStaysDeleted": "proved",
	"Artifact.NameNeverChangesOnceCreated": "proved",
	"Artifact.VersionGrowsByOneOrNotAtAll": "proved",
	"Artifact.AddedVersionRecordsItsManifest": "proved",
	"Artifact.ADeletedArtifactIsNotPublished": "proved",
	"Artifact.PublishedOnlyOnceCreated": "proved",
	"Artifact.UnpublishedHoldsNoSettings": "proved",
	"Artifact.APublicationHasAnAccessLevel": "proved",
	"Artifact.OnlyAReadOrWritePublicationGrantsData": "proved",
	"Artifact.PinnedVersionWithinHead": "proved",
	"Artifact.AWriteRecordsItsRequest": "proved",
	"Artifact.AChangedPublicationMatchesItsCondition": "proved",
	"Artifact.ARevokedPublicationMatchesItsCondition": "proved",
	"Artifact.ACommittedCreationKeepsItsRequest": "proved",
	"Artifact.AReservationIsOpenOnlyBeforeCreation": "proved",
	"Artifact.OnlyTheLatestReservationIsOpen": "proved",
	"Artifact.ATokenIsOnlyOpenedOrDropped": "proved",
	"Artifact.UnpublishDropsTheToken": "proved",
	"Artifact.PublishKeepsTheTokenOrTakesTheFreshOne": "proved",
	"Artifact.PublishServesAVersionTheArtifactHas": "proved",
	"Artifact.APublicationStartsAtViewUnlessGranted": "proved",
	"Artifact.OnlyAnExplicitGrantChangesWhatThePublicMayDo": "proved",
	"Artifact.AnExplicitGrantIsRecordedAsGiven": "proved",
	"Artifact.ANewVersionRecordsTheCapabilitiesItWasGiven": "proved",
	"Artifact.OnlyANewVersionChangesTheCapabilities": "proved",
	"Artifact.ANewVersionRecordsWhatItWasMadeFrom": "proved",
	"Artifact.OnlyANewVersionChangesWhatItWasMadeFrom": "proved",
	"Artifact.ReservationsAreNumberedInOrder": "proved",
	"Artifact.CreatingTakesTheOpenReservation": "proved",
	"Artifact.ClaimingAKeyChangesNoState": "proved",
	"File.StatusIsKnown": "proved",
	"File.DescribedExactlyWhenCreated": "proved",
	"File.AnOriginNamesASessionATurnAndAPathOrNone": "proved",
	"File.AReservationIsOpenOnlyBeforeCreation": "proved",
	"File.OnlyTheLatestReservationIsOpen": "proved",
	"File.CreatedFileNeverReturnsToUninitialized": "proved",
	"File.DeletedStaysDeleted": "proved",
	"File.ContentNeverChanges": "proved",
	"File.ReservationsAreNumberedInOrder": "proved",
	"File.CreatingTakesTheOpenReservation": "proved",
	"SessionOutputs.OutcomeIsKnown": "proved",
	"SessionOutputs.AnOutcomeIsRecordedExactlyWhenATurnIs": "proved",
	"SessionOutputs.AReasonIsGivenExactlyWhenTheTurnWasSkipped": "proved",
	"SessionOutputs.TheRecordedTurnNeverGoesBack": "proved",
	"SessionOutputs.ATurnIsRecordedAtMostOnce": "proved",
	"SessionOutputs.ASkippedTurnKeepsTheFilesSavedBefore": "proved",
	"SessionOutputs.ASavedTurnReplacesTheFiles": "proved",
	"SessionOutputs.NothingChangesWithoutARecord": "proved",
	"Session.APausedTurnHoldsNoModelRequest": "proved",
	"Session.APausedTurnWaitsOnACall": "proved",
	"Session.APausedTurnAskedWhatItWaitsOn": "proved",
	"Session.AnInterruptedTurnIsNotPaused": "proved",
	"Session.OnlyAPauseMakesATurnWait": "proved",
	"Session.APausedTurnTakesNoUserMessage": "proved",
	"Session.APausedTurnIsNotAbandoned": "proved",
	"Session.APauseKeepsTheTurn": "proved",
	"Session.AContinuationKeepsTheTurn": "proved",
	"Session.APausedTurnGoesOnOnceAnswered": "proved",
	"Session.AnInterruptEndsAPausedTurn": "proved",
	"Session.AnInterruptedTurnNeitherWaitsNorGoesOn": "proved",
	"Session.AnInterruptedTurnStaysInterrupted": "proved",
	"Session.ADeadlineAbandonsOnlyItsOwnSegment": "proved",
	"Session.AWorkerCommandRecordsOnlyForTheRunningTurn": "proved",
	"Session.AUserMessageWaitsForTheInitialMessages": "proved",
	"Session.AnEndedTurnStartsTheQueuedOne": "proved",
	"Session.AStopNamesTheUnansweredCalls": "proved",
	"ToolConfirmation.OnlyADenialCarriesAMessage": "proved",
	"ToolConfirmation.OnlyAReturnedResultIsAnError": "proved",
	"ToolConfirmation.ARequestedCallHasATurn": "proved",
	"ToolConfirmation.ASettledCallNeverChanges": "proved",
	"ToolConfirmation.ACallKeepsItsSessionTurnAndKind": "proved",
	"ToolConfirmation.ACallIsAnsweredWithWhatItAwaits": "proved",
	"RequestToolAction.ARequestWaitsInItsOwnTurn": "proved",
	"ConfirmTool.OnlyAPendingCallOfTheRunningTurnIsConfirmed": "proved",
	"ConfirmTool.AnAnswerMatchesItsSessionAndCall": "proved",
	"ConfirmTool.AnAnswerKeepsTheTurn": "proved",
	"ReturnCustomToolResult.OnlyAPendingCallOfTheRunningTurnGetsAResult": "proved",
	"ReturnCustomToolResult.AResultMatchesItsSessionAndCall": "proved",
	"ReturnCustomToolResult.AResultKeepsTheTurn": "proved",
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
	"Automation.AFailedRunPausesOnlyWhenUnrecoverableAtTheCurrentRevision": "proved",
	"Automation.OnlyCreationOrAnUpdateRevisesIt": "proved",
	"Automation.AnUpdateLeavesRunsAlone": "proved",
	"ArchiveAutomationIfCurrent.AnArchiveHappensAtTheExpectedRevision": "proved",
	"AutomationCapacity.ReservedSlotsStayWithinTheLimit": "proved",
	"AutomationCapacity.SlotsChangeOneAtATime": "proved",
	"CreateAgent.NewAgentKeepsItsDeclaredServers": "proved",
	"CreateAgent.NewAgentKeepsItsDeclaredTools": "proved",
	"MemoryStore.StatusIsKnown": "proved",
	"MemoryStore.NamedExactlyWhenCreated": "proved",
	"MemoryStore.HoldsNoMoreThanItsLimit": "proved",
	"MemoryStore.EveryHeldMemoryChangedTheLayout": "proved",
	"MemoryStore.CreatedStoreNeverReturnsToUninitialized": "proved",
	"MemoryStore.ArchivedStoreNeverReactivates": "proved",
	"MemoryStore.DeletedStoreStaysDeleted": "proved",
	"MemoryStore.OnlyAnActiveStoreChangesWhatItHolds": "proved",
	"MemoryStore.CountMovesByAtMostOne": "proved",
	"MemoryStore.TheLayoutChangesExactlyWhenTheCountDoes": "proved",
	"MemoryStore.UpdateKeepsWhatItDoesNotName": "proved",
	"Memory.StatusIsKnown": "proved",
	"Memory.PlacedExactlyWhenWritten": "proved",
	"Memory.AMemoryNeverLeavesItsPlace": "proved",
	"Memory.VersionGrowsByOneOrNotAtAll": "proved",
	"CreateAgent.NewAgentStartsAtVersionOne": "proved",
	"UpdateAgent.AnExpectedVersionIsTheHeadVersion": "proved",
	"UpdateAgent.ChangeMintsNextVersionOrNoOps": "proved",
	"UpdateAgent.UnchangedConfigMintsNothing": "proved",
	"AdmitSessionWithMessages.OnlyActiveAgentAndEnvironmentAdmitSession": "proved",
	"AdmitSessionWithMessages.PinnedVersionWithinAgentHead": "proved",
	"AdmitSessionWithMessages.AdmissionLeavesAgentAndEnvironmentUnchanged": "proved",
	"AdmitSessionWithMessages.AdmissionKeepsTheCredentialsItWasGiven": "proved",
	"AdmitSessionWithMessages.AdmissionKeepsTheInitialPlan": "proved",
	"AdmitSession.OnlyActiveAgentAndEnvironmentAdmitSession": "proved",
	"AdmitSession.PinnedVersionWithinAgentHead": "proved",
	"AdmitSession.AdmissionLeavesAgentAndEnvironmentUnchanged": "proved",
	"AdmitSession.AdmissionKeepsTheCredentialsItWasGiven": "proved",
	"AdmitAutomation.OnlyActiveAgentAndEnvironmentAdmitAutomation": "proved",
	"AdmitAutomation.PinnedVersionWithinAgentHead": "proved",
	"AdmitAutomation.AnAdmittedAutomationHasAUsableSchedule": "proved",
	"AdmitAutomation.AdmissionTakesOneSlotWithinTheLimit": "proved",
	"AdmitAutomation.AdmissionLeavesAgentAndEnvironmentUnchanged": "proved",
	"OpenAutomationSession.OnlyActiveAgentAndEnvironmentOpenAnAutomationSession": "proved",
	"OpenAutomationSession.AnAutomationSessionOpensOnItsFirstTurnWithNothingQueued": "proved",
	"OpenAutomationSession.AnAutomationSessionPinsAVersionWithinTheAgentHead": "proved",
	"OpenAutomationSession.AnAutomationSessionRecordsItsAutomation": "proved",
	"OpenAutomationSession.FirstTurnAdmissionKeepsGivenCredentials": "proved",
	"OpenAutomationSession.OpeningAnAutomationSessionLeavesAgentAndEnvironmentUnchanged": "proved",
	"UpdateAutomation.AnUpdateNeedsTheCurrentRevisionOfALiveAutomation": "proved",
	"UpdateAutomation.AChangedAgentIsActiveAndHasThePinnedVersion": "proved",
	"UpdateAutomation.AChangedEnvironmentIsActive": "proved",
	"UpdateAutomation.AnUpdateStoresOnlyAUsableSchedule": "proved",
	"UpdateAutomation.OnlyANewScheduleOnAnActiveAutomationRestartsIt": "proved",
	"WriteMemory.APresentPreconditionFindsTheMemory": "proved",
	"WriteMemory.AHashPreconditionMatchesTheStoredContent": "proved",
	"WriteMemory.OnlyAnActiveStoreIsWritten": "proved",
	"WriteMemory.AWriteLeavesTheMemoryPresentWithItsContent": "proved",
	"WriteMemory.ANewMemoryCountsOnceAndWithinTheLimit": "proved",
	"WriteMemory.ANewPathCommitsOnlyAtTheLayoutItWasCheckedAgainst": "proved",
	"WriteMemory.AnAbsentPreconditionNeverOverwrites": "proved",
	"WriteMemory.AnExclusivePreconditionNeverOverwrites": "proved",
	"DeleteMemory.AnExpectedHashIsTheStoredHash": "proved",
	"DeleteMemory.ADeleteRemovesOnePresentMemory": "proved",
	"Checkfu.APresentMemoryIsInAStoreThatWasCreated": "proved",
	"Checkfu.EverySessionReferencesExistingAgentVersion": "checked",
	"Checkfu.EverySessionReferencesKnownEnvironment": "checked",
	"Checkfu.HostedViewsMatchAggregates": "checked",
	"Checkfu.AutomationViewsMatchAutomations": "checked",
	"Checkfu.AutomationViewRevisionMatchesAutomation": "checked",
	"Checkfu.ReservedSlotsEqualLiveAutomations": "checked",
	"Checkfu.EveryArtifactVersionIsWithinItsArtifactsHead": "checked",
	"Checkfu.EveryArtifactVersionIsRecorded": "checked",
	"Checkfu.AStoreCountsItsPresentMemories": "checked",
	"Checkfu.MemoryViewsMatchMemories": "checked",
	"Checkfu.TheIndexListsEachStoresPresentMemories": "checked",
	"Checkfu.MemoryStoreViewsMatchStores": "checked",
	"Checkfu.ASessionIsAdmitted": "reached",
	"Checkfu.AnAdmittedSessionCompletesATurn": "reached",
	"Checkfu.ASessionGetsAReply": "reached",
	"Checkfu.EveryTurnSettles": "checked",
} as const

const REPLY_WITNESS = "Checkfu.ASessionGetsAReply"
const INTERRUPT_POLICY = "EnsureTurnStopped"
const ALLOW_EXPLORATION = { skipped: ["EnsureTurnStarted", "PublishWebhookEvents"] } as const

const PROVED = Object.entries(STANDING)
	.filter(([, standing]) => standing === "proved")
	.map(([name]) => name)

const automationRef = Automation.ref(AutomationId.make("auto_post_1"))

const HarnessStubLayer = Harness.toLayer(
	Effect.succeed({
		interrupt: () => Effect.void,
		discardWorkspace: () => Effect.void,
		storeRepositoryToken: () => Effect.void,
		runTurn: () =>
			Effect.succeed({
				thinking: null,
				text: "ok",
				input_tokens: 12,
				output_tokens: 6,
				stop_reason: { type: "end_turn" as const },
			}),
	}),
)

const trackKey = (store: Map<string, Set<string>>, entity: string, key: string): void => {
	let keys = store.get(entity)
	if (keys === undefined) {
		keys = new Set()
		store.set(entity, keys)
	}
	keys.add(key)
}

const evaluateCheckfuInvariants = (world: unknown): Record<string, boolean> =>
	Object.fromEntries(
		Object.entries(Checkfu.invariants).map(([name, check]) => [name, check(world as never)]),
	)

describe("Checkfu unified hosted model Z3 formal verification", () => {
	it("proves every aggregate, decision, and relation in Z3 and checks cross-domain admission and turns", async () => {
		const hostedCommands = CheckfuDomainApi.commands.map((command) => command.tag)
		expect(hostedCommands).toEqual([
			"CreateAgent",
			"UpdateAgent",
			"ArchiveAgent",
			"CreateEnvironment",
			"UpdateEnvironment",
			"ArchiveEnvironment",
			"DeleteEnvironment",
			"AdmitSession",
			"SendUserMessage",
			"SendSystemMessage",
			"SendUserInterrupt",
			"ConfirmTool",
			"ReturnCustomToolResult",
			"ArchiveSession",
			"ClaimIdempotencyKey",
			"AdmitAutomation",
			"PauseAutomation",
			"ResumeAutomation",
			"ArchiveAutomation",
			"RunAutomation",
			"ReserveArtifact",
			"CreateArtifact",
			"AddArtifactVersion",
			"DeleteArtifact",
			"PublishArtifact",
			"UnpublishArtifact",
			"ClaimArtifactIdempotencyKey",
			"ReserveFile",
			"CreateFile",
			"DeleteFile",
			"RecordSessionOutputs",
			"SkipSessionOutputs",
			"CreateMemoryStore",
			"UpdateMemoryStore",
			"ArchiveMemoryStore",
			"DeleteMemoryStore",
			"WriteMemory",
			"DeleteMemory",
		])
		expect(hostedCommands).not.toContain("CreateSession")
		expect(hostedCommands).not.toContain("CreateAutomation")
		expect(
			CheckfuDomainApi.serves.flatMap((entry) => (entry.kind === "View" ? [entry.viewName] : [])),
		).toEqual([
			"AgentView",
			"AgentVersionByNumberView",
			"EnvironmentView",
			"SessionView",
			"AutomationView",
			"AutomationRunView",
			"ArtifactVersionView",
			"MemoryStoreView",
			"MemoryView",
			"MemoryIndex",
		])
		const report = await Effect.runPromise(
			Verify.report(CheckfuInductiveModel, {
				apis: [CheckfuLifecycleApi],
				instances: 1,
				depth: 3,
				budget: 12_000,
				faults: { redeliver: false, reorder: false, rerun: false },
				walks: { count: 120, length: 12 },

				allow: ALLOW_EXPLORATION,
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
				lock: "./Checkfu.verify.lock.json",
				require: { proved: PROVED },
			}).pipe(Effect.provide(NodeServices.layer)),
		)
		const replyUnreached = report.rules.some(
			(rule) => rule.name === REPLY_WITNESS && rule.standing === "unreached",
		)
		expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual({
			...STANDING,
			[REPLY_WITNESS]: replyUnreached ? "unreached" : "reached",
		})
		// The required hosted story supplies this witness even when sampled harness replies do not.
		const missingReply = replyUnreached
			? Explore.undone(
					{
						...report.explored,
						sometimes: report.explored.sometimes.filter(
							(rule) => `${report.explored.model}.${rule.name}` === REPLY_WITNESS,
						),
					},
					ALLOW_EXPLORATION,
				).filter((reason) => reason.startsWith(`${REPLY_WITNESS} is never reached:`))
			: []
		expect(missingReply).toHaveLength(replyUnreached ? 1 : 0)
		const remaining = report.undone.filter((reason) => !missingReply.includes(reason))
		Effect.runSync(Effect.logInfo(Verify.render(report)))
		expect(remaining).toEqual([])
		expect(Verify.verified({ ...report, undone: remaining })).toBe(true)
		// The required interrupt recovery test drives this policy even when search leaves it idle.
		expect(
			[...report.explored.followed, ...report.explored.idle].filter(
				(policy) => policy === INTERRUPT_POLICY,
			),
		).toEqual([INTERRUPT_POLICY])
		expect(report.explored.followed.filter((policy) => policy !== INTERRUPT_POLICY)).toEqual([
			"RecordInitialMessages",
			"StartTurn",
			"SaveSessionOutputs",
		])
		expect(report.explored.idle.filter((policy) => policy !== INTERRUPT_POLICY)).toEqual([
			"ArmAutomation",
			"StartAutomationRun",
			"FreeAutomationSlot",
			"ExpireArtifactReservations",
			"ReleaseArtifactBytes",
			"ExpireFileReservations",
			"ReleaseFileBytes",
		])
		expect(report.explored.sagas).toEqual(["RunTurn"])
		expect(report.explored.unstarted).toEqual([])
		expect(report.explored.skipped.map((skipped) => skipped.policy)).toEqual([
			"PublishWebhookEvents",
			"EnsureTurnStarted",
		])
		expect(report.explored.aside).toEqual([
			{
				kind: "projection",
				name: "Listing",
				reason: "is not declared in a file the model's file imports",
			},
			{
				kind: "view",
				name: "SessionTurnCompletion",
				reason: "no rule reads it and no policy reacts to it",
			},
			{ kind: "query", name: "ListResources", reason: "what a query answers is not checked" },
		])
		expect(report.explored.truncated).toBe(false)
		expect(report.explored.complete).toBe(3)
		expect(report.explored.disagreements).toEqual([])
		expect(report.explored.agreement.compared).toBeGreaterThan(0)
		expect(report.explored.decisions).toContain("AdmitSession")
		const exploredOutcomes = report.explored.outcomes.map(
			(outcome) =>
				`${outcome.aggregate === undefined ? "" : `${outcome.aggregate}.`}${outcome.command} ${outcome.kind === "records" ? "→" : "✗"} ${outcome.tag}`,
		)
		expect(exploredOutcomes).toContain("Session.ClaimIdempotencyKey → idempotency_key.claimed")
	}, 1_200_000)

	it("preserves all cross-domain Checkfu invariants after post-admission UpdateAgent, ArchiveAgent, ArchiveEnvironment, DeleteEnvironment, and ArchiveSession mutations", async () => {
		const platform = InMemory.make({ manual: true })
		const observedAggregateIds = new Map<string, Set<string>>()
		const observedViewKeys = new Map<string, Set<string>>()
		const layer = Checkfu.layer(
			CheckfuHandlersLive.pipe(
				Layer.provide([ArtifactBytesKept, FileBytesKept, OutputsUnsaved, WebhookEventsNoop]),
				Layer.provide([HarnessStubLayer, ListingStore.memory]),
			),
		).pipe(
			Layer.updateService(Domain.Platform, (base) =>
				Domain.Platform.of({
					keys: base.keys,
					model: (hosted) =>
						Effect.map(base.model(hosted), (host) => ({
							...host,
							aggregate: (aggregate, kit) => {
								const handle = kit.handle
								const record = kit.record
								const seed = kit.seed
								const trackedKit = Object.assign(kit, {
									handle: (input: Parameters<typeof handle>[0]) => {
										trackKey(observedAggregateIds, aggregate.aggregateName, input.id)
										return handle(input)
									},
									record: (input: Parameters<typeof record>[0]) => {
										trackKey(observedAggregateIds, aggregate.aggregateName, input.id)
										return record(input)
									},
									seed: (input: Parameters<typeof seed>[0]) => {
										trackKey(observedAggregateIds, aggregate.aggregateName, input.id)
										return seed(input)
									},
								})
								return host.aggregate(aggregate, trackedKit)
							},
							view: (view, kit) => {
								const apply = kit.apply
								const trackedKit = Object.assign(kit, {
									apply: (
										key: Parameters<typeof apply>[0],
										snapshot: Parameters<typeof apply>[1],
										deliveries: Parameters<typeof apply>[2],
									) => {
										trackKey(observedViewKeys, view.viewName, key)
										return apply(key, snapshot, deliveries)
									},
								})
								return Effect.map(host.view(view, trackedKit), (store) => ({
									...store,
									receive: (key, deliveries) => {
										trackKey(observedViewKeys, view.viewName, key)
										return store.receive(key, deliveries)
									},
								}))
							},
						})),
				}),
			),
			Layer.provide(platform.layer),
		)

		const results = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const internals = yield* Model.Internals
					const agents = yield* Agent
					const environments = yield* Environment
					const sessions = yield* Session
					const createAgent = yield* CreateAgentDecision
					const updateAgent = yield* UpdateAgentDecision
					const admitSession = yield* AdmitSessionDecision
					const admitAutomation = yield* AdmitAutomationDecision
					const updateAutomation = yield* UpdateAutomationDecision
					const automations = yield* Automation
					const artifacts = yield* Artifact

					const agentRef = Agent.ref(AgentId.make("agent_post_1"))
					const v1Id = AgentVersionId.make("aver_post_1")
					const v2Id = AgentVersionId.make("aver_post_2")
					const vNoopId = AgentVersionId.make("aver_post_noop")
					const envRef = Environment.ref(EnvironmentId.make("env_post_1"))
					const sessionV1Ref = Session.ref(SessionId.make("sess_post_v1"))
					const sessionV2Ref = Session.ref(SessionId.make("sess_post_v2"))

					const settlePlatform = Effect.gen(function* () {
						for (let i = 0; i < 1000; i++) {
							yield* platform.control.drain
							yield* Effect.yieldNow
							if (yield* platform.control.idle) {
								yield* Effect.yieldNow
								yield* platform.control.drain
								if (yield* platform.control.idle) {
									return
								}
							}
						}
						return yield* Effect.die(new Error("InMemory platform did not settle"))
					})

					const readAggregate = <A extends Domain.Aggregate.Any>(
						aggregate: A,
						probeIds: ReadonlyArray<string> = [],
					): Effect.Effect<
						ReadonlyArray<{
							readonly id: Domain.Aggregate.IdOf<A>
							readonly state: Domain.Aggregate.StateOf<A>
							readonly events: ReadonlyArray<Domain.Aggregate.EventOf<A>>
						}>
					> =>
						Effect.gen(function* () {
							const store = internals.aggregates.get(aggregate.aggregateName)
							if (store === undefined) {
								return yield* Effect.die(
									new Error(`Missing aggregate store for ${aggregate.aggregateName}`),
								)
							}
							const readEvents = store.events
							if (readEvents === undefined) {
								return yield* Effect.die(
									new Error(`Aggregate store ${aggregate.aggregateName} does not expose events`),
								)
							}
							const ids = new Set<string>(probeIds)
							for (const id of observedAggregateIds.get(aggregate.aggregateName) ?? []) {
								ids.add(id)
							}
							for (const commit of platform.control.commits) {
								if (commit.aggregate === aggregate.aggregateName) {
									ids.add(commit.id)
								}
							}
							return yield* Effect.forEach([...ids], (id) =>
								Effect.gen(function* () {
									const storedState = yield* store.state(id)
									const storedEvents = yield* readEvents(id)
									const events = yield* Effect.forEach(storedEvents, (entry) =>
										internals.kernel.decodeEvent(entry.event),
									)
									return {
										id,
										state: internals.kernel.decodeState(aggregate, storedState.state),
										events: events as ReadonlyArray<Domain.Aggregate.EventOf<A>>,
									}
								}),
							)
						})

					const readView = <V extends Domain.View.Any>(
						view: V,
					): Effect.Effect<
						ReadonlyArray<{
							readonly id: string
							readonly state: Exclude<Domain.View.StateOf<V>, null>
						}>
					> =>
						Effect.gen(function* () {
							const store = internals.views.get(view.viewName)
							if (store === undefined) {
								return yield* Effect.die(new Error(`Missing view store for ${view.viewName}`))
							}
							const keys = [...(observedViewKeys.get(view.viewName) ?? [])]
							const rows = yield* Effect.forEach(keys, (key) =>
								store.read(key).pipe(
									Effect.map((snapshot) => {
										if (snapshot.state === null) {
											return []
										}
										const state = internals.kernel.decodeViewState(view, snapshot.state)
										return state === null
											? []
											: [{ id: key, state: state as Exclude<Domain.View.StateOf<V>, null> }]
									}),
								),
							)
							return rows.flat()
						})

					const snapshotWorld = Effect.gen(function* () {
						yield* settlePlatform
						return {
							Agent: yield* readAggregate(Agent),
							Environment: yield* readAggregate(Environment),
							Session: yield* readAggregate(Session),
							MemoryStore: yield* readAggregate(MemoryStore),
							Memory: yield* readAggregate(Memory),
							AgentView: yield* readView(AgentView),
							AgentVersionByNumberView: yield* readView(AgentVersionByNumberView),
							EnvironmentView: yield* readView(EnvironmentView),
							SessionView: yield* readView(SessionView),
							TurnInput: yield* readView(TurnInput),
							Automation: yield* readAggregate(Automation),
							AutomationCapacity: yield* readAggregate(AutomationCapacity),
							AutomationView: yield* readView(AutomationView),
							AutomationRunView: yield* readView(AutomationRunView),
							Artifact: yield* readAggregate(Artifact),
							ArtifactVersionView: yield* readView(ArtifactVersionView),
							MemoryStoreView: yield* readView(MemoryStoreView),
							MemoryView: yield* readView(MemoryView),
							MemoryIndex: yield* readView(MemoryIndex),
						}
					})

					const stepChecks: Array<{
						readonly step: string
						readonly invariants: Record<string, boolean>
					}> = []
					const recordStep = (step: string) =>
						snapshotWorld.pipe(
							Effect.map((world) => {
								stepChecks.push({ step, invariants: evaluateCheckfuInvariants(world) })
								return world
							}),
						)

					yield* recordStep("initial")
					yield* createAgent.send(
						new CreateAgent({
							mcp_servers: NO_MCP_SERVERS,
							tools: NO_AGENT_TOOLS,
							agent_id: agentRef.id,
							version_id: v1Id,
							name: "Post-Admission Agent v1",
							model: { id: "gpt-4o-mini" },
							system: "Initial system prompt",
							description: "Initial description",
						}),
					)
					yield* environments.send(
						new CreateEnvironment({
							environment_id: envRef.id,
							name: "Post-Admission Env",
							description: "Cloud sandbox",
							config: { type: "cloud", networking: { type: "unrestricted" } },
						}),
					)
					yield* admitSession.send(
						new AdmitSession({
							session_id: sessionV1Ref.id,
							agent_id: BoundedAgentId.make(agentRef.id),
							agent_version: 1,
							environment_id: BoundedEnvironmentId.make(envRef.id),
							title: "Pinned v1",
							mcp_server_credentials: "[]",
							resources: [REPOSITORY],
						}),
					)
					yield* recordStep("admitted-v1")

					yield* updateAgent.send(
						new UpdateAgent({
							agent_id: agentRef.id,
							expected_version: 1,
							next_version_id: v2Id,
							changes: {
								name: "Post-Admission Agent v2",
								model: { id: "gpt-5.4" },
								system: null,
								description: null,
							},
						}),
					)
					yield* recordStep("updated-agent-to-v2-after-admission")
					yield* updateAgent.send(
						new UpdateAgent({
							agent_id: agentRef.id,
							expected_version: 2,
							next_version_id: vNoopId,
							changes: {
								name: "Post-Admission Agent v2",
								model: { id: "gpt-5.4" },
								system: null,
								description: null,
							},
						}),
					)
					yield* recordStep("noop-update-agent-at-v2")

					yield* admitSession.send(
						new AdmitSession({
							session_id: sessionV2Ref.id,
							agent_id: BoundedAgentId.make(agentRef.id),
							agent_version: null,
							environment_id: BoundedEnvironmentId.make(envRef.id),
							title: "Head v2",
							mcp_server_credentials: "[]",
						}),
					)
					yield* recordStep("admitted-v2-alongside-v1")
					yield* sessions.send(
						new SendUserMessage({ session_id: sessionV1Ref.id, text: "Run on v1" }),
					)
					const queuedSendReceipt = yield* sessions.send(
						new SendUserMessage({ session_id: sessionV1Ref.id, text: "Queued follow-up on v1" }),
					)
					const completedTurnWorld = yield* recordStep("completed-two-turns-on-v1-while-head-is-v2")

					yield* admitAutomation.send(
						new AdmitAutomation({
							automation_id: automationRef.id,
							capacity_id: AUTOMATION_CAPACITY,
							name: "Post-Admission Automation",
							description: null,
							agent_id: BoundedAgentId.make(agentRef.id),
							agent_version: null,
							environment_id: BoundedEnvironmentId.make(envRef.id),
							text: "Run the automation",
							schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
						}),
					)
					yield* automations.send(new RunAutomation({ automation_id: automationRef.id }))
					const automationWorld = yield* recordStep("automation-admitted-and-run")
					yield* updateAutomation.send(
						new UpdateAutomation({
							automation_id: automationRef.id,
							expected_revision: 1,
							content_changed: true,
							name: "Updated Automation",
							description: "Moved to noon.",
							agent_id: BoundedAgentId.make(agentRef.id),
							agent_version: 1,
							environment_id: BoundedEnvironmentId.make(envRef.id),
							text: "Run the updated automation",
							schedule: { type: "cron", expression: "0 12 * * *", timezone: "UTC" },
						}),
					)
					const updatedAutomationWorld = yield* recordStep("automation-updated")

					const artifactId = ArtifactId.make("art_post_admission")
					yield* artifacts.send(new ReserveArtifact({ artifact_id: artifactId }))
					yield* artifacts.send(
						new CreateArtifact({
							artifact_id: artifactId,
							name: "Report",
							manifest: "m1",
							file_count: 1,
							total_bytes: 1,
							capabilities: "",
							made_from: "",
							request: "",
							reservation: 1,
						}),
					)
					yield* artifacts.send(
						new AddArtifactVersion({
							artifact_id: artifactId,
							expected_version: 1,
							manifest: "m2",
							file_count: 1,
							total_bytes: 2,
							capabilities: "",
							made_from: "",
							request: "",
						}),
					)
					const artifactWorld = yield* recordStep("artifact-created-and-versioned")
					yield* automations.send(new ArchiveAutomation({ automation_id: automationRef.id }))
					const archivedAutomationWorld = yield* recordStep("automation-archived")

					yield* agents.send(new ArchiveAgent({ agent_id: agentRef.id }))
					yield* recordStep("archived-agent-after-admission")
					yield* environments.send(new ArchiveEnvironment({ environment_id: envRef.id }))
					const archivedEnvWorld = yield* recordStep("archived-env-after-admission")
					yield* environments.send(new DeleteEnvironment({ environment_id: envRef.id }))
					yield* recordStep("deleted-env-after-admission")
					yield* sessions.send(new ArchiveSession({ session_id: sessionV1Ref.id }))
					const finalWorld = yield* recordStep("archived-session-after-env-deletion")

					return {
						stepChecks,
						queuedSendEventTags: queuedSendReceipt.events.map((event) => event._tag),
						completedTurnWorld,
						automationWorld,
						updatedAutomationWorld,
						artifactWorld,
						archivedAutomationWorld,
						archivedEnvWorld,
						finalWorld,
						failures: platform.control.failures,
						deaths: platform.control.deaths,
					}
				}).pipe(Effect.provide(layer)),
			),
		)

		expect(results.failures).toEqual([])
		expect(results.deaths).toEqual([])
		expect(results.stepChecks.length).toBe(14)
		for (const check of results.stepChecks) {
			expect(check.invariants, `invariants failed at step '${check.step}'`).toEqual({
				EverySessionReferencesExistingAgentVersion: true,
				EverySessionReferencesKnownEnvironment: true,
				HostedViewsMatchAggregates: true,
				EnvironmentViewConfigMatchesEnvironment: true,
				AutomationViewsMatchAutomations: true,
				EveryArtifactVersionIsWithinItsArtifactsHead: true,
				AutomationViewRevisionMatchesAutomation: true,
				EveryArtifactVersionIsRecorded: true,
				ReservedSlotsEqualLiveAutomations: true,
				AStoreCountsItsPresentMemories: true,
				MemoryViewsMatchMemories: true,
				TheIndexListsEachStoresPresentMemories: true,
				MemoryStoreViewsMatchStores: true,
			})
		}

		expect(results.queuedSendEventTags).toEqual(["user.message"])
		const completedSessionV1 = results.completedTurnWorld.Session.find(
			(row) => row.id === "sess_post_v1",
		)
		expect(completedSessionV1?.state).toEqual({ _tag: "Idle", turn: 2 })
		expect(
			completedSessionV1?.events.filter((event) => event._tag === "session.status_running").length,
		).toBe(2)
		const completedSessionV1View = results.completedTurnWorld.SessionView.find(
			(row) => row.id === "sess_post_v1",
		)
		const completedSessionV1Input = results.completedTurnWorld.TurnInput.find(
			(row) => row.id === "sess_post_v1",
		)
		expect(completedSessionV1View?.state.status).toBe("idle")
		expect(completedSessionV1View?.state.turn).toBe(2)
		expect(completedSessionV1Input?.state.turn).toBe(2)
		expect(completedSessionV1Input?.state.input).toEqual([])
		expect(completedSessionV1Input?.state.unsent).toEqual([])

		const automationWorld = results.automationWorld
		expect(
			automationWorld.Automation.map(({ id, state }) => [
				id,
				{
					status: state.status,
					runs: state.runs,
					reported: state.reported,
					last_scheduled_at: state.last_scheduled_at,
					activation: state.activation,
					revision: state.revision,
				},
			]),
		).toEqual([
			[
				automationRef.id,
				{
					status: "active",
					runs: 1,
					reported: 1,
					last_scheduled_at: 0,
					activation: 0,
					revision: 1,
				},
			],
		])
		expect(automationWorld.AutomationCapacity.map((row) => row.state)).toEqual([{ reserved: 1 }])
		expect(automationWorld.AutomationView.map((row) => [row.state.status, row.state.runs])).toEqual(
			[["active", 1]],
		)
		expect(automationWorld.AutomationRunView.map((row) => row.state)).toEqual([{ recorded: 1 }])
		const updatedWorld = results.updatedAutomationWorld
		expect(
			updatedWorld.Automation.map((row) => [row.state.activation, row.state.revision]),
		).toEqual([[1, 2]])
		expect(
			updatedWorld.AutomationView.map((row) => [
				row.state.name,
				row.state.agent_version,
				row.state.activation,
				row.state.schedule.expression,
			]),
		).toEqual([["Updated Automation", 1, 1, "0 12 * * *"]])
		expect(
			evaluateCheckfuInvariants({
				...updatedWorld,
				AutomationView: updatedWorld.AutomationView.map((row) => ({
					...row,
					state: { ...row.state, activation: 0 },
				})),
			}).AutomationViewsMatchAutomations,
		).toBe(false)
		expect(
			evaluateCheckfuInvariants({
				...updatedWorld,
				AutomationView: updatedWorld.AutomationView.map((row) => ({
					...row,
					state: { ...row.state, revision: 99 },
				})),
			}).AutomationViewRevisionMatchesAutomation,
		).toBe(false)
		const artifactWorld = results.artifactWorld
		expect(artifactWorld.Artifact.map((row) => row.state.version)).toEqual([2])
		expect(artifactWorld.ArtifactVersionView.length).toBe(2)
		expect(
			evaluateCheckfuInvariants({
				...artifactWorld,
				ArtifactVersionView: artifactWorld.ArtifactVersionView.filter(
					(row) => row.state.version === 1,
				),
			}).EveryArtifactVersionIsRecorded,
		).toBe(false)
		expect(
			evaluateCheckfuInvariants({
				...automationWorld,
				AutomationCapacity: automationWorld.AutomationCapacity.map((row) => ({
					...row,
					state: { reserved: 0 },
				})),
			}).ReservedSlotsEqualLiveAutomations,
		).toBe(false)
		expect(
			evaluateCheckfuInvariants({ ...automationWorld, AutomationCapacity: [] })
				.ReservedSlotsEqualLiveAutomations,
		).toBe(false)
		const runSession = automationWorld.Session.find(
			(row) => row.id === `sess_${automationRef.id}_1`,
		)
		expect(runSession?.state).toEqual({ _tag: "Idle", turn: 1 })
		expect(runSession?.events.map((event) => event._tag).slice(0, 3)).toEqual([
			"session.created",
			"user.message",
			"session.status_running",
		])
		expect(
			evaluateCheckfuInvariants({
				...automationWorld,
				AutomationView: automationWorld.AutomationView.map((row) => ({
					...row,
					state: { ...row.state, status: "paused" },
				})),
			}).AutomationViewsMatchAutomations,
		).toBe(false)
		expect(
			evaluateCheckfuInvariants({
				...automationWorld,
				AutomationRunView: automationWorld.AutomationRunView.map((row) => ({
					...row,
					state: { recorded: 0 },
				})),
			}).AutomationViewsMatchAutomations,
		).toBe(false)

		expect(
			results.archivedAutomationWorld.Automation.map(({ id, state }) => [id, state.status]),
		).toEqual([[automationRef.id, "archived"]])
		expect(results.archivedAutomationWorld.AutomationCapacity.map((row) => row.state)).toEqual([
			{ reserved: 0 },
		])
		expect(results.archivedEnvWorld.Environment[0]?.state.status).toBe("archived")
		expect(results.archivedEnvWorld.EnvironmentView[0]?.state.archived_at).not.toBeNull()

		expect(results.finalWorld.Agent[0]?.state.status).toBe("archived")
		expect(results.finalWorld.Agent[0]?.state.version).toBe(2)
		expect(results.finalWorld.AgentView.map((row) => row.id)).toEqual(["agent_post_1"])
		expect(results.finalWorld.AgentVersionByNumberView.map((row) => row.state.id)).toEqual([
			"aver_post_1",
			"aver_post_2",
		])
		expect(results.finalWorld.AgentVersionByNumberView.map((row) => row.id)).toEqual([
			agentVersionLookupKey(AgentId.make("agent_post_1"), 1),
			agentVersionLookupKey(AgentId.make("agent_post_1"), 2),
		])
		expect(results.finalWorld.Environment[0]?.state.status).toBe("deleted")
		expect(results.finalWorld.EnvironmentView).toEqual([])
		const finalSessionV1 = results.finalWorld.Session.find((row) => row.id === "sess_post_v1")
		const finalSessionV1View = results.finalWorld.SessionView.find(
			(row) => row.id === "sess_post_v1",
		)
		expect(finalSessionV1?.state).toEqual({ _tag: "Terminated", archived: true })
		expect(finalSessionV1View?.state.status).toBe("terminated")
		expect(finalSessionV1View?.state.archived_at).not.toBeNull()
		expect(results.finalWorld.SessionView.map((row) => [row.id, row.state.agent_version])).toEqual([
			["sess_post_v1", 1],
			["sess_post_v2", 2],
			[`sess_${automationRef.id}_1`, 2],
		])
		expect(results.finalWorld.TurnInput.map((row) => [row.id, row.state.turn])).toEqual([
			["sess_post_v1", 2],
			["sess_post_v2", 0],
			[`sess_${automationRef.id}_1`, 1],
		])

		expect(
			evaluateCheckfuInvariants({
				...results.finalWorld,
				SessionView: results.finalWorld.SessionView.map((row) =>
					row.id === "sess_post_v1" ? { ...row, state: { ...row.state, agent_version: 2 } } : row,
				),
				TurnInput: results.finalWorld.TurnInput.map((row) =>
					row.id === "sess_post_v1" ? { ...row, state: { ...row.state, agent_version: 2 } } : row,
				),
			}),
		).toEqual({
			EverySessionReferencesExistingAgentVersion: true,
			EverySessionReferencesKnownEnvironment: true,
			HostedViewsMatchAggregates: false,
			EnvironmentViewConfigMatchesEnvironment: true,
			AutomationViewsMatchAutomations: true,
			EveryArtifactVersionIsWithinItsArtifactsHead: true,
			AutomationViewRevisionMatchesAutomation: true,
			EveryArtifactVersionIsRecorded: true,
			ReservedSlotsEqualLiveAutomations: true,
			AStoreCountsItsPresentMemories: true,
			MemoryViewsMatchMemories: true,
			TheIndexListsEachStoresPresentMemories: true,
			MemoryStoreViewsMatchStores: true,
		})
		expect(
			evaluateCheckfuInvariants({
				...results.finalWorld,
				AgentVersionByNumberView: results.finalWorld.AgentVersionByNumberView.filter(
					(row) => row.state.version !== 1,
				),
			}),
		).toEqual({
			EverySessionReferencesExistingAgentVersion: false,
			EverySessionReferencesKnownEnvironment: true,
			HostedViewsMatchAggregates: false,
			EnvironmentViewConfigMatchesEnvironment: true,
			AutomationViewsMatchAutomations: true,
			EveryArtifactVersionIsWithinItsArtifactsHead: true,
			AutomationViewRevisionMatchesAutomation: true,
			EveryArtifactVersionIsRecorded: true,
			ReservedSlotsEqualLiveAutomations: true,
			AStoreCountsItsPresentMemories: true,
			MemoryViewsMatchMemories: true,
			TheIndexListsEachStoresPresentMemories: true,
			MemoryStoreViewsMatchStores: true,
		})

		const untampered = evaluateCheckfuInvariants(results.finalWorld)
		expect(Object.values(untampered).every(Boolean)).toBe(true)
		for (const tamper of [
			{ system: "Tampered system prompt" },
			{ model: { id: "tampered-model" } },
			{ id: AgentVersionId.make("aver_tampered") },
		]) {
			expect(
				evaluateCheckfuInvariants({
					...results.finalWorld,
					AgentVersionByNumberView: results.finalWorld.AgentVersionByNumberView.map((row) =>
						row.state.version === 1 ? { ...row, state: { ...row.state, ...tamper } } : row,
					),
				}),
				JSON.stringify(tamper),
			).toEqual({ ...untampered, HostedViewsMatchAggregates: false })
		}
		const v2LookupRow = results.finalWorld.AgentVersionByNumberView.find(
			(row) => row.state.version === 2,
		)!
		expect(
			evaluateCheckfuInvariants({
				...results.finalWorld,
				AgentVersionByNumberView: [
					...results.finalWorld.AgentVersionByNumberView,
					{
						id: agentVersionLookupKey(AgentId.make("agent_post_1"), 99),
						state: { ...v2LookupRow.state, version: 99 },
					},
				],
			}),
		).toEqual({
			EverySessionReferencesExistingAgentVersion: true,
			EverySessionReferencesKnownEnvironment: true,
			HostedViewsMatchAggregates: false,
			EnvironmentViewConfigMatchesEnvironment: true,
			AutomationViewsMatchAutomations: true,
			EveryArtifactVersionIsWithinItsArtifactsHead: true,
			AutomationViewRevisionMatchesAutomation: true,
			EveryArtifactVersionIsRecorded: true,
			ReservedSlotsEqualLiveAutomations: true,
			AStoreCountsItsPresentMemories: true,
			MemoryViewsMatchMemories: true,
			TheIndexListsEachStoresPresentMemories: true,
			MemoryStoreViewsMatchStores: true,
		})
		expect(
			evaluateCheckfuInvariants({
				...results.finalWorld,
				Environment: [],
			}),
		).toEqual({
			EverySessionReferencesExistingAgentVersion: true,
			EverySessionReferencesKnownEnvironment: false,
			HostedViewsMatchAggregates: true,
			EnvironmentViewConfigMatchesEnvironment: true,
			AutomationViewsMatchAutomations: true,
			EveryArtifactVersionIsWithinItsArtifactsHead: true,
			AutomationViewRevisionMatchesAutomation: true,
			EveryArtifactVersionIsRecorded: true,
			ReservedSlotsEqualLiveAutomations: true,
			AStoreCountsItsPresentMemories: true,
			MemoryViewsMatchMemories: true,
			TheIndexListsEachStoresPresentMemories: true,
			MemoryStoreViewsMatchStores: true,
		})
		expect(
			evaluateCheckfuInvariants({
				...results.finalWorld,
				SessionView: results.finalWorld.SessionView.map((row) =>
					row.id === "sess_post_v1" ? { ...row, state: { ...row.state, turn: 1 } } : row,
				),
				TurnInput: results.finalWorld.TurnInput.map((row) =>
					row.id === "sess_post_v1" ? { ...row, state: { ...row.state, turn: 1 } } : row,
				),
			}),
		).toEqual({
			EverySessionReferencesExistingAgentVersion: true,
			EverySessionReferencesKnownEnvironment: true,
			HostedViewsMatchAggregates: false,
			EnvironmentViewConfigMatchesEnvironment: true,
			AutomationViewsMatchAutomations: true,
			EveryArtifactVersionIsWithinItsArtifactsHead: true,
			AutomationViewRevisionMatchesAutomation: true,
			EveryArtifactVersionIsRecorded: true,
			ReservedSlotsEqualLiveAutomations: true,
			AStoreCountsItsPresentMemories: true,
			MemoryViewsMatchMemories: true,
			TheIndexListsEachStoresPresentMemories: true,
			MemoryStoreViewsMatchStores: true,
		})

		expect(
			results.finalWorld.SessionView.find((row) => row.id === "sess_post_v1")?.state.resources,
		).toEqual([REPOSITORY])
		expect(
			results.finalWorld.TurnInput.find((row) => row.id === "sess_post_v1")?.state.resources,
		).toEqual([REPOSITORY])
	})
})
