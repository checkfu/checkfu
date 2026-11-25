import * as Domain from "@alchemy.run/domain"
import * as Layer from "effect/Layer"
import { Agent } from "./Agent/Agent.aggregate.ts"
import { AgentVersionByNumberView } from "./Agent/AgentVersionByNumberView.view.ts"
import { AgentView } from "./Agent/AgentView.view.ts"
import { CreateAgentDecision } from "./Agent/CreateAgent.decision.ts"
import { UpdateAgentDecision } from "./Agent/UpdateAgent.decision.ts"
import {
	ArmAutomation,
	ArmAutomationLive,
	EnsureAutomationArmed,
	EnsureAutomationArmedLive,
} from "./Automation/ArmAutomation.policy.ts"
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
	EnsureAutomationRunStarted,
	EnsureAutomationRunStartedLive,
	StartAutomationRun,
	StartAutomationRunLive,
} from "./Automation/StartAutomationRun.policy.ts"
import { Artifact } from "./Artifact/Artifact.aggregate.ts"
import { ArtifactVersionView } from "./Artifact/ArtifactVersionView.view.ts"
import { ArtifactView } from "./Artifact/ArtifactView.view.ts"
import { Environment } from "./Environment/Environment.aggregate.ts"
import { EnvironmentView } from "./Environment/EnvironmentView.view.ts"
import { Listing, ListingLive } from "./Listing/Listing.projection.ts"
import { ListResources, ListResourcesLive } from "./Listing/ListResources.query.ts"
import { AdmitSessionDecision } from "./Session/AdmitSession.decision.ts"
import { RunTurn, RunTurnLive } from "./Session/RunTurn.saga.ts"
import { Session } from "./Session/Session.aggregate.ts"
import { SessionView } from "./Session/SessionView.view.ts"
import { EnsureTurnStarted, EnsureTurnStartedLive } from "./Session/EnsureTurnStarted.policy.ts"
import { EnsureTurnStopped, EnsureTurnStoppedLive } from "./Session/EnsureTurnStopped.policy.ts"
import { StartTurn, StartTurnLive } from "./Session/StartTurn.policy.ts"
import { TurnInput } from "./Session/TurnInput.view.ts"

export class Checkfu extends Domain.Model("Checkfu", {
	aggregates: [Agent, Environment, Session, Automation, AutomationCapacity, Artifact],
	decisions: [
		CreateAgentDecision,
		UpdateAgentDecision,
		AdmitSessionDecision,
		AdmitAutomationDecision,
		OpenAutomationSessionDecision,
		UpdateAutomationDecision,
	],
	views: [
		AgentView,
		AgentVersionByNumberView,
		EnvironmentView,
		SessionView,
		TurnInput,
		AutomationView,
		AutomationRunView,
		ArtifactView,
		ArtifactVersionView,
	],
	policies: [
		StartTurn,
		EnsureTurnStarted,
		EnsureTurnStopped,
		ArmAutomation,
		EnsureAutomationArmed,
		StartAutomationRun,
		EnsureAutomationRunStarted,
		FreeAutomationSlot,
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
							view.state.status === "running",
							view.state.turn === s.state.turn,
							!view.state.archived_at,
							input.state.turn === s.state.turn,
							input.state.input.length >= 1,
							input.state.unsent.length === s.state.pending_user_messages,
						].every((ok) => ok)
					}
					const startedTurns = s.events.filter(
						(event) => event._tag === "session.status_running",
					).length
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
		ArtifactViewMatchesArtifact: (m) =>
			[
				m.Artifact.every((a) => {
					const view = m.ArtifactView.find((v) => v.id === a.id)
					if (a.state.status === "" || a.state.status === "deleted") {
						return view === undefined
					}
					if (view === undefined) {
						return false
					}
					return [
						view.state.id === a.id,
						view.state.version === a.state.version,
						view.state.name === a.state.name,
						view.state.manifest === a.state.manifest,
					].every((ok) => ok)
				}),
				m.ArtifactView.every((v) =>
					m.Artifact.some((a) => [a.id === v.id, a.state.status === "active"].every((ok) => ok)),
				),
			].every((ok) => ok),
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
	},
	sometimes: {
		ASessionIsAdmitted: (m) => m.Session.some((s) => s.state._tag === "Idle"),
		AnAdmittedSessionCompletesATurn: (m) =>
			m.Session.some((s) => s.state._tag === "Idle" && s.state.turn >= 1),
	},
	eventually: {
		EveryTurnSettles: (m) => m.Session.every((s) => s.state._tag !== "Running"),
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
		"SendUserInterrupt",
		"ArchiveSession",
		"ClaimIdempotencyKey",
		"AdmitAutomation",
		"PauseAutomation",
		"UnpauseAutomation",
		"ArchiveAutomation",
		"RunAutomation",
		"CreateArtifact",
		"AddArtifactVersion",
		"DeleteArtifact",
		"FenceArtifactWrites",
		"PublishArtifact",
		"UnpublishArtifact",
		"ClaimArtifactIdempotencyKey",
	],
	views: [
		"AgentView",
		"AgentVersionByNumberView",
		"EnvironmentView",
		"SessionView",
		"AutomationView",
		"AutomationRunView",
		"ArtifactView",
		"ArtifactVersionView",
	],
	queries: ["ListResources"],
}) {}

export const CheckfuHandlersLive = Layer.mergeAll(
	StartTurnLive,
	EnsureTurnStartedLive,
	EnsureTurnStoppedLive,
	RunTurnLive,
	ArmAutomationLive,
	EnsureAutomationArmedLive,
	StartAutomationRunLive,
	EnsureAutomationRunStartedLive,
	FreeAutomationSlotLive,
	ListingLive,
	ListResourcesLive,
)
