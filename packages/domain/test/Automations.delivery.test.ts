import * as Aggregate from "@alchemy.run/domain/Aggregate"
import * as InMemory from "@alchemy.run/domain/InMemory"
import type * as Policy from "@alchemy.run/domain/Policy"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as TestClock from "effect/testing/TestClock"
import { AgentId } from "../src/Agent/Agent.id.ts"
import { AgentVersionId } from "../src/Agent/AgentVersion.id.ts"
import {
	ArmAutomationLive,
	EnsureAutomationArmedLive,
} from "../src/Automation/ArmAutomation.policy.ts"
import { Automation } from "../src/Automation/Automation.aggregate.ts"
import { AutomationId, sessionIdOfNextRun } from "../src/Automation/Automation.id.ts"
import { AUTOMATION_CAPACITY } from "../src/Automation/AutomationCapacity.id.ts"
import { AutomationRunView } from "../src/Automation/AutomationRunView.view.ts"
import { FreeAutomationSlotLive } from "../src/Automation/FreeAutomationSlot.policy.ts"
import { OpenAutomationRunLive } from "../src/Automation/OpenAutomationRun.saga.ts"
import {
	EnsureAutomationRunStarted,
	StartAutomationRun,
	startAutomationRun,
} from "../src/Automation/StartAutomationRun.policy.ts"
import { UpdateAutomation } from "../src/Automation/UpdateAutomation.command.ts"
import { UpdateAutomationDecision } from "../src/Automation/UpdateAutomation.decision.ts"
import { Checkfu, CheckfuDomainApi } from "../src/Checkfu.model.ts"
import { EnvironmentId } from "../src/Environment/Environment.id.ts"
import { ListingLive } from "../src/Listing/Listing.projection.ts"
import { ListingStore } from "../src/Listing/ListingStore.ts"
import { ListResourcesLive } from "../src/Listing/ListResources.query.ts"
import { BoundedAgentId, BoundedEnvironmentId } from "../src/Session/AdmitSession.command.ts"
import { SessionCreated } from "../src/Session/CreateSession.command.ts"
import { EnsureTurnStartedLive } from "../src/Session/EnsureTurnStarted.policy.ts"
import { EnsureTurnStoppedLive } from "../src/Session/EnsureTurnStopped.policy.ts"
import { Harness } from "../src/Session/Harness.external.ts"
import { RunTurnLive } from "../src/Session/RunTurn.saga.ts"
import { Session } from "../src/Session/Session.aggregate.ts"
import { SessionView } from "../src/Session/SessionView.view.ts"
import { StartTurnLive } from "../src/Session/StartTurn.policy.ts"

type Trigger =
	| Policy.TriggerOf<typeof StartAutomationRun>
	| Policy.TriggerOf<typeof EnsureAutomationRunStarted>

type Handle = (trigger: Trigger) => Effect.Effect<void>

const automationId = AutomationId.make("auto_delivery")
const T0 = Date.parse("2026-01-01T08:00:00.000Z")

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

