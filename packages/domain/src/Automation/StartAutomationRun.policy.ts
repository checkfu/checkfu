import * as Domain from "@alchemy.run/domain"
import type * as Policy from "@alchemy.run/domain/Policy"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
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

const refused = (error_type: string, message: string, unrecoverable: boolean) => ({
	opened: false as const,
	error_type,
	message,
	unrecoverable,
})

export class StartAutomationRun extends Domain.Policy("StartAutomationRun", {
	from: AutomationView,
	on: [AutomationFired],
}) {}

export class EnsureAutomationRunStarted extends Domain.Policy("EnsureAutomationRunStarted", {
	from: Automation,
	on: [AutomationFired],
}) {}

export const runSessionCommandId = (automation_id: string, run: number) =>
	`automation-run:${automation_id}:${run}`

export const startAutomationRun = Effect.gen(function* () {
	const automations = yield* Automation
	const opening = yield* OpenAutomationSessionDecision
	const views = yield* AutomationView
	return Effect.fn(function* ({
		source,
		event,
		envelope,
	}:
		| Policy.TriggerOf<typeof StartAutomationRun>
		| Policy.TriggerOf<typeof EnsureAutomationRunStarted>) {
		const state = Option.getOrNull(
			yield* Effect.orDie(
				views.get(source, {
					atLeast: { stream: `Automation/${source.id}`, version: envelope.seq },
				}),
			),
		)
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
					agent_id: state.agent_id,
					agent_version: state.agent_version,
					error_type,
					message,
					unrecoverable,
				}),
			)
		const outcome = yield* opening
			.send(
				new OpenAutomationSession({
					session_id: event.session_id,
					agent_id: BoundedAgentId.make(state.agent_id),
					agent_version: state.agent_version,
					environment_id: BoundedEnvironmentId.make(state.environment_id),
					title: state.name,
					text: state.text,
				}),
				{ commandId: runSessionCommandId(source.id, event.run) },
			)
			.pipe(
				Effect.map((receipt) => ({
					opened: true as const,
					created: receipt.events.find((created) => created._tag === "session.created") ?? null,
				})),
				Effect.catchTag("SessionAlreadyExists", () =>
					Effect.succeed(refused(SESSION_CONFLICT, SESSION_CONFLICT_MESSAGE, false)),
				),
				Effect.catchTag(["AgentNotFound", "AgentArchivedError", "AgentVersionNotFound"], () =>
					Effect.succeed(refused(AGENT_UNAVAILABLE, AGENT_UNAVAILABLE_MESSAGE, true)),
				),
				Effect.catchTag(["EnvironmentNotFound", "EnvironmentArchivedError"], () =>
					Effect.succeed(refused(ENVIRONMENT_UNAVAILABLE, ENVIRONMENT_UNAVAILABLE_MESSAGE, true)),
				),
			)
		if (!outcome.opened) {
			yield* fail(outcome.error_type, outcome.message, outcome.unrecoverable)
			return
		}
		if (outcome.created === null) {
			return yield* Effect.die(new Error("An opened automation session records its agent."))
		}
		yield* automations.send(
			new RecordAutomationRunStarted({
				...run,
				agent_id: outcome.created.agent_id,
				agent_version: outcome.created.agent_version,
			}),
		)
	})
})

export const StartAutomationRunLive = StartAutomationRun.toLayer(startAutomationRun)

export const EnsureAutomationRunStartedLive = EnsureAutomationRunStarted.toLayer(startAutomationRun)
