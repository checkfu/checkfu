import * as Domain from "@alchemy.run/domain"
import { Agent } from "@checkfu/agents/Agent/Agent.aggregate"
import { AgentId } from "@checkfu/agents/Agent/Agent.id"
import { AgentArchivedError } from "@checkfu/agents/Agent/AgentArchived.rejection"
import { AgentNotFound } from "@checkfu/agents/Agent/AgentNotFound.rejection"
import { AgentVersion } from "@checkfu/agents/Agent/AgentVersion.aggregate"
import { AgentVersionByNumberView } from "@checkfu/agents/Agent/AgentVersionByNumberView.view"
import { AgentVersionView } from "@checkfu/agents/Agent/AgentVersionView.view"
import { AgentView } from "@checkfu/agents/Agent/AgentView.view"
import { CreateAgentDecision } from "@checkfu/agents/Agent/CreateAgent.decision"
import { UpdateAgentDecision } from "@checkfu/agents/Agent/UpdateAgent.decision"
import { Environment } from "@checkfu/environments/Environment/Environment.aggregate"
import { EnvironmentArchivedError } from "@checkfu/environments/Environment/EnvironmentArchived.rejection"
import { EnvironmentNotFound } from "@checkfu/environments/Environment/EnvironmentNotFound.rejection"
import { EnvironmentView } from "@checkfu/environments/Environment/EnvironmentView.view"
import {
	SessionAlreadyExists,
	SessionCreated,
} from "@checkfu/sessions/Session/CreateSession.command"
import { RunTurn } from "@checkfu/sessions/Session/RunTurn.saga"
import { Session } from "@checkfu/sessions/Session/Session.aggregate"
import { SessionId } from "@checkfu/sessions/Session/Session.id"
import {
	MAX_IDENTIFIER_LENGTH,
	PositiveInt,
	SessionTitle,
} from "@checkfu/sessions/Session/SessionTypes"
import { SessionView } from "@checkfu/sessions/Session/SessionView.view"
import { StartTurn } from "@checkfu/sessions/Session/StartTurn.policy"
import { StopModelRequest } from "@checkfu/sessions/Session/StopModelRequest.policy"
import { TurnInput } from "@checkfu/sessions/Session/TurnInput.view"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"

export const BoundedAgentId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
).pipe(Schema.brand("AgentId"))

export const BoundedEnvironmentId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
).pipe(Schema.brand("EnvironmentId"))

export const EventBatchId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
).pipe(Schema.brand("EventBatchId"))
export type EventBatchId = typeof EventBatchId.Type

export const BatchFingerprint = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))

export const EVENT_BATCH_STATE_SCHEMA_VERSION = 1 as const

export const EventBatchState = Schema.Union([
	Schema.TaggedStruct("Unclaimed", {}),
	Schema.TaggedStruct("Claimed", { fingerprint: BatchFingerprint }),
])
export type EventBatchState = typeof EventBatchState.Type

export const EventBatchStateSnapshot = versionedSnapshot({
	current: EVENT_BATCH_STATE_SCHEMA_VERSION,
	schema: EventBatchState,
})

export class EventBatchClaimed extends Domain.Event("event_batch.claimed", {
	fingerprint: BatchFingerprint,
}) {}

export class IdempotencyKeyConflict extends Domain.Rejection(
	"IdempotencyKeyConflict",
	{ batch_id: EventBatchId },
	{
		httpApiStatus: 409,
		description: "Idempotency-Key was already used for a different request.",
	},
) {}

export class ClaimEventBatch extends Domain.Command("ClaimEventBatch", {
	input: {
		batch_id: EventBatchId,
		fingerprint: BatchFingerprint,
	},
	events: [EventBatchClaimed],
	rejects: [IdempotencyKeyConflict],
}) {}

/**
 * Durably binds a scoped idempotency key to a request fingerprint before write
 * commands run, rejecting mismatched retries with 409 while allowing identical
 * retries to resume.
 */
export class EventBatch extends Domain.Aggregate("EventBatch", {
	id: EventBatchId,
	state: EventBatchStateSnapshot,
	initial: { _tag: "Unclaimed" as const },
	commands: [ClaimEventBatch],
	keyOf: (cmd) => cmd.batch_id,
	transitions: {
		ClaimedBatchNeverReturnsToUnclaimed: ({ before, after }) =>
			before._tag !== "Claimed" || after._tag === "Claimed",
		ClaimedFingerprintNeverChanges: ({ before, after }) =>
			before._tag !== "Claimed" ||
			(after._tag === "Claimed" && after.fingerprint === before.fingerprint),
		// Aggregate transitions are proved over event-producing (Changed) outcomes only;
		// zero-event matching retries and IdempotencyKeyConflict rejections are checked separately.
		ClaimOnlyEmitsFromUnclaimedWithCommandFingerprint: ({ before, after, command, events }) => {
			if (before._tag !== "Unclaimed" || after._tag !== "Claimed") {
				return false
			}
			return [
				after.fingerprint === command.fingerprint,
				events.length === 1,
				events.every((event) => event.fingerprint === command.fingerprint),
			].every((ok) => ok)
		},
	},
	decide: {
		ClaimEventBatch: (state, cmd, ctx) => {
			if (state._tag === "Unclaimed") {
				return [new EventBatchClaimed({ fingerprint: cmd.fingerprint })]
			}
			if (state.fingerprint === cmd.fingerprint) {
				return []
			}
			return new IdempotencyKeyConflict({ batch_id: ctx.id })
		},
	},
	evolve: {
		"event_batch.claimed": (_state, event) => ({
			_tag: "Claimed" as const,
			fingerprint: event.fingerprint,
		}),
	},
}) {}

