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
import { ApiWorker } from "./Api.ts"
import { customDomains } from "./CustomDomain.ts"
import { ArtifactBytesLive } from "./Artifacts/ArtifactBytesLive.ts"
import { ArtifactObjectsLive, ArtifactStoreR2 } from "./Artifacts/ArtifactObjects.do.ts"
import { ArtifactVersionResolver } from "./Artifacts/ResolveArtifactVersion.ts"
import { PublicationResolver } from "./Artifacts/ResolvePublication.ts"
import { ArtifactLinksLive } from "./Content/ArtifactLinks.ts"
import { D1ListingStore } from "./D1ListingStore.ts"
import { ViewEventsOverObjectSockets } from "./Http/ObjectSocketEvents.ts"
import { HealthTracerDisabledWhen, makeApiHandler } from "./Http/Router.ts"
import { apiWorkerCustomProvidersProps } from "./Pi/PiCatalog.ts"
import { PiDurableHarnessLive, PiTurnExecutor, harnessCall } from "./Pi/PiDurableHarness.ts"
import { PiHarnessWorker, TURN_CODE_UPDATE_STRATEGY } from "./Pi/PiHarness.ts"
import { PlacedDurableObjects } from "./PlacedDurableObjects.ts"
import { SessionArtifactAccess } from "./SessionArtifactAccess.ts"
import { SessionMemoryAccess } from "./SessionMemoryAccess.ts"
import { SkillReader } from "./Skills/SkillReader.ts"

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
			interruptWorkspace: (sessionId, token) =>
				harnessCall(Effect.suspend(() => harness.interruptWorkspace(sessionId, token))).pipe(
					Effect.withSpan("PiHarness.interruptWorkspace"),
				),
			discardWorkspace: (sessionId) =>
				harnessCall(Effect.suspend(() => harness.discardWorkspace(sessionId))).pipe(
					Effect.withSpan("PiHarness.discardWorkspace"),
				),
		}
	}),
)

const ArtifactStoreLive = ArtifactStoreR2.pipe(
	Layer.provide(ArtifactObjectsLive),
	Layer.provide([Cloudflare.R2.ReadBucketBinding, Cloudflare.R2.ReadWriteBucketBinding]),
)

const CheckfuLive = Checkfu.layer(
	CheckfuHandlersLive.pipe(
		Layer.provide(PiDurableHarnessLive),
		Layer.provide(ArtifactBytesLive),
		Layer.provide(D1ListingStore),
		Layer.provide(Cloudflare.D1.QueryDatabaseBinding),
	),
).pipe(
	Layer.provide(PiHarnessExecutorLive),
	Layer.provide(PlacedDurableObjects),
	Layer.provide(ArtifactStoreLive),
)

const SkillReaderLive = Layer.effect(
	SkillReader,
	Effect.gen(function* () {
		const harness = yield* Cloudflare.Workers.bindWorker(PiHarnessWorker)
		return {
			read: (markdown: string) =>
				harnessCall(Effect.suspend(() => harness.readSkill(markdown))).pipe(
					Effect.withSpan("PiHarness.readSkill"),
					Effect.orDie,
				),
		}
	}),
)

const HarnessLive = PiDurableHarnessLive.pipe(
	Layer.provide(PiHarnessExecutorLive),
	Layer.provide(CheckfuLive),
)

const ApiWorkerLive = Layer.mergeAll(
	CheckfuLive,
	ArtifactStoreLive,
	Layer.succeed(ViewEventsOverObjectSockets, true),
	ArtifactLinksLive.pipe(Layer.provide(Mac.layerWebCrypto)),
	HarnessLive,
	Cloudflare.Telemetry({ headSamplingRate: TRACE_SAMPLING_RATE }),
	Alchemy.Telemetry.layer(HealthTracerDisabledWhen),
).pipe(
	Layer.provideMerge(SkillReaderLive),
	Layer.provideMerge(Digest.layerWebCrypto),
	Layer.provideMerge(SecureRandom.layerWebCrypto),
)

export const API_WORKER_PROPS = {
	main: import.meta.url,
	compatibility: { date: COMPATIBILITY_DATE },
	codeUpdateStrategy: TURN_CODE_UPDATE_STRATEGY,
	assets: fileURLToPath(new URL("../public", import.meta.url)),
	observability: {
		enabled: true,
		issues: { enabled: true },
	},
} satisfies Cloudflare.WorkerProps

export default ApiWorker.make(
	Effect.gen(function* () {
		const { api } = yield* customDomains
		const customCatalogProps = yield* apiWorkerCustomProvidersProps
		return { ...API_WORKER_PROPS, ...api, ...customCatalogProps }
	}),
	Effect.gen(function* () {
		const scope = Option.getOrUndefined(yield* Effect.serviceOption(Scope.Scope))
		if (scope === undefined) {
			return yield* Effect.die(new Error("ApiWorker requires an owning instance Scope."))
		}
		const services = yield* Layer.buildWithScope(ApiWorkerLive, scope)
		const handler = yield* makeApiHandler.pipe(Scope.provide(scope), Effect.provide(services))
		const memory = yield* SessionMemoryAccess.pipe(Effect.provide(services))
		const artifacts = yield* SessionArtifactAccess.pipe(Effect.provide(services))
		return ApiWorker.of({
			...handler,
			resolveArtifactVersion: yield* ArtifactVersionResolver.pipe(Effect.provide(services)),
			resolvePublication: yield* PublicationResolver.pipe(Effect.provide(services)),
			memoryMounts: (sessionId) => Effect.orDie(memory.memoryMounts(sessionId)),
			memoryList: (sessionId, name, after) =>
				Effect.orDie(memory.memoryList(sessionId, name, after)),
			memoryRead: (sessionId, name, path) => Effect.orDie(memory.memoryRead(sessionId, name, path)),
			memoryWrite: (sessionId, name, path, content, exclusive) =>
				Effect.orDie(memory.memoryWrite(sessionId, name, path, content, exclusive)),
			memoryRemove: (sessionId, name, path, expected) =>
				Effect.orDie(memory.memoryRemove(sessionId, name, path, expected)),
			artifactMounts: (sessionId) => Effect.orDie(artifacts.artifactMounts(sessionId)),
			artifactFiles: (sessionId, mountPath) =>
				Effect.orDie(artifacts.artifactFiles(sessionId, mountPath)),
			artifactRead: (sessionId, mountPath, path, offset, length) =>
				Effect.orDie(artifacts.artifactRead(sessionId, mountPath, path, offset, length)),
		})
	}),
)