const clocked = () => {
	let at = T0
	const platform = InMemory.make({ manual: true, now: () => at })
	const settle = Effect.gen(function* () {
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
	const advance = (ms: number) =>
		Effect.gen(function* () {
			at += ms
			yield* TestClock.setTime(at)
			yield* settle
		})
	return { platform, settle, advance }
}

const viewFeedHeld = () => {
	const held: Array<Trigger> = []
	return {
		hold: (trigger: Trigger) => Effect.sync(() => void held.push(trigger)),
		release: (only: (trigger: Trigger) => boolean) =>
			Effect.gen(function* () {
				const handle = yield* startAutomationRun
				yield* Effect.forEach(
					held.splice(0).filter(only),
					(trigger, index) => {
						let n = 0
						return handle(trigger).pipe(
							Effect.provideService(Aggregate.PolicyRun, {
								next: () => `late-view:${index}:${n++}`,
							}),
						)
					},
					{ discard: true },
				)
			}),
	}
}

const run = <A, E, R>(
	platform: ReturnType<typeof InMemory.make>,
	feeds: {
		readonly view: Handle
		readonly aggregate?: (handle: Handle) => Handle
	},
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
					OpenAutomationRunLive,
					ArmAutomationLive,
					EnsureAutomationArmedLive,
					StartAutomationRun.toLayer(Effect.succeed(feeds.view)),
					EnsureAutomationRunStarted.toLayer(
						Effect.map(startAutomationRun, (handle) =>
							feeds.aggregate === undefined ? handle : feeds.aggregate(handle),
						),
					),
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
	yield* TestClock.setTime(T0)
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

const moveToSecondAgent = Effect.flatMap(UpdateAutomationDecision, (updates) =>
	updates.send(
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
	),
)

const runsRecorded = Effect.gen(function* () {
	const runs = yield* AutomationRunView
	const page = yield* runs.list(Automation.ref(automationId), { take: 10 })
	return page.entries.map(({ event }) =>
		event._tag === "automation.run_started"
			? { run: event.run, outcome: "started", agent_id: event.agent_id }
			: { run: event.run, outcome: event.error.type, agent_id: event.agent_id },
	)
})

const sessionOfRun = (run: number) =>
	Effect.flatMap(SessionView, (sessions) =>
		Effect.map(
			Effect.orDie(sessions.get(Session.ref(sessionIdOfNextRun(automationId, run - 1)))),
			Option.getOrNull,
		),
	)

describe("OpenAutomationRun", () => {
	it.effect(
		"reports a run that reached it before its predecessor, once the predecessor is reported",
		() => {
			const { platform, settle, advance } = clocked()
			const late = viewFeedHeld()
			return run(
				platform,
				{
					view: late.hold,
					aggregate: (handle) => (trigger) =>
						trigger.event.run === 1 ? Effect.void : handle(trigger),
				},
				Effect.gen(function* () {
					const domain = yield* CheckfuDomainApi.clientInProcess
					yield* setUp
					yield* settle
					yield* domain.RunAutomation({ automation_id: automationId })
					yield* settle
					yield* domain.RunAutomation({ automation_id: automationId })
					yield* settle
					expect(yield* runsRecorded).toEqual([])
					yield* late.release((trigger) => trigger.event.run === 1)
					yield* settle
					yield* advance(31 * 1000)
					expect((yield* runsRecorded).map(({ run, outcome }) => ({ run, outcome }))).toEqual([
						{ run: 1, outcome: "started" },
						{ run: 2, outcome: "started" },
					])
					expect(platform.control.failures).toEqual([])
				}),
			)
		},
	)

	it.effect(
		"keeps the agent it opened the run's session with when a later delivery reads another",
		() => {
			const { platform, settle } = clocked()
			const late = viewFeedHeld()
			return run(
				platform,
				{ view: late.hold },
				Effect.gen(function* () {
					const domain = yield* CheckfuDomainApi.clientInProcess
					yield* setUp
					yield* settle
					yield* domain.RunAutomation({ automation_id: automationId })
					yield* settle
					yield* moveToSecondAgent
					yield* settle
					yield* late.release(() => true)
					yield* settle
					expect(yield* runsRecorded).toEqual([
						{ run: 1, outcome: "started", agent_id: "agent_first" },
					])
					expect(yield* sessionOfRun(1)).toMatchObject({ agent_id: "agent_first" })
					expect(platform.control.failures).toEqual([])
				}),
			)
		},
	)

	it.effect("opens no session for a refused run when a later delivery finds a usable agent", () => {
		const { platform, settle } = clocked()
		const late = viewFeedHeld()
		return run(
			platform,
			{ view: late.hold },
			Effect.gen(function* () {
				const domain = yield* CheckfuDomainApi.clientInProcess
				yield* setUp
				yield* settle
				yield* domain.ArchiveAgent({ agent_id: AgentId.make("agent_first") })
				yield* settle
				yield* domain.RunAutomation({ automation_id: automationId })
				yield* settle
				yield* moveToSecondAgent
				yield* settle
				yield* late.release(() => true)
				yield* settle
				expect(yield* runsRecorded).toEqual([
					{ run: 1, outcome: "agent_unavailable", agent_id: "agent_first" },
				])
				expect(yield* sessionOfRun(1)).toBeNull()
				expect(platform.control.failures).toEqual([])
			}),
		)
	})

	it.effect(
		"counts a session already at the run's id as its own when it has the run's agent, environment and title",
		() => {
			const { platform, settle } = clocked()
			const late = viewFeedHeld()
			return run(
				platform,
				{ view: late.hold },
				Effect.gen(function* () {
					const domain = yield* CheckfuDomainApi.clientInProcess
					const sessions = yield* Session
					yield* setUp
					yield* settle
					yield* sessions.import(
						Session.ref(sessionIdOfNextRun(automationId, 0)),
						[
							new SessionCreated({
								agent_id: "agent_first",
								agent_version: 1,
								environment_id: "env_delivery",
								title: "Report",
							}),
						],
						{ commandId: "opened-before-the-deploy" },
					)
					yield* settle
					yield* domain.RunAutomation({ automation_id: automationId })
					yield* settle
					expect(yield* runsRecorded).toEqual([
						{ run: 1, outcome: "started", agent_id: "agent_first" },
					])
					expect(platform.control.failures).toEqual([])
				}),
			)
		},
	)
})
