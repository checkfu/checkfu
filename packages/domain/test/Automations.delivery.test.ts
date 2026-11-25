import * as Aggregate from "@alchemy.run/domain/Aggregate"
import * as InMemory from "@alchemy.run/domain/InMemory"
import type * as Policy from "@alchemy.run/domain/Policy"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { AgentId } from "../src/Agent/Agent.id.ts"
import { AgentVersionId } from "../src/Agent/AgentVersion.id.ts"
import {
	ArmAutomation,
	armAutomation,
	EnsureAutomationArmedLive,
	NEXT_FIRING,
} from "../src/Automation/ArmAutomation.policy.ts"
import { Automation } from "../src/Automation/Automation.aggregate.ts"
import { AutomationId } from "../src/Automation/Automation.id.ts"
import { AUTOMATION_CAPACITY } from "../src/Automation/AutomationCapacity.id.ts"
import { AutomationRunView } from "../src/Automation/AutomationRunView.view.ts"
import { AutomationView } from "../src/Automation/AutomationView.view.ts"
import { CreateAutomation } from "../src/Automation/CreateAutomation.command.ts"
import { FreeAutomationSlotLive } from "../src/Automation/FreeAutomationSlot.policy.ts"
import { PauseAutomation } from "../src/Automation/PauseAutomation.command.ts"
import {
	EnsureAutomationRunStarted,
	StartAutomationRun,
	startAutomationRun,
} from "../src/Automation/StartAutomationRun.policy.ts"
import type {
	EnsureAutomationRunStartedLive,
	StartAutomationRunLive,
} from "../src/Automation/StartAutomationRun.policy.ts"
import { UpdateAutomation } from "../src/Automation/UpdateAutomation.command.ts"
import { UpdateAutomationDecision } from "../src/Automation/UpdateAutomation.decision.ts"
import { Automations } from "../src/Automations.model.ts"
import { Checkfu, CheckfuDomainApi } from "../src/Checkfu.model.ts"
import { EnvironmentId } from "../src/Environment/Environment.id.ts"
import { ListingLive } from "../src/Listing/Listing.projection.ts"
import { ListingStore } from "../src/Listing/ListingStore.ts"
import { ListResourcesLive } from "../src/Listing/ListResources.query.ts"
import { BoundedAgentId, BoundedEnvironmentId } from "../src/Session/AdmitSession.command.ts"
import { EnsureTurnStartedLive } from "../src/Session/EnsureTurnStarted.policy.ts"
import { EnsureTurnStoppedLive } from "../src/Session/EnsureTurnStopped.policy.ts"
import { Harness } from "../src/Session/Harness.external.ts"
import { RunTurnLive } from "../src/Session/RunTurn.saga.ts"
import { StartTurnLive } from "../src/Session/StartTurn.policy.ts"

type Trigger =
	| Policy.TriggerOf<typeof StartAutomationRun>
	| Policy.TriggerOf<typeof EnsureAutomationRunStarted>

const automationId = AutomationId.make("auto_delivery")
const now = () => Date.parse("2026-01-01T08:00:00.000Z")

const settle = (platform: ReturnType<typeof InMemory.make>) =>
	Effect.gen(function* () {
		for (let i = 0; i < 1000; i++) {
			yield* platform.control.drain
			yield* Effect.yieldNow
			if (yield* platform.control.idle) {
				yield* Effect.yieldNow
				yield* platform.control.drain
				if (yield* platform.control.idle) {
					return
				}
			}
		}
		return yield* Effect.die(new Error("the platform did not settle"))
	})

