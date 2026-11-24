import * as InMemory from "@alchemy.run/domain/InMemory"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ArchiveAutomation } from "../src/Automation/ArchiveAutomation.command.ts"
import { ArmAutomationLive, NEXT_FIRING } from "../src/Automation/ArmAutomation.policy.ts"
import { Automation } from "../src/Automation/Automation.aggregate.ts"
import { AutomationId } from "../src/Automation/Automation.id.ts"
import { CreateAutomation } from "../src/Automation/CreateAutomation.command.ts"
import { PauseAutomation } from "../src/Automation/PauseAutomation.command.ts"
import { UnpauseAutomation } from "../src/Automation/UnpauseAutomation.command.ts"
import { Automations } from "../src/Automations.model.ts"

describe("Automation alarms", () => {
	it.effect("cancels the armed firing when the automation is paused or archived", () => {
		const platform = InMemory.make({
			manual: true,
			now: () => Date.parse("2026-01-01T08:00:00.000Z"),
		})
		const id = AutomationId.make("auto_alarm")
		return Effect.gen(function* () {
			const automations = yield* Automation
			const settle = platform.control.drain
			const cancelAgain = Effect.flip(automations.unschedule(id, NEXT_FIRING)).pipe(
				Effect.map((error) => error._tag),
			)
			yield* automations.send(
				new CreateAutomation({
					automation_id: id,
					name: "Morning report",
					agent_id: "agent_001",
					agent_version: null,
					environment_id: "env_001",
					text: "Write the morning report.",
					schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
				}),
			)
			yield* settle
			yield* automations.send(new PauseAutomation({ automation_id: id }))
			yield* settle
			expect(yield* cancelAgain).toBe("AlreadyCancelled")

			yield* automations.send(new UnpauseAutomation({ automation_id: id }))
			yield* settle
			yield* automations.send(new ArchiveAutomation({ automation_id: id }))
			yield* settle
			expect(yield* cancelAgain).toBe("AlreadyCancelled")
		}).pipe(
			Effect.scoped,
			Effect.provide(Automations.layer(ArmAutomationLive).pipe(Layer.provide(platform.layer))),
		)
	})
})
