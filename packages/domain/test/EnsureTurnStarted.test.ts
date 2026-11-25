import * as InMemory from "@alchemy.run/domain/InMemory"
import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { AgentId } from "../src/Agent/Agent.id.ts"
import { AgentVersionId } from "../src/Agent/AgentVersion.id.ts"
import { ArmAutomationLive } from "../src/Automation/ArmAutomation.policy.ts"
import { FreeAutomationSlotLive } from "../src/Automation/FreeAutomationSlot.policy.ts"
import { StartAutomationRunLive } from "../src/Automation/StartAutomationRun.policy.ts"
import { Checkfu, CheckfuDomainApi } from "../src/Checkfu.model.ts"
import type { CheckfuHandlersLive } from "../src/Checkfu.model.ts"
import { EnvironmentId } from "../src/Environment/Environment.id.ts"
import { ListingLive } from "../src/Listing/Listing.projection.ts"
import { ListingStore } from "../src/Listing/ListingStore.ts"
import { ListResourcesLive } from "../src/Listing/ListResources.query.ts"
import { BoundedAgentId, BoundedEnvironmentId } from "../src/Session/AdmitSession.command.ts"
import { EnsureTurnStarted, ensureTurnStarted } from "../src/Session/EnsureTurnStarted.policy.ts"
import { EnsureTurnStoppedLive } from "../src/Session/EnsureTurnStopped.policy.ts"
import { DEFAULT_TURN_TIMEOUT_MS, Harness } from "../src/Session/Harness.external.ts"
import { RunTurnLive } from "../src/Session/RunTurn.saga.ts"
import { Session } from "../src/Session/Session.aggregate.ts"
import { SessionId } from "../src/Session/Session.id.ts"
import { StartTurn, StartTurnLive } from "../src/Session/StartTurn.policy.ts"
import { StopModelRequest, StopModelRequestLive } from "../src/Session/StopModelRequest.policy.ts"

type Platform = ReturnType<typeof InMemory.make>

const T0 = Date.parse("2026-01-01T08:00:00.000Z")

const settle = (platform: Platform) =>
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

// Like the real harness: a run for a turn it was told to stop is refused, and a stop ends a run
// under way. Turn 1 waits for `hold`, or for its stop, before it replies.
const harnessOf = (calls: Array<string>, hold?: Deferred.Deferred<void>) => (platform: Platform) =>
	Harness.toLayer(
		Effect.sync(() => {
			const stopped = new Map<number, Deferred.Deferred<void>>()
			const stopOf = (turn: number) => {
				const found = stopped.get(turn)
				if (found !== undefined) {
					return found
				}
				const made = Deferred.makeUnsafe<void>()
				stopped.set(turn, made)
				return made
			}
			const isStopped = (turn: number) => Deferred.isDoneUnsafe(stopOf(turn))
			return {
				interrupt: ({ turn }: { readonly turn: number }) =>
					Effect.sync(() => {
						calls.push(`interrupt:${turn}`)
						Deferred.doneUnsafe(stopOf(turn), Effect.void)
					}),
				runTurn: ({ turn }: { readonly turn: number }) =>
					Effect.gen(function* () {
						if (isStopped(turn)) {
							calls.push(`refused:${turn}`)
							return yield* Effect.fail({ _tag: "TurnInterrupted" as const })
						}
						calls.push(`run:${turn}`)
						if (hold !== undefined && turn === 1) {
							yield* platform.control.suspended(
								Effect.raceFirst(Deferred.await(hold), Deferred.await(stopOf(turn))),
							)
						}
						if (isStopped(turn)) {
							return yield* Effect.fail({ _tag: "TurnInterrupted" as const })
						}
						calls.push(`reply:${turn}`)
						return {
							thinking: null,
							text: "ok",
							input_tokens: 1,
							output_tokens: 1,
							stop_reason: { type: "end_turn" as const },
						}
					}),
			}
		}),
	)

interface Handlers {
	// As if every event reached the view-fed policy only as history, while its view rebuilt.
	readonly missStartTurn?: boolean
	readonly missStopModelRequest?: boolean
	// Holds every EnsureTurnStarted delivery until released.
	readonly delayEnsure?: Deferred.Deferred<void>
}

