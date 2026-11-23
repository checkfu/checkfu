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
}) {}
