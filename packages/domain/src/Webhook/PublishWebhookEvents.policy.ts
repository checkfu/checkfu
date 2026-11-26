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
import { ArtifactOpened } from "../Artifact/OpenArtifact.command.ts"
import { ArtifactPublished } from "../Artifact/PublishArtifact.command.ts"
import { ArtifactUnpublished } from "../Artifact/UnpublishArtifact.command.ts"
import { AutomationArchived } from "../Automation/ArchiveAutomation.command.ts"
import { Automation } from "../Automation/Automation.aggregate.ts"
import { automationRunId } from "../Automation/Automation.id.ts"
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
import { MemoryStoreArchived } from "../Memory/ArchiveMemoryStore.command.ts"
import { MemoryStoreCreated } from "../Memory/CreateMemoryStore.command.ts"
import { MemoryStoreDeleted } from "../Memory/DeleteMemoryStore.command.ts"
import { MemoryStore } from "../Memory/MemoryStore.aggregate.ts"
import { SessionStatusTerminated } from "../Session/ArchiveSession.command.ts"
import { SessionStatusIdle } from "../Session/CommitModelReply.command.ts"
import { SessionStatusRunning } from "../Session/SendUserMessage.command.ts"
import { Session } from "../Session/Session.aggregate.ts"
import { WebhookEvents } from "./WebhookEvents.external.ts"
import type { WebhookResourceType } from "./WebhookEvents.external.ts"

export class PublishWebhookEvents extends Domain.Policy(
	"PublishWebhookEvents",
	{
		from: [Agent, Environment, Session, Automation, Artifact, MemoryStore],
		on: [
			AgentCreated,
			AgentUpdated,
			AgentArchived,
			EnvironmentCreated,
			EnvironmentUpdated,
			EnvironmentArchived,
			EnvironmentDeleted,
			SessionStatusRunning,
			SessionStatusIdle,
			SessionStatusTerminated,
			AutomationCreated,
			AutomationUpdated,
			AutomationPaused,
			AutomationUnpaused,
			AutomationArchived,
			AutomationFired,
			AutomationRunStarted,
			AutomationRunFailed,
			ArtifactCreated,
			ArtifactOpened,
			ArtifactVersionAdded,
			ArtifactPublished,
			ArtifactUnpublished,
			ArtifactDeleted,
			MemoryStoreCreated,
			MemoryStoreArchived,
			MemoryStoreDeleted,
		],
	},
	{
		description:
			"Forwards committed resource lifecycle events to registered outbound webhook listeners.",
	},
) {}

interface WebhookNotification {
	readonly event_type: WebhookEventType
	readonly resource_type: WebhookResourceType
	readonly resource_id: string
	readonly automation_id?: string
}

const notificationOf = ({
	source,
	event,
}: Policy.TriggerOf<typeof PublishWebhookEvents>): WebhookNotification | undefined => {
	switch (event._tag) {
		case "agent.created":
		case "agent.updated":
		case "agent.archived":
			return { event_type: event._tag, resource_type: "agent", resource_id: source.id }
		case "environment.created":
		case "environment.updated":
		case "environment.archived":
		case "environment.deleted":
			return { event_type: event._tag, resource_type: "environment", resource_id: source.id }
		case "session.status_running":
			return {
				event_type: "session.status_run_started",
				resource_type: "session",
				resource_id: source.id,
			}
		case "session.status_idle":
			return {
				event_type: "session.status_idled",
				resource_type: "session",
				resource_id: source.id,
			}
		case "session.status_terminated":
			return { event_type: event._tag, resource_type: "session", resource_id: source.id }
		case "automation.created":
		case "automation.updated":
		case "automation.archived":
		case "automation.paused":
		case "automation.unpaused":
			return { event_type: event._tag, resource_type: "automation", resource_id: source.id }
		case "automation.fired":
		case "automation.run_started":
		case "automation.run_failed":
			if (event.trigger !== "schedule") {
				return undefined
			}
			return {
				event_type:
					event._tag === "automation.fired"
						? "automation_run.started"
						: event._tag === "automation.run_started"
							? "automation_run.succeeded"
							: "automation_run.failed",
				resource_type: "automation_run",
				resource_id: automationRunId(source.id, event.run),
				automation_id: source.id,
			}
		case "memory_store.created":
		case "memory_store.archived":
		case "memory_store.deleted":
			return { event_type: event._tag, resource_type: "memory_store", resource_id: source.id }
		case "artifact.opened":
			return { event_type: "artifact.created", resource_type: "artifact", resource_id: source.id }
		case "artifact.created":
		case "artifact.version_added":
		case "artifact.published":
		case "artifact.unpublished":
		case "artifact.deleted":
			return { event_type: event._tag, resource_type: "artifact", resource_id: source.id }
	}
}

export const PublishWebhookEventsLive = PublishWebhookEvents.toLayer(
	Effect.gen(function* () {
		const events = yield* WebhookEvents
		return Effect.fn(function* (trigger) {
			const notification = notificationOf(trigger)
			if (notification === undefined) {
				return
			}
			yield* events.publish({
				event_id: `evt_${notification.resource_type}_${trigger.source.id}_${trigger.envelope.seq}`,
				...notification,
				occurred_at: DateTime.toEpochMillis(trigger.envelope.at),
			})
		})
	}),
	{ retry: Schedule.max([Schedule.exponential("200 millis"), Schedule.recurs(6)]) },
)
