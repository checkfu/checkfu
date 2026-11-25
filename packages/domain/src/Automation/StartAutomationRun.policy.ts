import * as Domain from "@alchemy.run/domain"
import type * as Policy from "@alchemy.run/domain/Policy"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { Automation } from "./Automation.aggregate.ts"
import { AutomationView } from "./AutomationView.view.ts"
import { automationRunKey, OpenAutomationRun } from "./OpenAutomationRun.saga.ts"
import { AutomationFired } from "./RunAutomation.command.ts"

export {
	AGENT_UNAVAILABLE,
	ENVIRONMENT_UNAVAILABLE,
	SESSION_CONFLICT,
} from "./OpenAutomationRun.saga.ts"

export class StartAutomationRun extends Domain.Policy("StartAutomationRun", {
	from: AutomationView,
	on: [AutomationFired],
}) {}

export class EnsureAutomationRunStarted extends Domain.Policy("EnsureAutomationRunStarted", {
	from: Automation,
	on: [AutomationFired],
}) {}

export const startAutomationRun = Effect.gen(function* () {
	const runs = yield* OpenAutomationRun
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
		yield* runs.start(automationRunKey(source.id, event.run), {
			automation_id: source.id,
			run: event.run,
			session_id: event.session_id,
			trigger: event.trigger,
			scheduled_at: event.scheduled_at,
			revision: state.revision,
			agent_id: state.agent_id,
			agent_version: state.agent_version,
			environment_id: state.environment_id,
			title: state.name,
			text: state.text,
		})
	})
})

export const StartAutomationRunLive = StartAutomationRun.toLayer(startAutomationRun)

export const EnsureAutomationRunStartedLive = EnsureAutomationRunStarted.toLayer(startAutomationRun)