const handlersOf =
	({ missStartTurn = false, missStopModelRequest = false, delayEnsure }: Handlers) =>
	(platform: Platform): typeof CheckfuHandlersLive =>
		Layer.mergeAll(
			missStartTurn ? StartTurn.toLayer(Effect.succeed(() => Effect.void)) : StartTurnLive,
			missStopModelRequest
				? StopModelRequest.toLayer(Effect.succeed(() => Effect.void))
				: StopModelRequestLive,
			EnsureTurnStarted.toLayer(
				Effect.map(
					ensureTurnStarted,
					(handle) => (trigger: Parameters<typeof handle>[0]) =>
						delayEnsure === undefined
							? handle(trigger)
							: Effect.andThen(
									platform.control.suspended(Deferred.await(delayEnsure)),
									handle(trigger),
								),
				),
			),
			EnsureTurnStoppedLive,
			RunTurnLive,
			ArmAutomationLive,
			StartAutomationRunLive,
			FreeAutomationSlotLive,
			ListingLive,
			ListResourcesLive,
		)

const sessionId = SessionId.make("sess_ensure")

const run = <A, E, R>(
	handlers: (platform: Platform) => typeof CheckfuHandlersLive,
	harness: (platform: Platform) => ReturnType<ReturnType<typeof harnessOf>>,
	body: (platform: Platform, clock: { now: number }) => Effect.Effect<A, E, R>,
) => {
	const clock = { now: T0 }
	const platform = InMemory.make({ manual: true, now: () => clock.now })
	return Effect.gen(function* () {
		const domain = yield* CheckfuDomainApi.clientInProcess
		yield* domain.CreateAgent({
			agent_id: AgentId.make("agent_ensure"),
			version_id: AgentVersionId.make("aver_ensure"),
			name: "Agent",
			model: { id: "gpt-4o-mini" },
			system: null,
			description: null,
		})
		yield* domain.CreateEnvironment({
			environment_id: EnvironmentId.make("env_ensure"),
			name: "Env",
			description: null,
			config: { type: "cloud", networking: { type: "unrestricted" } },
		})
		yield* domain.AdmitSession({
			session_id: sessionId,
			agent_id: BoundedAgentId.make("agent_ensure"),
			agent_version: null,
			environment_id: BoundedEnvironmentId.make("env_ensure"),
			title: null,
		})
		yield* settle(platform)
		return yield* body(platform, clock)
	}).pipe(
		Effect.scoped,
		Effect.provide(
			Checkfu.layer(
				handlers(platform).pipe(Layer.provide([harness(platform), ListingStore.memory])),
			).pipe(Layer.provide(platform.layer)),
		),
	)
}

describe("EnsureTurnStarted", () => {
	it.effect("runs a turn that StartTurn never saw", () => {
		const calls: Array<string> = []
		return run(handlersOf({ missStartTurn: true }), harnessOf(calls), (platform) =>
			Effect.gen(function* () {
				const domain = yield* CheckfuDomainApi.clientInProcess
				yield* domain.SendUserMessage({ session_id: sessionId, text: "first" })
				yield* settle(platform)
				expect(yield* (yield* Session).get(sessionId)).toEqual({ _tag: "Idle", turn: 1 })
				expect(calls).toEqual(["run:1", "reply:1"])
				expect(platform.control.failures).toEqual([])
			}),
		)
	})

	it.effect(
		"runs the turn of a message queued behind a running turn that StartTurn never saw",
		() => {
			const calls: Array<string> = []
			return Effect.flatMap(Deferred.make<void>(), (hold) =>
				run(handlersOf({ missStartTurn: true }), harnessOf(calls, hold), (platform) =>
					Effect.gen(function* () {
						const domain = yield* CheckfuDomainApi.clientInProcess
						yield* domain.SendUserMessage({ session_id: sessionId, text: "first" })
						yield* settle(platform)
						yield* domain.SendUserMessage({ session_id: sessionId, text: "queued" })
						yield* Deferred.succeed(hold, undefined)
						yield* settle(platform)
						expect(yield* (yield* Session).get(sessionId)).toEqual({ _tag: "Idle", turn: 2 })
						expect(calls).toEqual(["run:1", "reply:1", "run:2", "reply:2"])
						expect(platform.control.failures).toEqual([])
					}),
				),
			)
		},
	)

	it.effect("starts each turn once when StartTurn sees it too", () => {
		const calls: Array<string> = []
		return Effect.flatMap(Deferred.make<void>(), (hold) =>
			run(handlersOf({}), harnessOf(calls, hold), (platform) =>
				Effect.gen(function* () {
					const domain = yield* CheckfuDomainApi.clientInProcess
					yield* domain.SendUserMessage({ session_id: sessionId, text: "first" })
					yield* settle(platform)
					yield* domain.SendUserMessage({ session_id: sessionId, text: "queued" })
					yield* Deferred.succeed(hold, undefined)
					yield* settle(platform)
					expect(yield* (yield* Session).get(sessionId)).toEqual({ _tag: "Idle", turn: 2 })
					expect(calls).toEqual(["run:1", "reply:1", "run:2", "reply:2"])
					expect(platform.control.failures).toEqual([])
				}),
			),
		)
	})
})

