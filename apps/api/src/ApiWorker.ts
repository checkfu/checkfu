import * as Cloudflare from "@alchemy.run/cloudflare"
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare"
import { SessionsHandlersLive } from "@checkfu/sessions/Sessions.model"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Scope from "effect/Scope"
import { Checkfu } from "./Checkfu.model.ts"
import { makeApiHandler } from "./Http/Router.ts"
import {
	HarnessCallFailed,
	PiDurableModelProviderLive,
	PiTurnExecutor,
} from "./Pi/PiDurableModelProvider.ts"
import { PiSession } from "./Pi/PiSession.do.ts"

const harnessCall = <A, E, R>(
	call: Effect.Effect<A, E, R>,
): Effect.Effect<A, HarnessCallFailed, R> =>
	Effect.catchCause(call, (cause): Effect.Effect<never, HarnessCallFailed> =>
		Cause.hasInterruptsOnly(cause)
			? Effect.interrupt
			: Effect.fail(new HarnessCallFailed({ cause })),
	)

const PiSessionExecutorLive = Layer.effect(
	PiTurnExecutor,
	Effect.gen(function* () {
		const piSessions = yield* PiSession
		return {
			recoverTurn: (conversation, operationId) =>
				harnessCall(
					Effect.suspend(() => piSessions.getByName(conversation).recoverTurn(operationId)),
				).pipe(Effect.withSpan("PiSession.recoverTurn")),
			runTurn: (conversation, request) =>
				harnessCall(Effect.suspend(() => piSessions.getByName(conversation).runTurn(request))).pipe(
					Effect.withSpan("PiSession.runTurn"),
				),
			abortTurn: (conversation, operationId) =>
				harnessCall(
					Effect.suspend(() => piSessions.getByName(conversation).abortTurn(operationId)),
				).pipe(Effect.asVoid),
		}
	}),
)

const CheckfuLive = Checkfu.layer(
	SessionsHandlersLive.pipe(Layer.provide(PiDurableModelProviderLive)),
).pipe(Layer.provide(PiSessionExecutorLive), Layer.provide(DomainCloudflare.layerDurableObjects()))

const ApiWorkerLive = Layer.merge(CheckfuLive, Cloudflare.Telemetry({ headSamplingRate: 0.1 }))

export default class ApiWorker extends Cloudflare.Worker<ApiWorker>()(
	"ApiWorker",
	{ main: import.meta.url, compatibility: { date: "2026-11-17" } },
	Effect.gen(function* () {
		// Platform pins the owning instance/build Scope onto the Worker init context.
		// Building both the domain/telemetry layers and the HTTP router in that scope
		// keeps them alive across requests and runs their finalizers when disposed.
		const scope = Option.getOrUndefined(yield* Effect.serviceOption(Scope.Scope))
		if (scope === undefined) {
			return yield* Effect.die(new Error("ApiWorker requires an owning instance Scope."))
		}
		const services = yield* Layer.buildWithScope(ApiWorkerLive, scope)
		return yield* makeApiHandler.pipe(Scope.provide(scope), Effect.provide(services))
	}),
) {}