export class AgentVersionNotFound extends Domain.Rejection(
	"AgentVersionNotFound",
	{
		agent_id: AgentId,
		version: PositiveInt,
	},
	{ httpApiStatus: 404, description: "Agent version not found." },
) {}

export class AdmitSession extends Domain.Command("AdmitSession", {
	input: {
		session_id: SessionId,
		agent_id: BoundedAgentId,
		agent_version: Schema.NullOr(PositiveInt),
		environment_id: BoundedEnvironmentId,
		title: Schema.NullOr(SessionTitle),
	},
	events: [SessionCreated],
	rejects: [
		AgentNotFound,
		AgentArchivedError,
		AgentVersionNotFound,
		EnvironmentNotFound,
		EnvironmentArchivedError,
		SessionAlreadyExists,
	],
	reply: {
		agent_version: PositiveInt,
	},
}) {}

/**
 * Atomically verifies that the referenced agent (and requested version) and
 * environment are active when creating a session, so a concurrent archive or
 * delete cannot leave a newly created session pointing at an ineligible resource.
 */
export class AdmitSessionDecision extends Domain.Decision(AdmitSession, {
	reads: { agent: Agent, environment: Environment, session: Session },
	keyOf: (cmd) => ({
		agent: cmd.agent_id,
		environment: cmd.environment_id,
		session: cmd.session_id,
	}),
	decide: ({ agent, environment, session }, cmd) => {
		if (agent.state.status === "") {
			return new AgentNotFound({ agent_id: agent.id })
		}
		if (agent.state.status !== "active") {
			return new AgentArchivedError({ agent_id: agent.id })
		}
		const pinnedVersion = cmd.agent_version ?? agent.state.version
		if (pinnedVersion > agent.state.version) {
			return new AgentVersionNotFound({ agent_id: agent.id, version: pinnedVersion })
		}
		if (environment.state.status === "" || environment.state.status === "deleted") {
			return new EnvironmentNotFound({ environment_id: environment.id })
		}
		if (environment.state.status !== "active") {
			return new EnvironmentArchivedError({ environment_id: environment.id })
		}
		if (session.state._tag !== "Uninitialized") {
			return new SessionAlreadyExists({ session_id: session.id })
		}
		return [
			session.record(
				new SessionCreated({
					agent_id: agent.id,
					agent_version: pinnedVersion,
					environment_id: environment.id,
					title: cmd.title,
				}),
			),
		]
	},
	transitions: {
		OnlyActiveAgentAndEnvironmentAdmitSession: ({ before, after }) =>
			before.agent.status === "active" &&
			before.environment.status === "active" &&
			before.session._tag === "Uninitialized" &&
			after.session._tag === "Idle" &&
			after.session.turn === 0,
		PinnedVersionWithinAgentHead: ({ before, command, events }) => {
			const pinned = command.agent_version ?? before.agent.version
			return (
				before.agent.version >= 1 &&
				pinned >= 1 &&
				pinned <= before.agent.version &&
				events.length === 1 &&
				events.every(
					(event) =>
						event.agent_id === command.agent_id &&
						event.agent_version === pinned &&
						event.environment_id === command.environment_id,
				)
			)
		},
		AdmissionLeavesAgentAndEnvironmentUnchanged: ({ before, after }) =>
			[
				after.agent.status === before.agent.status,
				after.agent.version === before.agent.version,
				after.agent.current_version_id === before.agent.current_version_id,
				after.agent.name === before.agent.name,
				after.agent.model_id === before.agent.model_id,
				after.agent.has_system === before.agent.has_system,
				after.agent.system === before.agent.system,
				after.agent.has_description === before.agent.has_description,
				after.agent.description === before.agent.description,
				after.environment.status === before.environment.status,
				after.environment.version === before.environment.version,
				after.environment.name === before.environment.name,
			].every((ok) => ok),
	},
	reply: (states, events) => {
		const created = events.find((event) => event._tag === "session.created")
		return {
			agent_version: created !== undefined ? created.agent_version : states.agent.version,
		}
	},
}) {}

/**
 * Unified hosted domain model for `@checkfu/api`.
 * Hosting Agents, Environments, and Sessions in one model allows two-phase
 * cross-aggregate decisions like {@link AdmitSessionDecision} to enforce
 * resource eligibility atomically on Cloudflare Durable Objects.
 */
export class Checkfu extends Domain.Model("Checkfu", {
	aggregates: [Agent, AgentVersion, Environment, Session, EventBatch],
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
		AnEventBatchIsClaimed: (m) => m.EventBatch.some((b) => b.state._tag === "Claimed"),
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
		"ClaimEventBatch",
	],
	views: [
		"AgentView",
		"AgentVersionView",
		"AgentVersionByNumberView",
		"EnvironmentView",
		"SessionView",
	],
}) {}
