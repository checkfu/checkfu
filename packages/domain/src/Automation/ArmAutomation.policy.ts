import * as Domain from "@alchemy.run/domain"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
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

export const NEXT_FIRING = "next-firing"

export class ArmAutomation extends Domain.Policy("ArmAutomation", {
	from: AutomationView,
	on: [
		AutomationCreated,
		AutomationUnpaused,
		AutomationFired,
		AutomationPaused,
		AutomationArchived,
	],
}) {}

export const ArmAutomationLive = ArmAutomation.toLayer(
	Effect.gen(function* () {
		const automations = yield* Automation
		return Effect.fn(function* ({ source, state, event }) {
			if (state === null) {
				return
			}
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
	}),
)
