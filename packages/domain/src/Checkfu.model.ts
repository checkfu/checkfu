import { SendSystemMessageDecision } from "./Session/SendSystemMessage.decision.ts"
import { SystemContext } from "./Session/SystemContext.aggregate.ts"
import * as Domain from "@alchemy.run/domain"
import * as Layer from "effect/Layer"
import { Agent } from "./Agent/Agent.aggregate.ts"
import { AgentVersionByNumberView } from "./Agent/AgentVersionByNumberView.view.ts"
import { AgentView } from "./Agent/AgentView.view.ts"
import { CreateAgentDecision } from "./Agent/CreateAgent.decision.ts"
import { UpdateAgentDecision } from "./Agent/UpdateAgent.decision.ts"
import { ArmAutomation, ArmAutomationLive } from "./Automation/ArmAutomation.policy.ts"
import { Automation } from "./Automation/Automation.aggregate.ts"
import { AutomationCapacity } from "./Automation/AutomationCapacity.aggregate.ts"
import { AdmitAutomationDecision } from "./Automation/AdmitAutomation.decision.ts"
import { UpdateAutomationDecision } from "./Automation/UpdateAutomation.decision.ts"
import { OpenAutomationSessionDecision } from "./Automation/OpenAutomationSession.decision.ts"
import {
	FreeAutomationSlot,
	FreeAutomationSlotLive,
} from "./Automation/FreeAutomationSlot.policy.ts"
import { AutomationRunView } from "./Automation/AutomationRunView.view.ts"
import { AutomationView } from "./Automation/AutomationView.view.ts"
import {
	StartAutomationRun,
	StartAutomationRunLive,
} from "./Automation/StartAutomationRun.policy.ts"
import { Artifact } from "./Artifact/Artifact.aggregate.ts"
import { ArtifactVersionView } from "./Artifact/ArtifactVersionView.view.ts"
import {
	ExpireArtifactReservations,
	ExpireArtifactReservationsLive,
} from "./Artifact/ExpireArtifactReservations.policy.ts"
import {
	ReleaseArtifactBytes,
	ReleaseArtifactBytesLive,
} from "./Artifact/ReleaseArtifactBytes.policy.ts"
import { Environment } from "./Environment/Environment.aggregate.ts"
import { EnvironmentView } from "./Environment/EnvironmentView.view.ts"
import { Listing, ListingLive } from "./Listing/Listing.projection.ts"
import { ListResources, ListResourcesLive } from "./Listing/ListResources.query.ts"
import { DeleteMemoryDecision } from "./Memory/DeleteMemory.decision.ts"
import { Memory } from "./Memory/Memory.aggregate.ts"
import { MemoryIndex } from "./Memory/MemoryIndex.view.ts"
import { MemoryStore } from "./Memory/MemoryStore.aggregate.ts"
import { MemoryStoreView } from "./Memory/MemoryStoreView.view.ts"
import { MemoryView } from "./Memory/MemoryView.view.ts"
import { WriteMemoryDecision } from "./Memory/WriteMemory.decision.ts"
import {
	RecordInitialMessages,
	RecordInitialMessagesLive,
} from "./Session/RecordInitialMessages.policy.ts"
import { AdmitSessionWithMessagesDecision } from "./Session/AdmitSessionWithMessages.decision.ts"
import { AdmitSessionDecision } from "./Session/AdmitSession.decision.ts"
import {
	PublishSessionOutputs,
	PublishSessionOutputsLive,
} from "./Session/PublishSessionOutputs.policy.ts"
import { ConfirmToolDecision } from "./Session/ConfirmTool.decision.ts"
import { RequestToolActionDecision } from "./Session/RequestToolAction.decision.ts"
import { ReturnCustomToolResultDecision } from "./Session/ReturnCustomToolResult.decision.ts"
import { RunTurn, RunTurnLive } from "./Session/RunTurn.saga.ts"
import { Session } from "./Session/Session.aggregate.ts"
import { SessionTurnCompletion } from "./Session/SessionTurnCompletion.view.ts"
import { SessionView } from "./Session/SessionView.view.ts"
import { EnsureTurnStarted, EnsureTurnStartedLive } from "./Session/EnsureTurnStarted.policy.ts"
import { EnsureTurnStopped, EnsureTurnStoppedLive } from "./Session/EnsureTurnStopped.policy.ts"
import { StartTurn, StartTurnLive } from "./Session/StartTurn.policy.ts"
import { ToolConfirmation } from "./Session/ToolConfirmation.aggregate.ts"
import { TurnInput } from "./Session/TurnInput.view.ts"

