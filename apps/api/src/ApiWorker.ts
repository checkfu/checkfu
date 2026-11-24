import { fileURLToPath } from "node:url"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Digest from "effect/crypto/Digest"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Scope from "effect/Scope"
import { Checkfu, CheckfuHandlersLive } from "@checkfu/domain/Checkfu.model"
import { COMPATIBILITY_DATE, TRACE_SAMPLING_RATE } from "./Compatibility.ts"
import { customDomains } from "./CustomDomain.ts"
import { ArtifactObjectsLive, ArtifactStoreR2 } from "./Artifacts/ArtifactObjects.do.ts"
import { ARTIFACT_RECONCILE_CRON, reconcileArtifactWrites } from "./Artifacts/ArtifactReconcile.ts"
import { ArtifactVersionResolver } from "./Artifacts/ResolveArtifactVersion.ts"
import { ArtifactLinksLive } from "./Content/ArtifactLinks.ts"
import { ApiWorker } from "./Api.ts"
import { D1ListingStore } from "./D1ListingStore.ts"
import { ViewEventsOverObjectSockets } from "./Http/ObjectSocketEvents.ts"
import { HealthTracerDisabledWhen, makeApiHandler } from "./Http/Router.ts"
import { PiDurableHarnessLive, PiTurnExecutor, harnessCall } from "./Pi/PiDurableHarness.ts"
import { PiHarnessWorker, TURN_CODE_UPDATE_STRATEGY } from "./Pi/PiHarness.ts"
import { PlacedDurableObjects } from "./PlacedDurableObjects.ts"

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

const ApiWorkerLive = Layer.mergeAll(
	CheckfuLive,
	ArtifactStoreR2.pipe(
		Layer.provide(ArtifactObjectsLive),
		Layer.provide([Cloudflare.R2.ReadBucketBinding, Cloudflare.R2.ReadWriteBucketBinding]),
	),
	Layer.succeed(ViewEventsOverObjectSockets, true),
	ArtifactLinksLive.pipe(Layer.provide(Mac.layerWebCrypto)),
	Cloudflare.Telemetry({ headSamplingRate: TRACE_SAMPLING_RATE }),
	Alchemy.Telemetry.layer(HealthTracerDisabledWhen),
	Digest.layerWebCrypto,
).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto))

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
		yield* Cloudflare.Workers.cron(ARTIFACT_RECONCILE_CRON, () =>
			reconcileArtifactWrites.pipe(Effect.provide(services)),
		)
		const handler = yield* makeApiHandler.pipe(Scope.provide(scope), Effect.provide(services))
		return ApiWorker.of({
			...handler,
			resolveArtifactVersion: yield* ArtifactVersionResolver.pipe(Effect.provide(services)),
		})
	}).pipe(Effect.provide(Cloudflare.Workers.CronEventSourceLive)),
)
