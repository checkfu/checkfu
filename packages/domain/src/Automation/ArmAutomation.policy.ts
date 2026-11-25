import * as Domain from "@alchemy.run/domain"
import type * as Policy from "@alchemy.run/domain/Policy"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { AutomationArchived } from "./ArchiveAutomation.command.ts"
import { Automation } from "./Automation.aggregate.ts"
import { SCHEDULE_EXHAUSTED } from "./AutomationTypes.ts"
import { AutomationView } from "./AutomationView.view.ts"
import { AutomationCreated } from "./CreateAutomation.command.ts"
import { FireAutomation } from "./FireAutomation.command.ts"
import { AutomationPaused } from "./PauseAutomation.command.ts"
import { AutomationFired } from "./RunAutomation.command.ts"
import { SuspendAutomation } from "./SuspendAutomation.command.ts"
import { AutomationUnpaused } from "./UnpauseAutomation.command.ts"
import { AutomationUpdated } from "./UpdateAutomation.command.ts"

export const NEXT_FIRING = "next-firing"

export class ArmAutomation extends Domain.Policy("ArmAutomation", {
	from: AutomationView,
	on: [
		AutomationCreated,
		AutomationUnpaused,
		AutomationUpdated,
		AutomationFired,
		AutomationPaused,
		AutomationArchived,
	],
}) {}

export class EnsureAutomationArmed extends Domain.Policy("EnsureAutomationArmed", {
	from: Automation,
	on: [
		AutomationCreated,
		AutomationUnpaused,
		AutomationUpdated,
		AutomationFired,
		AutomationPaused,
		AutomationArchived,
	],
}) {}

export const armAutomation = Effect.gen(function* () {
	const automations = yield* Automation
	const views = yield* AutomationView
	return Effect.fn(function* ({
		source,
		event,
		envelope,
	}: Policy.TriggerOf<typeof ArmAutomation> | Policy.TriggerOf<typeof EnsureAutomationArmed>) {
		if (event._tag === "automation.paused" || event._tag === "automation.archived") {
			yield* automations
				.unschedule(source.id, NEXT_FIRING)
				.pipe(
					Effect.catchTag(
						["AlreadyExecuted", "AlreadyCancelled", "NotScheduled"],
						() => Effect.void,
					),
				)
			return
		}
		if (event._tag === "automation.fired" && event.trigger === "manual") {
			return
		}
		if (event._tag === "automation.updated" && !event.rescheduled) {
			return
		}
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
		const next = state.upcoming[0]
		if (next === undefined) {
			yield* automations.send(
				new SuspendAutomation({ automation_id: source.id, reason: SCHEDULE_EXHAUSTED }),
			)
			return
		}
		yield* automations.schedule(
			new FireAutomation({
				automation_id: source.id,
				activation: state.activation,
				scheduled_at: next,
			}),
			{ at: DateTime.makeUnsafe(next), commandId: NEXT_FIRING },
		)
	})
})

export const ArmAutomationLive = ArmAutomation.toLayer(armAutomation)

export const EnsureAutomationArmedLive = EnsureAutomationArmed.toLayer(armAutomation)