const harness = Harness.toLayer(
	Effect.succeed({
		interrupt: () => Effect.void,
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

const policyRun = (prefix: string) => {
	let n = 0
	return { next: () => `${prefix}:${n++}` }
}

const viewDeliveriesHeld = () => {
	const held: Array<Trigger> = []
	return {
		hold: (trigger: Trigger) => Effect.sync(() => held.push(trigger)),
		release: (handle: (trigger: Trigger) => Effect.Effect<void>) =>
			Effect.forEach(
				held.splice(0),
				(trigger, index) =>
					handle(trigger).pipe(
						Effect.provideService(Aggregate.PolicyRun, policyRun(`late-view:${index}`)),
					),
				{ discard: true },
			),
	}
}

const hosted = <A, E, R>(
	platform: ReturnType<typeof InMemory.make>,
	start: typeof StartAutomationRunLive,
	ensure: typeof EnsureAutomationRunStartedLive,
	body: Effect.Effect<A, E, R>,
) =>
	body.pipe(
		Effect.scoped,
		Effect.provide(
			Checkfu.layer(
				Layer.mergeAll(
					StartTurnLive,
					EnsureTurnStartedLive,
					EnsureTurnStoppedLive,
					RunTurnLive,
					ArmAutomation.toLayer(armAutomation),
					EnsureAutomationArmedLive,
					start,
					ensure,
					FreeAutomationSlotLive,
					ListingLive,
					ListResourcesLive,
				).pipe(Layer.provide([harness, ListingStore.memory])),
			).pipe(Layer.provide(platform.layer)),
		),
	)

const createAgent = (id: string) =>
	Effect.flatMap(CheckfuDomainApi.clientInProcess, (domain) =>
		domain.CreateAgent({
			agent_id: AgentId.make(id),
			version_id: AgentVersionId.make(`aver_${id}`),
			name: id,
			model: { id: "gpt-4o-mini" },
			system: null,
			description: null,
		}),
	)

const setUp = Effect.gen(function* () {
	const domain = yield* CheckfuDomainApi.clientInProcess
	yield* createAgent("agent_first")
	yield* createAgent("agent_second")
	yield* domain.CreateEnvironment({
		environment_id: EnvironmentId.make("env_delivery"),
		name: "Cloud",
		description: null,
		config: { type: "cloud", networking: { type: "unrestricted" } },
	})
	yield* domain.AdmitAutomation({
		automation_id: automationId,
		capacity_id: AUTOMATION_CAPACITY,
		name: "Report",
		description: null,
		agent_id: BoundedAgentId.make("agent_first"),
		agent_version: null,
		environment_id: BoundedEnvironmentId.make("env_delivery"),
		text: "Write the report.",
		schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
	})
})

const runsRecorded = Effect.gen(function* () {
	const runs = yield* AutomationRunView
	const page = yield* runs.list(Automation.ref(automationId), { take: 10 })
	return page.entries.map(({ event }) =>
		event._tag === "automation.run_started"
			? { run: event.run, started: true, agent_id: event.agent_id, session_id: event.session_id }
			: { run: event.run, started: false, agent_id: event.agent_id, session_id: null },
	)
})

describe("StartAutomationRun", () => {
	it.effect(
		"reports a run that reaches it only through the view after a later run, as at the deploy that adds the aggregate feed",
		() => {
			const platform = InMemory.make({ manual: true, now })
			const late = viewDeliveriesHeld()
			const start = StartAutomationRun.toLayer(Effect.succeed(late.hold))
			const ensure = EnsureAutomationRunStarted.toLayer(
				Effect.map(
					startAutomationRun,
					(handle) => (trigger: Trigger) =>
						trigger.event.run === 1 ? Effect.void : handle(trigger),
				),
			)
			return hosted(
				platform,
				start,
				ensure,
				Effect.gen(function* () {
					const domain = yield* CheckfuDomainApi.clientInProcess
					yield* setUp
					yield* settle(platform)
					yield* domain.RunAutomation({ automation_id: automationId })
					yield* settle(platform)
					yield* domain.RunAutomation({ automation_id: automationId })
					yield* settle(platform)
					expect(yield* runsRecorded).toEqual([])
					const handle = yield* startAutomationRun
					yield* late.release(handle)
					yield* settle(platform)
					expect((yield* runsRecorded).map(({ run, started }) => ({ run, started }))).toEqual([
						{ run: 1, started: true },
						{ run: 2, started: true },
					])
					expect(platform.control.failures).toEqual([])
				}),
			)
		},
	)

	it.effect(
		"records the agent of the session it opened when the automation moved to another agent before the report",
		() => {
			const platform = InMemory.make({ manual: true, now })
			const late = viewDeliveriesHeld()
			const droppingTheReport = Effect.gen(function* () {
				const real = yield* Automation
				return yield* startAutomationRun.pipe(
					Effect.provideService(Automation, {
						...real,
						send: (command, options) =>
							command._tag === "RecordAutomationRunStarted"
								? Effect.die(new Error("stopped before the report"))
								: real.send(command, options),
					}),
				)
			})
			const start = StartAutomationRun.toLayer(Effect.succeed(late.hold))
			const ensure = EnsureAutomationRunStarted.toLayer(
				Effect.map(
					droppingTheReport,
					(handle) => (trigger: Trigger) =>
						handle(trigger).pipe(Effect.catchDefect(() => Effect.void)),
				),
			)
			return hosted(
				platform,
				start,
				ensure,
				Effect.gen(function* () {
					const domain = yield* CheckfuDomainApi.clientInProcess
					yield* setUp
					yield* settle(platform)
					yield* domain.RunAutomation({ automation_id: automationId })
					yield* settle(platform)
					expect(yield* runsRecorded).toEqual([])
					yield* (yield* UpdateAutomationDecision).send(
						new UpdateAutomation({
							automation_id: automationId,
							expected_revision: 1,
							changed: true,
							reschedule: false,
							agent_changed: true,
							environment_changed: false,
							name: "Report",
							description: null,
							agent_id: BoundedAgentId.make("agent_second"),
							agent_version: null,
							environment_id: BoundedEnvironmentId.make("env_delivery"),
							text: "Write the report.",
							schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
						}),
					)
					yield* settle(platform)
					const handle = yield* startAutomationRun
					yield* late.release(handle)
					yield* settle(platform)
					expect(yield* runsRecorded).toEqual([
						{ run: 1, started: true, agent_id: "agent_first", session_id: expect.any(String) },
					])
					expect(platform.control.failures).toEqual([])
				}),
			)
		},
	)
})

describe("ArmAutomation", () => {
	it.effect("cancels the armed firing on pause without waiting for the view", () => {
		const platform = InMemory.make({ manual: true, now })
		let stalled = false
		const arm = ArmAutomation.toLayer(
			Effect.gen(function* () {
				const real = yield* AutomationView
				return yield* armAutomation.pipe(
					Effect.provideService(AutomationView, {
						...real,
						get: (...args: Parameters<typeof real.get>) =>
							stalled ? platform.control.suspended(Effect.never) : real.get(...args),
					}),
				)
			}),
		)
		return Effect.gen(function* () {
			const automations = yield* Automation
			yield* automations.send(
				new CreateAutomation({
					automation_id: automationId,
					name: "Report",
					description: null,
					agent_id: "agent_001",
					agent_version: null,
					environment_id: "env_001",
					text: "Write the report.",
					schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
				}),
			)
			yield* settle(platform)
			stalled = true
			yield* automations.send(new PauseAutomation({ automation_id: automationId }))
			yield* settle(platform)
			const cancelled = yield* Effect.flip(automations.unschedule(automationId, NEXT_FIRING))
			expect(cancelled._tag).toBe("AlreadyCancelled")
		}).pipe(
			Effect.scoped,
			Effect.provide(Automations.layer(arm).pipe(Layer.provide(platform.layer))),
		)
	})
})
