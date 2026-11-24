import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { BoundedAgentId, BoundedEnvironmentId } from "../Session/AdmitSession.command.ts"
import { Automation } from "./Automation.aggregate.ts"
import { AutomationView } from "./AutomationView.view.ts"
import { OpenAutomationSession } from "./OpenAutomationSession.command.ts"
import { OpenAutomationSessionDecision } from "./OpenAutomationSession.decision.ts"
import { RecordAutomationRunFailed } from "./RecordAutomationRunFailed.command.ts"
import { RecordAutomationRunStarted } from "./RecordAutomationRunStarted.command.ts"
import { AutomationFired } from "./RunAutomation.command.ts"

export const AGENT_UNAVAILABLE = "agent_unavailable"
export const ENVIRONMENT_UNAVAILABLE = "environment_unavailable"
export const SESSION_CONFLICT = "session_conflict"

const AGENT_UNAVAILABLE_MESSAGE = "The automation's agent or pinned agent version is not available."
const ENVIRONMENT_UNAVAILABLE_MESSAGE = "The automation's environment is not available."
const SESSION_CONFLICT_MESSAGE =
	"A session this run did not create already has the run's session id."

export class StartAutomationRun extends Domain.Policy("StartAutomationRun", {
	from: AutomationView,
	on: [AutomationFired],
}) {}

export const StartAutomationRunLive = StartAutomationRun.toLayer(
	Effect.gen(function* () {
		const automations = yield* Automation
		const opening = yield* OpenAutomationSessionDecision
		return Effect.fn(function* ({ source, state, event }) {
			if (state === null) {
				return
			}
			const run = {
				automation_id: source.id,
				run: event.run,
				trigger: event.trigger,
				scheduled_at: event.scheduled_at,
			}
			const fail = (error_type: string, message: string, unrecoverable: boolean) =>
				automations.send(
					new RecordAutomationRunFailed({
						...run,
						revision: state.revision,
						error_type,
						message,
						unrecoverable,
					}),
				)
			// A retried delivery resends the same command id and gets the first receipt back,
			// so SessionAlreadyExists here means another caller owns that session.
			const refused = yield* opening
				.send(
					new OpenAutomationSession({
						session_id: event.session_id,
						agent_id: BoundedAgentId.make(state.agent_id),
						agent_version: state.agent_version,
						environment_id: BoundedEnvironmentId.make(state.environment_id),
						title: state.name,
						text: state.text,
					}),
				)
				.pipe(
					Effect.as(null),
					Effect.catchTag("SessionAlreadyExists", () =>
						Effect.succeed([SESSION_CONFLICT, SESSION_CONFLICT_MESSAGE, false] as const),
					),
					Effect.catchTag(["AgentNotFound", "AgentArchivedError", "AgentVersionNotFound"], () =>
						Effect.succeed([AGENT_UNAVAILABLE, AGENT_UNAVAILABLE_MESSAGE, true] as const),
					),
					Effect.catchTag(["EnvironmentNotFound", "EnvironmentArchivedError"], () =>
						Effect.succeed([
							ENVIRONMENT_UNAVAILABLE,
							ENVIRONMENT_UNAVAILABLE_MESSAGE,
							true,
						] as const),
					),
				)
			if (refused !== null) {
				yield* fail(refused[0], refused[1], refused[2])
				return
			}
			yield* automations.send(new RecordAutomationRunStarted(run))
		})
	}),
)
