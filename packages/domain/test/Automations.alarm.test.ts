import { UpdateAutomation } from "../src/Automation/UpdateAutomation.command.ts"
import { UpdateAutomationDecision } from "../src/Automation/UpdateAutomation.decision.ts"
import { AgentId } from "../src/Agent/Agent.id.ts"
import { AgentVersionId } from "../src/Agent/AgentVersion.id.ts"
import { AUTOMATION_CAPACITY } from "../src/Automation/AutomationCapacity.id.ts"
import { Checkfu, CheckfuDomainApi, CheckfuHandlersLive } from "../src/Checkfu.model.ts"
import { EnvironmentId } from "../src/Environment/Environment.id.ts"
import { ListingStore } from "../src/Listing/ListingStore.ts"
import { BoundedAgentId, BoundedEnvironmentId } from "../src/Session/AdmitSession.command.ts"
import { Harness } from "../src/Session/Harness.external.ts"
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
					description: null,
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

	it.effect("arms nothing when a paused automation is updated, even with a new schedule", () => {
		const platform = InMemory.make({
			manual: true,
			now: () => Date.parse("2026-01-01T08:00:00.000Z"),
		})
		const harness = Harness.toLayer(
			Effect.succeed({
				interrupt: () => Effect.void,
				discardWorkspace: () => Effect.void,
				runTurn: () =>
					Effect.succeed({
						thinking: null,
						text: "ok",
						input_tokens: 1,
						output_tokens: 1,
						stop_reason: { type: "end_turn" as const },
					}),
			}),
		)
		const id = AutomationId.make("auto_paused")
		return Effect.gen(function* () {
			const domain = yield* CheckfuDomainApi.clientInProcess
			const automations = yield* Automation
			const settle = platform.control.drain
			yield* domain.CreateAgent({
				agent_id: AgentId.make("agent_alarm"),
				version_id: AgentVersionId.make("aver_alarm"),
				name: "Reporter",
				model: { id: "gpt-4o-mini" },
				system: null,
				description: null,
			})
			yield* domain.CreateEnvironment({
				environment_id: EnvironmentId.make("env_alarm"),
				name: "Cloud",
				description: null,
				config: { type: "cloud", networking: { type: "unrestricted" } },
			})
			yield* domain.AdmitAutomation({
				automation_id: id,
				capacity_id: AUTOMATION_CAPACITY,
				name: "Morning report",
				description: null,
				agent_id: BoundedAgentId.make("agent_alarm"),
				agent_version: null,
				environment_id: BoundedEnvironmentId.make("env_alarm"),
				text: "Write the morning report.",
				schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
			})
			yield* settle
			yield* domain.PauseAutomation({ automation_id: id })
			yield* settle
			yield* (yield* UpdateAutomationDecision).send(
				new UpdateAutomation({
					automation_id: id,
					expected_revision: 1,
					changed: true,
					reschedule: true,
					agent_changed: false,
					environment_changed: false,
					name: "Morning report",
					description: null,
					agent_id: BoundedAgentId.make("agent_alarm"),
					agent_version: null,
					environment_id: BoundedEnvironmentId.make("env_alarm"),
					text: "Write the morning report.",
					schedule: { type: "cron", expression: "0 12 * * *", timezone: "UTC" },
				}),
			)
			yield* settle
			const cancelled = yield* Effect.flip(automations.unschedule(id, NEXT_FIRING))
			expect(cancelled._tag).toBe("AlreadyCancelled")
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Checkfu.layer(CheckfuHandlersLive.pipe(Layer.provide([harness, ListingStore.memory]))).pipe(
					Layer.provide(platform.layer),
				),
			),
		)
	})
})
