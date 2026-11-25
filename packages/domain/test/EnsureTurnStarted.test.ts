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
import { Checkfu, CheckfuDomainApi, CheckfuHandlersLive } from "../src/Checkfu.model.ts"
import { EnvironmentId } from "../src/Environment/Environment.id.ts"
import { ListingLive } from "../src/Listing/Listing.projection.ts"
import { ListingStore } from "../src/Listing/ListingStore.ts"
import { ListResourcesLive } from "../src/Listing/ListResources.query.ts"
import { BoundedAgentId, BoundedEnvironmentId } from "../src/Session/AdmitSession.command.ts"
import { EnsureTurnStartedLive } from "../src/Session/EnsureTurnStarted.policy.ts"
import { Harness } from "../src/Session/Harness.external.ts"
import { RunTurnLive } from "../src/Session/RunTurn.saga.ts"
import { Session } from "../src/Session/Session.aggregate.ts"
import { SessionId } from "../src/Session/Session.id.ts"
import { StartTurn } from "../src/Session/StartTurn.policy.ts"
import { StopModelRequestLive } from "../src/Session/StopModelRequest.policy.ts"

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

// A harness that records each turn's input; `hold` keeps the first turn open until released.
const harnessOf =
	(inputs: Array<ReadonlyArray<string>>, hold?: Deferred.Deferred<void>) =>
	(platform: ReturnType<typeof InMemory.make>) =>
		Harness.toLayer(
			Effect.succeed({
				interrupt: () => Effect.void,
				runTurn: (request: { readonly turn: number; readonly input: ReadonlyArray<string> }) =>
					Effect.gen(function* () {
						inputs.push(request.input)
						if (hold !== undefined && request.turn === 1) {
							yield* platform.control.suspended(Deferred.await(hold))
						}
						return {
							thinking: null,
							text: "ok",
							input_tokens: 1,
							output_tokens: 1,
							stop_reason: { type: "end_turn" as const },
						}
					}),
			}),
		)

// Every handler of the hosted model, with StartTurn doing nothing: as if each event reached
// it only as history while its view was rebuilding.
const withoutStartTurn = Layer.mergeAll(
	StartTurn.toLayer(Effect.succeed(() => Effect.void)),
	EnsureTurnStartedLive,
	StopModelRequestLive,
	RunTurnLive,
	ArmAutomationLive,
	StartAutomationRunLive,
	FreeAutomationSlotLive,
	ListingLive,
	ListResourcesLive,
)

const sessionId = SessionId.make("sess_ensure")

const run = <A, E, R>(
	handlers: typeof CheckfuHandlersLive,
	harness: ReturnType<typeof harnessOf>,
	body: (platform: ReturnType<typeof InMemory.make>) => Effect.Effect<A, E, R>,
) => {
	const platform = InMemory.make({ manual: true })
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
		return yield* body(platform)
	}).pipe(
		Effect.scoped,
		Effect.provide(
			Checkfu.layer(handlers.pipe(Layer.provide([harness(platform), ListingStore.memory]))).pipe(
				Layer.provide(platform.layer),
			),
		),
	)
}

describe("EnsureTurnStarted", () => {
	it.effect("runs a turn that StartTurn never saw", () => {
		const inputs: Array<ReadonlyArray<string>> = []
		return run(withoutStartTurn, harnessOf(inputs), (platform) =>
			Effect.gen(function* () {
				const domain = yield* CheckfuDomainApi.clientInProcess
				const sessions = yield* Session
				yield* domain.SendUserMessage({ session_id: sessionId, text: "first" })
				yield* settle(platform)
				expect(yield* sessions.get(sessionId)).toEqual({ _tag: "Idle", turn: 1 })
				expect(inputs).toEqual([["first"]])
				expect(platform.control.failures).toEqual([])
			}),
		)
	})

	it.effect(
		"runs the turn of a message queued behind a running turn that StartTurn never saw",
		() => {
			const inputs: Array<ReadonlyArray<string>> = []
			return Effect.flatMap(Deferred.make<void>(), (hold) =>
				run(withoutStartTurn, harnessOf(inputs, hold), (platform) =>
					Effect.gen(function* () {
						const domain = yield* CheckfuDomainApi.clientInProcess
						const sessions = yield* Session
						yield* domain.SendUserMessage({ session_id: sessionId, text: "first" })
						yield* settle(platform)
						yield* domain.SendUserMessage({ session_id: sessionId, text: "queued" })
						yield* Deferred.succeed(hold, undefined)
						yield* settle(platform)
						expect(yield* sessions.get(sessionId)).toEqual({ _tag: "Idle", turn: 2 })
						expect(inputs).toEqual([["first"], ["queued"]])
						expect(platform.control.failures).toEqual([])
					}),
				),
			)
		},
	)

	it.effect("starts each turn once when StartTurn sees it too", () => {
		const inputs: Array<ReadonlyArray<string>> = []
		return Effect.flatMap(Deferred.make<void>(), (hold) =>
			run(CheckfuHandlersLive, harnessOf(inputs, hold), (platform) =>
				Effect.gen(function* () {
					const domain = yield* CheckfuDomainApi.clientInProcess
					const sessions = yield* Session
					yield* domain.SendUserMessage({ session_id: sessionId, text: "first" })
					yield* settle(platform)
					yield* domain.SendUserMessage({ session_id: sessionId, text: "queued" })
					yield* Deferred.succeed(hold, undefined)
					yield* settle(platform)
					expect(yield* sessions.get(sessionId)).toEqual({ _tag: "Idle", turn: 2 })
					expect(inputs).toEqual([["first"], ["queued"]])
					expect(platform.control.failures).toEqual([])
				}),
			),
		)
	})
})
