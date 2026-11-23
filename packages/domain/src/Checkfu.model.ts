import * as Domain from "@alchemy.run/domain"
import { Agent } from "./Agent/Agent.aggregate.ts"
import { AgentVersion } from "./Agent/AgentVersion.aggregate.ts"
import { AgentVersionByNumberView } from "./Agent/AgentVersionByNumberView.view.ts"
import { AgentVersionView } from "./Agent/AgentVersionView.view.ts"
import { AgentView } from "./Agent/AgentView.view.ts"
import { CreateAgentDecision } from "./Agent/CreateAgent.decision.ts"
import { UpdateAgentDecision } from "./Agent/UpdateAgent.decision.ts"
import { Environment } from "./Environment/Environment.aggregate.ts"
import { EnvironmentView } from "./Environment/EnvironmentView.view.ts"
import { IdempotencyClaim } from "./IdempotencyClaim/IdempotencyClaim.aggregate.ts"
import { AdmitSessionDecision } from "./Session/AdmitSession.decision.ts"
import { RunTurn } from "./Session/RunTurn.saga.ts"
import { Session } from "./Session/Session.aggregate.ts"
import { SessionView } from "./Session/SessionView.view.ts"
import { StartTurn } from "./Session/StartTurn.policy.ts"
import { StopModelRequest } from "./Session/StopModelRequest.policy.ts"
import { TurnInput } from "./Session/TurnInput.view.ts"

/**
 * Unified hosted domain model.
 * Hosting Agents, Environments, and Sessions in one model allows two-phase
 * cross-aggregate decisions like {@link AdmitSessionDecision} to enforce
 * resource eligibility atomically on Cloudflare Durable Objects.
 */
export class Checkfu extends Domain.Model("Checkfu", {
	aggregates: [Agent, AgentVersion, Environment, Session, IdempotencyClaim],
	decisions: [CreateAgentDecision, UpdateAgentDecision, AdmitSessionDecision],
	views: [
		AgentView,
		AgentVersionView,
		AgentVersionByNumberView,
		EnvironmentView,
		SessionView,
		TurnInput,
	],
	policies: [StartTurn, StopModelRequest],
	sagas: [RunTurn],
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
				m.AgentVersion.every((av) => {
					const view = m.AgentVersionView.find((v) => v.id === av.id)
					if (!av.state.minted) {
						return view === undefined
					}
					const byNumber = m.AgentVersionByNumberView.find(
						(v) => v.id === `${av.state.agent_id}@${av.state.version}`,
					)
					if (view === undefined || byNumber === undefined) {
						return false
					}
					return [
						view.state.id === av.id,
						view.state.agent_id === av.state.agent_id,
						view.state.version === av.state.version,
						view.state.name === av.state.name,
						view.state.model.id === av.state.model_id,
						(view.state.system !== null) === av.state.has_system,
						(view.state.system ?? "") === av.state.system,
						(view.state.description !== null) === av.state.has_description,
						(view.state.description ?? "") === av.state.description,
						byNumber.state.id === av.id,
						byNumber.state.agent_id === av.state.agent_id,
						byNumber.state.version === av.state.version,
						byNumber.state.name === av.state.name,
						byNumber.state.model.id === av.state.model_id,
						(byNumber.state.system !== null) === av.state.has_system,
						(byNumber.state.system ?? "") === av.state.system,
						(byNumber.state.description !== null) === av.state.has_description,
						(byNumber.state.description ?? "") === av.state.description,
					].every((ok) => ok)
				}),
				m.AgentVersionView.every((v) =>
					m.AgentVersion.some((av) => [av.id === v.id, av.state.minted].every((ok) => ok)),
				),
				m.AgentVersionByNumberView.every((v) =>
					m.AgentVersion.some((av) =>
						[
							av.state.minted,
							av.id === v.state.id,
							v.id === `${av.state.agent_id}@${av.state.version}`,
						].every((ok) => ok),
					),
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
		TurnInputGenerationMatchesSession: (m) =>
			m.Session.every((s) => {
				const view = m.TurnInput.find((v) => v.id === s.id)
				if (s.state._tag !== "Idle" && s.state._tag !== "Running") {
					return true
				}
				if (view === undefined) {
					return false
				}
				return view.state.harness_generation === s.state.generation
			}),
	},
	relations: {
		AMintedVersionBelongsToItsAgent: Domain.Relation({
			over: { version: AgentVersion, agent: Agent },
			holds: ({ version, agent }) =>
				[
					!version.state.minted,
					version.state.agent_id !== agent.id,
					[agent.state.status !== "", version.state.version <= agent.state.version].every(
						(ok) => ok,
					),
				].some((ok) => ok),
		}),
		AnAgentsHeadIsItsLatestVersion: Domain.Relation({
			over: { agent: Agent, version: AgentVersion },
			holds: ({ agent, version }) =>
				[
					agent.state.status === "",
					agent.state.current_version_id !== version.id,
					[
						version.state.minted,
						version.state.agent_id === agent.id,
						version.state.version === agent.state.version,
						version.state.name === agent.state.name,
						version.state.model_id === agent.state.model_id,
						version.state.has_system === agent.state.has_system,
						version.state.system === agent.state.system,
						version.state.has_description === agent.state.has_description,
						version.state.description === agent.state.description,
					].every((ok) => ok),
				].some((ok) => ok),
		}),
		VersionNumbersAreDistinct: Domain.Relation({
			over: { a: AgentVersion, b: AgentVersion },
			holds: ({ a, b }) =>
				[
					a.id === b.id,
					!a.state.minted,
					!b.state.minted,
					a.state.agent_id !== b.state.agent_id,
					a.state.version !== b.state.version,
				].some((ok) => ok),
		}),
	},
	sometimes: {
		AnIdempotencyKeyIsClaimed: (m) => m.IdempotencyClaim.some((b) => b.state._tag === "Claimed"),
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
	],
	views: [
		"AgentView",
		"AgentVersionView",
		"AgentVersionByNumberView",
		"EnvironmentView",
		"SessionView",
	],
}) {}
