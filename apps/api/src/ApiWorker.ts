import { fileURLToPath } from "node:url"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Scope from "effect/Scope"
import { Checkfu, CheckfuHandlersLive } from "@checkfu/domain/Checkfu.model"
import { COMPATIBILITY_DATE, TRACE_SAMPLING_RATE } from "./Compatibility.ts"
import { ApiWorker } from "./Api.ts"
import { customDomains } from "./CustomDomain.ts"
import { D1ListingStore } from "./D1ListingStore.ts"
import { ViewEventsOverObjectSockets } from "./Http/ObjectSocketEvents.ts"
import { HealthTracerDisabledWhen, makeApiHandler } from "./Http/Router.ts"
import { PiDurableHarnessLive, PiTurnExecutor, harnessCall } from "./Pi/PiDurableHarness.ts"
import { PiHarnessWorker, TURN_CODE_UPDATE_STRATEGY } from "./Pi/PiHarness.ts"
import { PlacedDurableObjects } from "./PlacedDurableObjects.ts"
import { SessionMemoryAccess } from "./SessionMemoryAccess.ts"

const PiHarnessExecutorLive = Layer.effect(
	PiTurnExecutor,
	Effect.gen(function* () {
		const harness = yield* Cloudflare.Workers.bindWorker(PiHarnessWorker)
		return {
			recoverTurn: (conversation, operationId) =>
				harnessCall(Effect.suspend(() => harness.recoverTurn(conversation, operationId))).pipe(
					Effect.withSpan("PiHarness.recoverTurn"),
				),
			runTurn: (conversation, request) =>
				harnessCall(Effect.suspend(() => harness.runTurn(conversation, request))).pipe(
					Effect.withSpan("PiHarness.runTurn"),
				),
			abortTurn: (conversation, operationId) =>
				harnessCall(Effect.suspend(() => harness.abortTurn(conversation, operationId))).pipe(
					Effect.asVoid,
					Effect.withSpan("PiHarness.abortTurn"),
				),
			enterWorkspace: (sessionId, token) =>
				harnessCall(Effect.suspend(() => harness.enterWorkspace(sessionId, token))).pipe(
					Effect.withSpan("PiHarness.enterWorkspace"),
				),
			prepareWorkspace: (sessionId, token, repositories, allowedHosts) =>
				harnessCall(
					Effect.suspend(() =>
						harness.prepareWorkspace(sessionId, token, repositories, allowedHosts),
					),
				).pipe(Effect.withSpan("PiHarness.prepareWorkspace")),
			storeRepositoryToken: (sessionId, resourceId, token, replace) =>
				harnessCall(
					Effect.suspend(() => harness.storeRepositoryToken(sessionId, resourceId, token, replace)),
				).pipe(Effect.withSpan("PiHarness.storeRepositoryToken")),
			discardWorkspace: (sessionId) =>
				harnessCall(Effect.suspend(() => harness.discardWorkspace(sessionId))).pipe(
					Effect.withSpan("PiHarness.discardWorkspace"),
				),
		}
	}),
)

const CheckfuLive = Checkfu.layer(
	CheckfuHandlersLive.pipe(
		Layer.provide(PiDurableHarnessLive),
		Layer.provide(D1ListingStore),
		Layer.provide(Cloudflare.D1.QueryDatabaseBinding),
	),
).pipe(Layer.provide(PiHarnessExecutorLive), Layer.provide(PlacedDurableObjects))

// The HTTP layer hands repository tokens to the same harness the session policies use.
const HarnessLive = PiDurableHarnessLive.pipe(
	Layer.provide(PiHarnessExecutorLive),
	Layer.provide(CheckfuLive),
)

const ApiWorkerLive = Layer.mergeAll(
	CheckfuLive,
	Layer.succeed(ViewEventsOverObjectSockets, true),
	HarnessLive,
	Cloudflare.Telemetry({ headSamplingRate: TRACE_SAMPLING_RATE }),
	Alchemy.Telemetry.layer(HealthTracerDisabledWhen),
).pipe(Layer.provideMerge(Digest.layerWebCrypto), Layer.provideMerge(SecureRandom.layerWebCrypto))

export const API_WORKER_PROPS = {
	main: import.meta.url,
	compatibility: { date: COMPATIBILITY_DATE },
	codeUpdateStrategy: TURN_CODE_UPDATE_STRATEGY,
	// The generated OpenAPI document is a static asset: GET /openapi.json is served without
	// running the Worker, and the document is not part of the code every isolate loads.
	// Resolved from this module, like `main`, so Alchemy finds it from any working directory.
	assets: fileURLToPath(new URL("../public", import.meta.url)),
	observability: {
		// Keep top-level Workers Observability enabled when adding `issues`, since
		// providing `observability` bypasses Alchemy's DEFAULT_OBSERVABILITY fallback.
		enabled: true,
		issues: { enabled: true },
	},
} satisfies Cloudflare.WorkerProps

export default ApiWorker.make(
	Effect.map(customDomains, ({ api }) => ({ ...API_WORKER_PROPS, ...api })),
	Effect.gen(function* () {
		// Platform pins the owning instance/build Scope onto the Worker init context.
		// Building both the domain/telemetry layers and the HTTP router in that scope
		// keeps them alive across requests and runs their finalizers when disposed.
		const scope = Option.getOrUndefined(yield* Effect.serviceOption(Scope.Scope))
		if (scope === undefined) {
			return yield* Effect.die(new Error("ApiWorker requires an owning instance Scope."))
		}
		const services = yield* Layer.buildWithScope(ApiWorkerLive, scope)
		const handler = yield* makeApiHandler.pipe(Scope.provide(scope), Effect.provide(services))
		// The session workspaces in the harness Worker reach their memory stores through these.
		const memory = yield* SessionMemoryAccess.pipe(Effect.provide(services))
		return ApiWorker.of({
			...handler,
			memoryMounts: (sessionId) => Effect.orDie(memory.memoryMounts(sessionId)),
			memoryList: (sessionId, name) => Effect.orDie(memory.memoryList(sessionId, name)),
			memoryRead: (sessionId, name, path) => Effect.orDie(memory.memoryRead(sessionId, name, path)),
			memoryWrite: (sessionId, name, path, content, precondition, mutationId) =>
				Effect.orDie(memory.memoryWrite(sessionId, name, path, content, precondition, mutationId)),
			memoryRemove: (sessionId, name, path, expected, mutationId) =>
				Effect.orDie(memory.memoryRemove(sessionId, name, path, expected, mutationId)),
		})
	}),
)
