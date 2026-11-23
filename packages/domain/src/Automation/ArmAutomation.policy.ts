import * as Domain from "@alchemy.run/domain"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { Automation } from "./Automation.aggregate.ts"
import { SCHEDULE_EXHAUSTED } from "./AutomationTypes.ts"
import { AutomationView } from "./AutomationView.view.ts"
import { AutomationCreated } from "./CreateAutomation.command.ts"
import { FireAutomation } from "./FireAutomation.command.ts"
import { AutomationFired } from "./RunAutomation.command.ts"
import { nextOccurrence } from "./Schedule.ts"
import { SuspendAutomation } from "./SuspendAutomation.command.ts"
import { AutomationUnpaused } from "./UnpauseAutomation.command.ts"

const NEXT_FIRING = "next-firing"

export class ArmAutomation extends Domain.Policy("ArmAutomation", {
	from: AutomationView,
	on: [AutomationCreated, AutomationUnpaused, AutomationFired],
}) {}

export const ArmAutomationLive = ArmAutomation.toLayer(
	Effect.gen(function* () {
		const automations = yield* Automation
		return Effect.fn(function* ({ source, state, event, envelope }) {
			if (state === null) {
				return
			}
			if (event._tag === "automation.fired" && event.trigger === "manual") {
				return
			}
			const next = nextOccurrence(
				state.schedule.expression,
				state.schedule.timezone,
				DateTime.toEpochMillis(envelope.at),
			)
			if (next === null) {
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