export class Checkfu extends Domain.Model("Checkfu", {
	aggregates: [
		Agent,
		Environment,
		Session,
		SystemContext,
		ToolConfirmation,
		Automation,
		AutomationCapacity,
		Artifact,
		MemoryStore,
		Memory,
	],
	decisions: [
		CreateAgentDecision,
		UpdateAgentDecision,
		AdmitSessionDecision,
		AdmitSessionWithMessagesDecision,
		AdmitAutomationDecision,
		OpenAutomationSessionDecision,
		UpdateAutomationDecision,
		RequestToolActionDecision,
		SendSystemMessageDecision,
		ConfirmToolDecision,
		ReturnCustomToolResultDecision,
		WriteMemoryDecision,
		DeleteMemoryDecision,
	],
	views: [
		AgentView,
		AgentVersionByNumberView,
		EnvironmentView,
		SessionView,
		SessionTurnCompletion,
		TurnInput,
		AutomationView,
		AutomationRunView,
		ArtifactVersionView,
		MemoryStoreView,
		MemoryView,
		MemoryIndex,
	],
	policies: [
		RecordInitialMessages,
		StartTurn,
		EnsureTurnStarted,
		EnsureTurnStopped,
		ArmAutomation,
		StartAutomationRun,
		FreeAutomationSlot,
		PublishSessionOutputs,
		ExpireArtifactReservations,
		ReleaseArtifactBytes,
	],
	sagas: [RunTurn],
	projections: [Listing],
	queries: [ListResources],
	invariants: {
		EverySessionReferencesExistingAgentVersion: (m) =>
			m.SessionView.every((sv) =>
				[
					m.Agent.some((a) =>
						[
							a.id === sv.state.agent_id,
							a.state.status !== "",
							sv.state.agent_version <= a.state.version,
						].every((ok) => ok),
					),
					m.AgentVersionByNumberView.some((av) =>
						[
							av.id === `${sv.state.agent_id}@${sv.state.agent_version}`,
							av.state.agent_id === sv.state.agent_id,
							av.state.version === sv.state.agent_version,
						].every((ok) => ok),
					),
				].every((ok) => ok),
			),
		EverySessionReferencesKnownEnvironment: (m) =>
			m.SessionView.every((sv) =>
				m.Environment.some((e) =>
					[e.id === sv.state.environment_id, e.state.status !== ""].every((ok) => ok),
				),
			),
		HostedViewsMatchAggregates: (m) =>
			[
				m.Agent.every((a) => {
					const view = m.AgentView.find((v) => v.id === a.id)
					if (a.state.status === "") {
						return view === undefined
					}
					if (view === undefined) {
						return false
					}
					return [
						view.state.id === a.id,
						view.state.version === a.state.version,
						view.state.current_version_id === a.state.current_version_id,
						view.state.name === a.state.name,
						view.state.model.id === a.state.model_id,
						(view.state.system !== null) === a.state.has_system,
						(view.state.system ?? "") === a.state.system,
						(view.state.description !== null) === a.state.has_description,
						(view.state.description ?? "") === a.state.description,
						!!view.state.archived_at === (a.state.status === "archived"),
					].every((ok) => ok)
				}),
				m.AgentView.every((v) =>
					m.Agent.some((a) => [a.id === v.id, a.state.status !== ""].every((ok) => ok)),
				),
				m.Agent.every((a) => {
					if (a.state.status === "") {
						return true
					}

					if (
						m.AgentVersionByNumberView.filter((v) => v.state.agent_id === a.id).length !==
						a.state.version
					) {
						return false
					}
					const head = m.AgentVersionByNumberView.find((v) => v.id === `${a.id}@${a.state.version}`)
					if (head === undefined) {
						return false
					}
					return [
						head.state.agent_id === a.id,
						head.state.id === a.state.current_version_id,
						head.state.version === a.state.version,
						head.state.name === a.state.name,
						head.state.model.id === a.state.model_id,
						(head.state.system !== null) === a.state.has_system,
						(head.state.system ?? "") === a.state.system,
						(head.state.description !== null) === a.state.has_description,
						(head.state.description ?? "") === a.state.description,
					].every((ok) => ok)
				}),
				m.AgentVersionByNumberView.every((v) =>
					m.Agent.some((a) => {
						const source = a.events
							.filter((event) => event._tag === "agent.created" || event._tag === "agent.updated")
							.find((event) => event.version === v.state.version)
						if (source === undefined) {
							return false
						}
						return [
							a.id === v.state.agent_id,
							a.state.status !== "",
							v.state.version <= a.state.version,
							v.id === `${a.id}@${v.state.version}`,
							source.version_id === v.state.id,
							source.name === v.state.name,
							source.model.id === v.state.model.id,
							source.system === v.state.system,
							source.description === v.state.description,
						].every((ok) => ok)
					}),
				),
				m.Environment.every((e) => {
					const view = m.EnvironmentView.find((v) => v.id === e.id)
					if (e.state.status === "" || e.state.status === "deleted") {
						return view === undefined
					}
					if (view === undefined) {
						return false
					}
					return [
						view.state.id === e.id,
						view.state.version === e.state.version,
						view.state.name === e.state.name,
						!!view.state.archived_at === (e.state.status === "archived"),
					].every((ok) => ok)
				}),
				m.EnvironmentView.every((v) =>
					m.Environment.some((e) =>
						[e.id === v.id, e.state.status !== "", e.state.status !== "deleted"].every((ok) => ok),
					),
				),
				m.Session.every((s) => {
					const view = m.SessionView.find((v) => v.id === s.id)
					const input = m.TurnInput.find((v) => v.id === s.id)
					if (s.state._tag === "Uninitialized") {
						return view === undefined && input === undefined
					}
					const created = s.events.find((event) => event._tag === "session.created")
					if (view === undefined || input === undefined || created === undefined) {
						return false
					}
					const identity = [
						view.state.id === s.id,
						view.state.agent_id === created.agent_id,
						view.state.agent_version === created.agent_version,
						view.state.environment_id === created.environment_id,
						input.state.agent_id === created.agent_id,
						input.state.agent_version === created.agent_version,
						input.state.environment_id === created.environment_id,
						input.state.turn === view.state.turn,
					]
					if (s.state._tag === "Idle") {
						return [
							...identity,
							view.state.status === "idle",
							view.state.turn === s.state.turn,
							!view.state.archived_at,
							input.state.turn === s.state.turn,
							input.state.input.length === 0,
							input.state.unsent.length <= 8,
						].every((ok) => ok)
					}
					if (s.state._tag === "Running") {
						return [
							...identity,
							view.state.status === (s.state.paused ? "idle" : "running"),
							view.state.turn === s.state.turn,
							!view.state.archived_at,
							input.state.turn === s.state.turn,
							input.state.input.length >= 1,
							input.state.unsent.length === s.state.pending_user_messages,
						].every((ok) => ok)
					}
					const startedTurns = s.events.reduce(
						(highest, event) =>
							event._tag === "session.status_running" && event.turn > highest
								? event.turn
								: highest,
						0,
					)
					return [
						...identity,
						view.state.status === "terminated",
						view.state.turn === startedTurns,
						input.state.turn === startedTurns,
						!!view.state.archived_at === s.state.archived,
						input.state.input.length === 0,
						input.state.unsent.length === 0,
					].every((ok) => ok)
				}),
				m.SessionView.every((v) =>
					m.Session.some((s) =>
						[s.id === v.id, s.state._tag !== "Uninitialized"].every((ok) => ok),
					),
				),
				m.TurnInput.every((v) =>
					m.Session.some((s) =>
						[s.id === v.id, s.state._tag !== "Uninitialized"].every((ok) => ok),
					),
				),
			].every((ok) => ok),
		EnvironmentViewConfigMatchesEnvironment: (m) =>
			m.Environment.every((e) => {
				const view = m.EnvironmentView.find((v) => v.id === e.id)
				if (view === undefined) {
					return true
				}
				if (e.state.config === null) {
					return false
				}
				const projected = view.state.config.networking
				const committed = e.state.config.networking
				return [
					view.state.description === e.state.description,
					projected.type === committed.type,
					projected.type !== "limited" ||
						committed.type !== "limited" ||
						(projected.allow_mcp_servers === committed.allow_mcp_servers &&
							projected.allow_package_managers === committed.allow_package_managers &&
							projected.allowed_hosts.length === committed.allowed_hosts.length &&
							projected.allowed_hosts.every(
								(host, index) => host === committed.allowed_hosts[index],
							)),
				].every((ok) => ok)
			}),
		AutomationViewsMatchAutomations: (m) =>
			[
				m.Automation.every((a) => {
					const view = m.AutomationView.find((v) => v.id === a.id)
					const runs = m.AutomationRunView.find((v) => v.id === a.id)
					if (a.state.status === "") {
						return view === undefined
					}
					if (view === undefined) {
						return false
					}
					return [
						view.state.id === a.id,
						view.state.status === a.state.status,
						view.state.runs === a.state.runs,
						view.state.activation === a.state.activation,
						(view.state.pause_reason !== null) === (a.state.status === "paused"),
						!!view.state.archived_at === (a.state.status === "archived"),
						(runs === undefined ? 0 : runs.state.recorded) === a.state.reported,
					].every((ok) => ok)
				}),
				m.AutomationView.every((v) =>
					m.Automation.some((a) => [a.id === v.id, a.state.status !== ""].every((ok) => ok)),
				),
			].every((ok) => ok),
		AutomationViewRevisionMatchesAutomation: (m) =>
			m.Automation.every((a) => {
				const view = m.AutomationView.find((v) => v.id === a.id)
				return view === undefined || view.state.revision === a.state.revision
			}),
		ReservedSlotsEqualLiveAutomations: (m) => {
			const live = m.Automation.filter((a) =>
				[a.state.status === "active", a.state.status === "paused"].some((ok) => ok),
			).length
			return m.AutomationCapacity.length === 0
				? live === 0
				: m.AutomationCapacity.every((c) => c.state.reserved === live)
		},
		EveryArtifactVersionIsWithinItsArtifactsHead: (m) =>
			m.ArtifactVersionView.every((v) =>
				m.Artifact.some((a) =>
					[
						a.id === v.state.artifact_id,
						v.id === `${a.id}@${v.state.version}`,
						a.state.status !== "",
						v.state.version <= a.state.version,
						v.state.version !== a.state.version || v.state.manifest === a.state.manifest,
					].every((ok) => ok),
				),
			),
		EveryArtifactVersionIsRecorded: (m) =>
			m.Artifact.every(
				(a) =>
					m.ArtifactVersionView.filter((v) => v.state.artifact_id === a.id).length ===
					a.state.version,
			),
		AStoreCountsItsPresentMemories: (m) =>
			m.MemoryStore.every(
				(store) =>
					store.state.status === "" ||
					store.state.status === "deleted" ||
					store.state.memory_count ===
						m.Memory.filter(
							(memory) =>
								memory.state.status === "present" && memory.state.memory_store_id === store.id,
						).length,
			),
		MemoryViewsMatchMemories: (m) =>
			[
				m.Memory.every((memory) => {
					const view = m.MemoryView.find((v) => v.id === memory.id)
					if (memory.state.status !== "present") {
						return view === undefined
					}
					if (view === undefined) {
						return false
					}
					return [
						view.state.memory_store_id === memory.state.memory_store_id,
						view.state.path === memory.state.path,
						view.state.content_sha256 === memory.state.content_sha256,
						view.state.version === memory.state.version,
					].every((ok) => ok)
				}),
				m.MemoryView.every((v) =>
					m.Memory.some((memory) =>
						[memory.id === v.id, memory.state.status === "present"].every((ok) => ok),
					),
				),
			].every((ok) => ok),
		TheIndexListsEachStoresPresentMemories: (m) =>
			[
				m.MemoryIndex.every((index) =>
					index.state.entries.every((entry) =>
						m.Memory.some((memory) =>
							[
								memory.id === entry.id,
								memory.state.status === "present",
								memory.state.memory_store_id === index.id,
								memory.state.path === entry.path,
								memory.state.content_sha256 === entry.content_sha256,
							].every((ok) => ok),
						),
					),
				),
				m.Memory.every(
					(memory) =>
						memory.state.status !== "present" ||
						m.MemoryIndex.some(
							(index) =>
								index.id === memory.state.memory_store_id &&
								index.state.entries.some((entry) => entry.id === memory.id),
						),
				),
			].every((ok) => ok),
		MemoryStoreViewsMatchStores: (m) =>
			[
				m.MemoryStore.every((store) => {
					const view = m.MemoryStoreView.find((v) => v.id === store.id)
					if (store.state.status === "" || store.state.status === "deleted") {
						return view === undefined
					}
					if (view === undefined) {
						return false
					}
					return [
						view.state.name === store.state.name,
						view.state.description === store.state.description,
						!!view.state.archived_at === (store.state.status === "archived"),
					].every((ok) => ok)
				}),
				m.MemoryStoreView.every((v) =>
					m.MemoryStore.some((store) =>
						[store.id === v.id, store.state.status !== "", store.state.status !== "deleted"].every(
							(ok) => ok,
						),
					),
				),
			].every((ok) => ok),
	},
	relations: {
		APresentMemoryIsInAStoreThatWasCreated: Domain.Relation({
			over: { memory: Memory, store: MemoryStore },
			holds: ({ memory, store }) =>
				[
					memory.state.status !== "present",
					memory.state.memory_store_id !== store.id,
					store.state.status !== "",
				].some((ok) => ok),
		}),
	},
	sometimes: {
		ASessionIsAdmitted: (m) => m.Session.some((s) => s.state._tag === "Idle"),
		AnAdmittedSessionCompletesATurn: (m) =>
			m.Session.some((s) => s.state._tag === "Idle" && s.state.turn >= 1),
	},
	eventually: {
		EveryTurnSettles: (m) => m.Session.every((s) => s.state._tag !== "Running" || s.state.paused),
	},
}) {}

export class CheckfuDomainApi extends Domain.Api("CheckfuDomainApi", {
	model: Checkfu,
	commands: [
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
		"UnpauseAutomation",
		"ArchiveAutomation",
		"RunAutomation",
		"ReserveArtifact",
		"CreateArtifact",
		"OpenArtifact",
		"AddArtifactVersion",
		"DeleteArtifact",
		"PublishArtifact",
		"UnpublishArtifact",
		"ClaimArtifactIdempotencyKey",
		"CreateMemoryStore",
		"UpdateMemoryStore",
		"ArchiveMemoryStore",
		"DeleteMemoryStore",
		"WriteMemory",
		"DeleteMemory",
	],
	views: [
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
	],
	queries: ["ListResources"],
}) {}

export const CheckfuHandlersLive = Layer.mergeAll(
	RecordInitialMessagesLive,
	StartTurnLive,
	EnsureTurnStartedLive,
	EnsureTurnStoppedLive,
	PublishSessionOutputsLive,
	RunTurnLive,
	ArmAutomationLive,
	StartAutomationRunLive,
	FreeAutomationSlotLive,
	ExpireArtifactReservationsLive,
	ReleaseArtifactBytesLive,
	ListingLive,
	ListResourcesLive,
)