describe("turn deadlines with a late EnsureTurnStarted delivery", () => {
	const lateDelivery = (missStartTurn: boolean) => {
		const calls: Array<string> = []
		return Effect.flatMap(
			Effect.all([Deferred.make<void>(), Deferred.make<void>()]),
			([hold, delayEnsure]) =>
				run(handlersOf({ missStartTurn, delayEnsure }), harnessOf(calls, hold), (platform, clock) =>
					Effect.gen(function* () {
						const domain = yield* CheckfuDomainApi.clientInProcess
						const sessions = yield* Session
						yield* domain.SendUserMessage({ session_id: sessionId, text: "first" })
						yield* settle(platform)
						clock.now = T0 + DEFAULT_TURN_TIMEOUT_MS - 60 * 1000
						yield* Deferred.succeed(delayEnsure, undefined)
						yield* settle(platform)
						expect(yield* sessions.get(sessionId)).toMatchObject({ _tag: "Running", turn: 1 })
						clock.now = T0 + DEFAULT_TURN_TIMEOUT_MS + 1000
						yield* settle(platform)
						expect(yield* sessions.get(sessionId)).toEqual({ _tag: "Idle", turn: 1 })
						expect(calls).not.toContain("reply:1")
						expect(platform.control.failures).toEqual([])
					}),
				),
		)
	}

	it.effect("does not move the deadline StartTurn armed", () => lateDelivery(false))

	it.effect("still ends a recovered turn on time", () => lateDelivery(true))
})

describe("EnsureTurnStopped", () => {
	it.effect(
		"honors an interrupt StopModelRequest never saw, sent before the recovered run starts",
		() => {
			const calls: Array<string> = []
			return Effect.flatMap(Deferred.make<void>(), (delayEnsure) =>
				run(
					handlersOf({ missStartTurn: true, missStopModelRequest: true, delayEnsure }),
					harnessOf(calls),
					(platform) =>
						Effect.gen(function* () {
							const domain = yield* CheckfuDomainApi.clientInProcess
							yield* domain.SendUserMessage({ session_id: sessionId, text: "first" })
							yield* domain.SendUserInterrupt({ session_id: sessionId })
							yield* settle(platform)
							yield* Deferred.succeed(delayEnsure, undefined)
							yield* settle(platform)
							expect(yield* (yield* Session).get(sessionId)).toEqual({ _tag: "Idle", turn: 1 })
							expect(calls).toEqual(["interrupt:1", "refused:1"])
							expect(platform.control.failures).toEqual([])
						}),
				),
			)
		},
	)

	it.effect(
		"honors an interrupt StopModelRequest never saw, sent while the recovered run is under way",
		() => {
			const calls: Array<string> = []
			return Effect.flatMap(Deferred.make<void>(), (hold) =>
				run(
					handlersOf({ missStartTurn: true, missStopModelRequest: true }),
					harnessOf(calls, hold),
					(platform) =>
						Effect.gen(function* () {
							const domain = yield* CheckfuDomainApi.clientInProcess
							yield* domain.SendUserMessage({ session_id: sessionId, text: "first" })
							yield* settle(platform)
							yield* domain.SendUserInterrupt({ session_id: sessionId })
							yield* settle(platform)
							expect(yield* (yield* Session).get(sessionId)).toEqual({ _tag: "Idle", turn: 1 })
							expect(calls).toEqual(["run:1", "interrupt:1"])
							expect(platform.control.failures).toEqual([])
						}),
				),
			)
		},
	)
})
