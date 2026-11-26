import * as Domain from "@alchemy.run/domain"
import type * as Policy from "@alchemy.run/domain/Policy"
import type { WebhookEventType } from "@checkfu/sdk/Schemas"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import { Agent } from "../Agent/Agent.aggregate.ts"
import { AgentArchived } from "../Agent/ArchiveAgent.command.ts"
import { AgentCreated } from "../Agent/CreateAgent.command.ts"
import { AgentUpdated } from "../Agent/UpdateAgent.command.ts"
import { ArtifactVersionAdded } from "../Artifact/AddArtifactVersion.command.ts"
import { Artifact } from "../Artifact/Artifact.aggregate.ts"
import { ArtifactCreated } from "../Artifact/CreateArtifact.command.ts"
import { ArtifactDeleted } from "../Artifact/DeleteArtifact.command.ts"
import { ArtifactPublished } from "../Artifact/PublishArtifact.command.ts"
import { ArtifactUnpublished } from "../Artifact/UnpublishArtifact.command.ts"
import { AutomationArchived } from "../Automation/ArchiveAutomation.command.ts"
import { Automation } from "../Automation/Automation.aggregate.ts"
import { AutomationCreated } from "../Automation/CreateAutomation.command.ts"
import { AutomationPaused } from "../Automation/PauseAutomation.command.ts"
import { AutomationRunFailed } from "../Automation/RecordAutomationRunFailed.command.ts"
import { AutomationRunStarted } from "../Automation/RecordAutomationRunStarted.command.ts"
import { AutomationFired } from "../Automation/RunAutomation.command.ts"
import { AutomationUnpaused } from "../Automation/UnpauseAutomation.command.ts"
import { AutomationUpdated } from "../Automation/UpdateAutomation.command.ts"
import { EnvironmentArchived } from "../Environment/ArchiveEnvironment.command.ts"
import { EnvironmentCreated } from "../Environment/CreateEnvironment.command.ts"
import { EnvironmentDeleted } from "../Environment/DeleteEnvironment.command.ts"
import { Environment } from "../Environment/Environment.aggregate.ts"
import { EnvironmentUpdated } from "../Environment/UpdateEnvironment.command.ts"
import { SessionErrorEvent } from "../Session/AbandonTurn.command.ts"
import { SessionArchived, SessionStatusTerminated } from "../Session/ArchiveSession.command.ts"
import { SessionStatusIdle } from "../Session/CommitModelReply.command.ts"
import { SessionCreated } from "../Session/CreateSession.command.ts"
import { SessionStatusRunning } from "../Session/SendUserMessage.command.ts"
import { Session } from "../Session/Session.aggregate.ts"
import { WebhookEvents } from "./WebhookEvents.external.ts"
import type { WebhookResourceType } from "./WebhookEvents.external.ts"

export class PublishWebhookEvents extends Domain.Policy(
	"PublishWebhookEvents",
	{
		from: [Agent, Environment, Session, Automation, Artifact],
		on: [
			AgentCreated,
			AgentUpdated,
			AgentArchived,
			EnvironmentCreated,
			EnvironmentUpdated,
			EnvironmentArchived,
			EnvironmentDeleted,
			SessionCreated,
			SessionStatusRunning,
			SessionStatusIdle,
			SessionStatusTerminated,
			SessionErrorEvent,
			SessionArchived,
			AutomationCreated,
			AutomationUpdated,
			AutomationPaused,
			AutomationUnpaused,
			AutomationArchived,
			AutomationFired,
			AutomationRunStarted,
			AutomationRunFailed,
			ArtifactCreated,
			ArtifactVersionAdded,
			ArtifactPublished,
			ArtifactUnpublished,
			ArtifactDeleted,
		],
	},
	{
		description:
			"Forwards committed resource lifecycle events to registered outbound webhook listeners.",
	},
) {}

interface PublishedPayload {
	readonly event_type: WebhookEventType
	readonly resource_type: WebhookResourceType
	readonly data_json: string
}

