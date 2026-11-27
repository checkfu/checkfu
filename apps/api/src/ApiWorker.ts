import { SessionPreviewSource } from "./Http/SessionPreviewSource.ts"
import { fileURLToPath } from "node:url"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Vaults, VaultsHandlersLive } from "@checkfu/domain/Vaults.model"
import * as Alchemy from "alchemy"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Cause from "effect/Cause"
import * as Digest from "effect/crypto/Digest"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Scope from "effect/Scope"
import { Checkfu, CheckfuHandlersLive } from "@checkfu/domain/Checkfu.model"
import { Webhooks, WebhooksHandlersLive } from "@checkfu/domain/Webhooks.model"
import { COMPATIBILITY_DATE, TRACE_SAMPLING_RATE } from "./Compatibility.ts"
import {
	ConnectionCallFailed,
	ConnectionExecutor,
	CredentialSecretsLive,
} from "./Connection/CredentialCustody.ts"
import { ApiWorker } from "./Api.ts"
import { customDomains } from "./CustomDomain.ts"
import { OutputsSaverLive } from "./Files/OutputsSaverLive.ts"
import { ArtifactBytesLive } from "./Artifacts/ArtifactBytesLive.ts"
import { ArtifactObjectsLive, ArtifactStoreR2 } from "./Artifacts/ArtifactObjects.do.ts"
import { FileBytesLive } from "./Files/FileBytesLive.ts"
import { FileObjectsLive, FileStoreR2 } from "./Files/FileObjects.do.ts"
import { ArtifactVersionResolver } from "./Artifacts/ResolveArtifactVersion.ts"
import { PublicationResolver } from "./Artifacts/ResolvePublication.ts"
import { ArtifactLinksLive } from "./Content/ArtifactLinks.ts"
import { D1ListingStore } from "./D1ListingStore.ts"
import { ViewEventsOverObjectSockets } from "./Http/ObjectSocketEvents.ts"
import { WebhookListingQueryLive, vaultListingQueriesFrom } from "./Http/Listing.ts"
import { HealthTracerDisabledWhen, makeApiHandler } from "./Http/Router.ts"
import { apiWorkerCustomProvidersProps } from "./Pi/PiCatalog.ts"
import { CustomToolFaults } from "./Http/ToolSchemas.ts"
import { PiDurableHarnessLive, PiTurnExecutor, harnessCall } from "./Pi/PiDurableHarness.ts"
import { PiHarnessWorker, TURN_CODE_UPDATE_STRATEGY } from "./Pi/PiHarness.ts"
import { PlacedDurableObjects } from "./PlacedDurableObjects.ts"
import { WebhookDelivererLive, WebhookDeliveryStoreDo } from "./Webhooks/WebhookDeliverer.do.ts"
import { WebhookEventsLive } from "./Webhooks/WebhookEventsLive.ts"
import { WebhookFanoutContinuationDo, WebhookFanoutLive } from "./Webhooks/WebhookFanout.do.ts"
import { WebhookSigningMasterKeyLive } from "./Webhooks/WebhookSigning.ts"
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
			listOutputs: (sessionId, turn) =>
				harnessCall(Effect.suspend(() => harness.listOutputs(sessionId, turn))).pipe(
					Effect.withSpan("PiHarness.listOutputs"),
				),
			readOutputs: (sessionId, turn, files) =>
				harnessCall(Effect.suspend(() => harness.readOutputs(sessionId, turn, files))).pipe(
					Effect.withSpan("PiHarness.readOutputs"),
				),
			pauseUsage: (conversation, operationId, pause) =>
				harnessCall(
					Effect.suspend(() => harness.pauseUsage(conversation, operationId, pause)),
				).pipe(Effect.withSpan("PiHarness.pauseUsage")),
			answerCall: (conversation, toolUseId, answer) =>
				harnessCall(Effect.suspend(() => harness.answerCall(conversation, toolUseId, answer))).pipe(
					Effect.withSpan("PiHarness.answerCall"),
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

const FileStoreLive = FileStoreR2.pipe(
	Layer.provide(FileObjectsLive),
	Layer.provide([Cloudflare.R2.ReadBucketBinding, Cloudflare.R2.ReadWriteBucketBinding]),
)

const connectionCall = <A, E, R>(
	call: Effect.Effect<A, E, R>,
): Effect.Effect<A, ConnectionCallFailed, R> =>
	Effect.catchCause(call, (cause): Effect.Effect<never, ConnectionCallFailed> =>
		Cause.hasInterruptsOnly(cause)
			? Effect.interrupt
			: Effect.fail(new ConnectionCallFailed({ cause })),
	)

const ConnectionExecutorLive = Layer.effect(
	ConnectionExecutor,
	Effect.gen(function* () {
		const harness = yield* Cloudflare.Workers.bindWorker(PiHarnessWorker)
		return {
			put: (vaultId, credentialId, secret, target, mode) =>
				connectionCall(
					Effect.suspend(() => harness.putSecret(vaultId, credentialId, secret, target, mode)),
				).pipe(Effect.withSpan("Connection.put")),
			erase: (vaultId, credentialId) =>
				connectionCall(Effect.suspend(() => harness.eraseSecret(vaultId, credentialId))).pipe(
					Effect.withSpan("Connection.erase"),
				),
			seal: (vaultId) =>
				connectionCall(Effect.suspend(() => harness.sealVault(vaultId))).pipe(
					Effect.withSpan("Connection.seal"),
				),
			usable: (vaultId, credentialId) =>
				connectionCall(Effect.suspend(() => harness.secretUsable(vaultId, credentialId))).pipe(
					Effect.withSpan("Connection.usable"),
				),
		}
	}),
)

const CustomToolFaultsLive = Layer.effect(
	CustomToolFaults,
	Effect.gen(function* () {
		const harness = yield* Cloudflare.Workers.bindWorker(PiHarnessWorker)
		return (tools, taken) =>
			harnessCall(Effect.suspend(() => harness.customToolFaults(tools, taken))).pipe(
				Effect.mapError(() => ({ _tag: "CustomToolsUncheckable" as const })),
				Effect.withSpan("PiHarness.customToolFaults"),
			)
	}),
)

const ListingLive = D1ListingStore.pipe(Layer.provide(Cloudflare.D1.QueryDatabaseBinding))

const WebhooksLive = Webhooks.layer(WebhooksHandlersLive.pipe(Layer.provide(ListingLive)), {
	legacyData: false,
}).pipe(Layer.provide(PlacedDurableObjects))

const WebhookListingLive = WebhookListingQueryLive.pipe(Layer.provide(WebhooksLive))

const WebhookMasterKeyLive = WebhookSigningMasterKeyLive

const WebhookDeliveriesLive = WebhookDeliveryStoreDo.pipe(
	Layer.provide(
		WebhookDelivererLive.pipe(
			Layer.provide(WebhooksLive),
			Layer.provide(WebhookMasterKeyLive),
			Layer.provide(Mac.layerWebCrypto),
			Layer.provide(SecureRandom.layerWebCrypto),
		),
	),
)

const WebhookFanoutRuntimeLive = WebhookFanoutContinuationDo.pipe(
	Layer.provide(
		WebhookFanoutLive.pipe(
			Layer.provide(ListingLive),
			Layer.provide(WebhooksLive),
			Layer.provide(WebhookDeliveriesLive),
			Layer.provide(Digest.layerWebCrypto),
			Layer.provide(SecureRandom.layerWebCrypto),
		),
	),
)

const WebhookEventsRuntimeLive = WebhookEventsLive.pipe(
	Layer.provide(ListingLive),
	Layer.provide(WebhooksLive),
	Layer.provide(WebhookDeliveriesLive),
	Layer.provide(WebhookFanoutRuntimeLive),
	Layer.provide(Digest.layerWebCrypto),
)

const CheckfuLive = Checkfu.layer(
	CheckfuHandlersLive.pipe(
		Layer.provide(PiDurableHarnessLive),
		Layer.provide(OutputsSaverLive),
		Layer.provide(ArtifactBytesLive),
		Layer.provide(FileBytesLive),
		Layer.provide(ListingLive),
		Layer.provide(WebhookEventsRuntimeLive),
	),
	{ legacyData: false },
).pipe(
	Layer.provide(PiHarnessExecutorLive),
	Layer.provide(PlacedDurableObjects),
	Layer.provide(ArtifactStoreLive),
	Layer.provide(FileStoreLive),
)

const VaultsLive = Vaults.layer(
	VaultsHandlersLive.pipe(Layer.provide(ListingLive), Layer.provide(WebhookEventsRuntimeLive)),
	{
		legacyData: false,
	},
).pipe(
	Layer.provideMerge(CredentialSecretsLive),
	Layer.provide(ConnectionExecutorLive),
	Layer.provide(PlacedDurableObjects),
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

const PiPreviewSourceLive = Layer.effect(
	SessionPreviewSource,
	Effect.map(
		Cloudflare.Workers.bindWorker(PiHarnessWorker),
		(harness) => (id: string) => harness.watchPreviews(id),
	),
)

const ApiWorkerLive = Layer.mergeAll(
	WebhooksLive,
	WebhookListingLive,
	WebhookDeliveriesLive,
	WebhookMasterKeyLive,
	PiPreviewSourceLive,
	VaultsLive,
	vaultListingQueriesFrom(VaultsLive),
	CheckfuLive,
	ArtifactStoreLive,
	FileStoreLive,
	CustomToolFaultsLive,
	Layer.succeed(ViewEventsOverObjectSockets, true),
	ArtifactLinksLive.pipe(Layer.provide(Mac.layerWebCrypto)),
	HarnessLive,
	Cloudflare.Telemetry({ headSamplingRate: TRACE_SAMPLING_RATE }),
	Alchemy.Telemetry.layer(HealthTracerDisabledWhen),
	Mac.layerWebCrypto,
).pipe(
	Layer.provideMerge(SkillReaderLive),
	Layer.provideMerge(Digest.layerWebCrypto),
	Layer.provideMerge(SecureRandom.layerWebCrypto),
)

export const API_WORKER_PROPS = {
	main: import.meta.url,
	compatibility: {
		date: COMPATIBILITY_DATE,
		flags: ["global_fetch_strictly_public"],
	},
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
		const { apiWorkerWebhookEgressProps } = yield* Effect.promise(
			() => import("./Webhooks/WebhookEgressConfig.ts"),
		)
		const webhookEgressProps = yield* apiWorkerWebhookEgressProps
		const mergedEnv = {
			...customCatalogProps.env,
			...webhookEgressProps.env,
		}
		return {
			...API_WORKER_PROPS,
			...api,
			...(Object.keys(mergedEnv).length === 0 ? {} : { env: mergedEnv }),
		}
	}),
	Effect.gen(function* () {
		const scope = Option.getOrUndefined(yield* Effect.serviceOption(Scope.Scope))
		if (scope === undefined) {
			return yield* Effect.die(new Error("ApiWorker requires an owning instance Scope."))
		}
		const services = yield* Layer.buildWithScope(ApiWorkerLive, scope)
		const handler = yield* makeApiHandler.pipe(
			Scope.provide(scope),
			Effect.provide(services),
			Effect.provideService(RuntimeContext, yield* Cloudflare.Worker),
		)
		const memory = yield* SessionMemoryAccess.pipe(Effect.provide(services))
		const artifacts = yield* SessionArtifactAccess.pipe(Effect.provide(services))
		const saves = yield* Effect.cached(
			Effect.promise(() => import("./SessionArtifactSaves.ts")).pipe(
				Effect.flatMap(({ SessionArtifactSaves }) => SessionArtifactSaves),
				Effect.provide(services),
			),
		)
		return ApiWorker.of({
			...handler,
			resolveArtifactVersion: yield* ArtifactVersionResolver.pipe(Effect.provide(services)),
			resolvePublication: yield* PublicationResolver.pipe(Effect.provide(services)),
			memoryMounts: (sessionId) => Effect.orDie(memory.memoryMounts(sessionId)),
			memoryList: (sessionId, name, after) =>
				Effect.orDie(memory.memoryList(sessionId, name, after)),
			memoryStat: (sessionId, name, path) => Effect.orDie(memory.memoryStat(sessionId, name, path)),
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
			sessionFileSave: (sessionId, turn, path, bytes) =>
				Effect.flatMap(saves, (loaded) => loaded.sessionFileSave(sessionId, turn, path, bytes)),
			sessionArtifactSave: (sessionId, name, entries) =>
				Effect.flatMap(saves, (loaded) => loaded.sessionArtifactSave(sessionId, name, entries)),
		})
	}),
)
