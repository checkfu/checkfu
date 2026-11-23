import * as Cloudflare from "@alchemy.run/cloudflare"
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare"
import { SessionsHandlersLive } from "@checkfu/domain/Sessions.model"
import * as Alchemy from "alchemy"
import * as Cause from "effect/Cause"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Scope from "effect/Scope"
import { Checkfu } from "@checkfu/domain/Checkfu.model"
import { HealthTracerDisabledWhen, makeApiHandler } from "./Http/Router.ts"
import { HarnessCallFailed, PiDurableHarnessLive, PiTurnExecutor } from "./Pi/PiDurableHarness.ts"
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
				).pipe(Effect.asVoid, Effect.withSpan("PiSession.abortTurn")),
		}
	}),
)

const CheckfuLive = Checkfu.layer(
	SessionsHandlersLive.pipe(Layer.provide(PiDurableHarnessLive)),
).pipe(Layer.provide(PiSessionExecutorLive), Layer.provide(DomainCloudflare.layerDurableObjects()))

const ApiWorkerLive = Layer.mergeAll(
	CheckfuLive,
	Cloudflare.Telemetry({ headSamplingRate: 0.1 }),
	Alchemy.Telemetry.layer(HealthTracerDisabledWhen),
	Digest.layerWebCrypto,
).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto))

export const API_WORKER_PROPS = {
	main: import.meta.url,
	compatibility: {
		// >= 2026-11-17 enables request.signal by default so Effect fetch handlers
		// and SSE polling streams interrupt cleanly when clients disconnect.
		date: "2026-11-17",
	},
	// Exceed DEFAULT_TURN_TIMEOUT_MS (10m) + settle margin so deploys don't evict
	// active PiSession/RunTurn Durable Objects mid-turn.
	codeUpdateStrategy: {
		mode: "deferred" as const,
		maxDelay: "12 minutes" as const,
	},
	observability: {
		// Keep top-level Workers Observability enabled when adding `issues`, since
		// providing `observability` bypasses Alchemy's DEFAULT_OBSERVABILITY fallback.
		enabled: true,
		issues: { enabled: true },
	},
} satisfies Cloudflare.WorkerProps

export default class ApiWorker extends Cloudflare.Worker<ApiWorker>()(
	"ApiWorker",
	API_WORKER_PROPS,
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