const payloadOf = ({
	source,
	event,
}: Policy.TriggerOf<typeof PublishWebhookEvents>): PublishedPayload => {
	switch (event._tag) {
		case "agent.created":
			return {
				event_type: "agent.created",
				resource_type: "agent",
				data_json: JSON.stringify({
					agent_id: source.id,
					version: event.version,
					version_id: event.version_id,
					name: event.name,
					model: event.model,
				}),
			}
		case "agent.updated":
			return {
				event_type: "agent.updated",
				resource_type: "agent",
				data_json: JSON.stringify({
					agent_id: source.id,
					version: event.version,
					version_id: event.version_id,
					name: event.name,
					model: event.model,
				}),
			}
		case "agent.archived":
			return {
				event_type: "agent.archived",
				resource_type: "agent",
				data_json: JSON.stringify({ agent_id: source.id }),
			}
		case "environment.created":
			return {
				event_type: "environment.created",
				resource_type: "environment",
				data_json: JSON.stringify({
					environment_id: source.id,
					version: event.version,
					name: event.name,
				}),
			}
		case "environment.updated":
			return {
				event_type: "environment.updated",
				resource_type: "environment",
				data_json: JSON.stringify({
					environment_id: source.id,
					version: event.version,
					name: event.name,
				}),
			}
		case "environment.archived":
			return {
				event_type: "environment.archived",
				resource_type: "environment",
				data_json: JSON.stringify({ environment_id: source.id }),
			}
		case "environment.deleted":
			return {
				event_type: "environment.deleted",
				resource_type: "environment",
				data_json: JSON.stringify({ environment_id: source.id }),
			}
		case "session.created":
			return {
				event_type: "session.created",
				resource_type: "session",
				data_json: JSON.stringify({
					session_id: source.id,
					agent_id: event.agent_id,
					agent_version: event.agent_version,
					environment_id: event.environment_id,
					title: event.title,
				}),
			}
		case "session.status_running":
			return {
				event_type: "session.status_running",
				resource_type: "session",
				data_json: JSON.stringify({
					session_id: source.id,
					turn: event.turn,
				}),
			}
		case "session.status_idle":
			return {
				event_type: "session.status_idle",
				resource_type: "session",
				data_json: JSON.stringify({
					session_id: source.id,
					turn: event.turn,
					stop_reason: event.stop_reason,
				}),
			}
		case "session.status_terminated":
			return {
				event_type: "session.status_terminated",
				resource_type: "session",
				data_json: JSON.stringify({
					session_id: source.id,
					running_turn: event.running_turn,
				}),
			}
		case "session.error":
			return {
				event_type: "session.error",
				resource_type: "session",
				data_json: JSON.stringify({
					session_id: source.id,
					error: event.error,
				}),
			}
		case "session.archived":
			return {
				event_type: "session.archived",
				resource_type: "session",
				data_json: JSON.stringify({ session_id: source.id }),
			}
		case "automation.created":
			return {
				event_type: "automation.created",
				resource_type: "automation",
				data_json: JSON.stringify({
					automation_id: source.id,
					name: event.name,
					agent_id: event.agent_id,
					agent_version: event.agent_version,
					environment_id: event.environment_id,
					schedule: event.schedule,
				}),
			}
		case "automation.updated":
			return {
				event_type: "automation.updated",
				resource_type: "automation",
				data_json: JSON.stringify({
					automation_id: source.id,
					name: event.name,
					revision: event.revision,
					agent_id: event.agent_id,
					agent_version: event.agent_version,
					environment_id: event.environment_id,
					schedule: event.schedule,
				}),
			}
		case "automation.paused":
			return {
				event_type: "automation.paused",
				resource_type: "automation",
				data_json: JSON.stringify({
					automation_id: source.id,
					reason: event.reason,
				}),
			}
		case "automation.unpaused":
			return {
				event_type: "automation.unpaused",
				resource_type: "automation",
				data_json: JSON.stringify({
					automation_id: source.id,
					activation: event.activation,
				}),
			}
		case "automation.archived":
			return {
				event_type: "automation.archived",
				resource_type: "automation",
				data_json: JSON.stringify({ automation_id: source.id }),
			}
		case "automation.fired":
			return {
				event_type: "automation.fired",
				resource_type: "automation",
				data_json: JSON.stringify({
					automation_id: source.id,
					run: event.run,
					session_id: event.session_id,
					trigger: event.trigger,
					scheduled_at: event.scheduled_at,
				}),
			}
		case "automation.run_started":
			return {
				event_type: "automation.run_started",
				resource_type: "automation",
				data_json: JSON.stringify({
					automation_id: source.id,
					run: event.run,
					session_id: event.session_id,
					trigger: event.trigger,
					scheduled_at: event.scheduled_at,
					agent_id: event.agent_id,
					agent_version: event.agent_version,
				}),
			}
		case "automation.run_failed":
			return {
				event_type: "automation.run_failed",
				resource_type: "automation",
				data_json: JSON.stringify({
					automation_id: source.id,
					run: event.run,
					trigger: event.trigger,
					scheduled_at: event.scheduled_at,
					agent_id: event.agent_id,
					agent_version: event.agent_version,
					error: event.error,
				}),
			}
		case "artifact.created":
			return {
				event_type: "artifact.created",
				resource_type: "artifact",
				data_json: JSON.stringify({
					artifact_id: source.id,
					version: event.version,
					name: event.name,
					manifest: event.manifest,
					file_count: event.file_count,
					total_bytes: event.total_bytes,
				}),
			}
		case "artifact.version_added":
			return {
				event_type: "artifact.version_added",
				resource_type: "artifact",
				data_json: JSON.stringify({
					artifact_id: source.id,
					version: event.version,
					manifest: event.manifest,
					file_count: event.file_count,
					total_bytes: event.total_bytes,
				}),
			}
		case "artifact.published":
			return {
				event_type: "artifact.published",
				resource_type: "artifact",
				data_json: JSON.stringify({
					artifact_id: source.id,
					pinned_version: event.pinned_version,
				}),
			}
		case "artifact.unpublished":
			return {
				event_type: "artifact.unpublished",
				resource_type: "artifact",
				data_json: JSON.stringify({ artifact_id: source.id }),
			}
		case "artifact.deleted":
			return {
				event_type: "artifact.deleted",
				resource_type: "artifact",
				data_json: JSON.stringify({ artifact_id: source.id }),
			}
	}
}

export const PublishWebhookEventsLive = PublishWebhookEvents.toLayer(
	Effect.gen(function* () {
		const events = yield* WebhookEvents
		return Effect.fn(function* (trigger) {
			const published = payloadOf(trigger)
			yield* events.publish({
				event_id: `evt_${published.resource_type}_${trigger.source.id}_${trigger.envelope.seq}`,
				event_type: published.event_type,
				resource_type: published.resource_type,
				resource_id: trigger.source.id,
				occurred_at: DateTime.toEpochMillis(trigger.envelope.at),
				data_json: published.data_json,
			})
		})
	}),
	{ retry: Schedule.max([Schedule.exponential("200 millis"), Schedule.recurs(6)]) },
)
