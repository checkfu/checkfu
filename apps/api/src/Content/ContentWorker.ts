import * as Cloudflare from "@alchemy.run/cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Digest from "effect/crypto/Digest"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { ApiWorker, ArtifactVersionNotReady, bindApiAs } from "../Api.ts"
import type { DataAddress, DataCall } from "../Api.ts"
import { ArtifactReader, ArtifactReaderR2, ArtifactStoreError } from "../Artifacts/ArtifactStore.ts"
import { publishDomain } from "../CustomDomain.ts"
import { storageScope } from "../Placement.ts"
import { linkKey } from "./ArtifactLink.ts"
import { ArtifactLinkSecret, ContentWorker } from "./Content.ts"
import { contentRequestOf, serveContent } from "./ContentHandler.ts"
import { COMPATIBILITY_DATE } from "../Compatibility.ts"

export const CONTENT_WORKER_PROPS = {
	main: import.meta.url,
	compatibility: { date: COMPATIBILITY_DATE },
	observability: {
		enabled: true,
		logs: { enabled: true, invocationLogs: false },
		issues: { enabled: true },
	},
	dev: { port: 1341 },
} satisfies Cloudflare.WorkerProps

const ContentLive = Layer.mergeAll(
	ArtifactReaderR2.pipe(Layer.provide(Cloudflare.R2.ReadBucketBinding)),
	Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto)),
	Digest.layerWebCrypto,
)

const notReady = Schema.decodeUnknownExit(ArtifactVersionNotReady)

const apiCall = <A>(
	call: () => Effect.Effect<A, ArtifactVersionNotReady>,
): Effect.Effect<A, ArtifactStoreError | ArtifactVersionNotReady> =>
	Effect.suspend(call).pipe(
		Effect.catchCause(
			(cause): Effect.Effect<never, ArtifactStoreError | ArtifactVersionNotReady> => {
				if (Cause.hasInterruptsOnly(cause)) {
					return Effect.interrupt
				}
				const pending = Option.map(Cause.findErrorOption(cause), notReady)
				return Option.isSome(pending) && Exit.isSuccess(pending.value)
					? Effect.fail(pending.value.value)
					: Effect.fail(new ArtifactStoreError({ cause: Cause.squash(cause) }))
			},
		),
	)

export const contentWorkerProps = (domain: string | undefined) =>
	domain === undefined
		? CONTENT_WORKER_PROPS
		: { ...CONTENT_WORKER_PROPS, routes: [{ pattern: `*.${domain}/*`, zoneName: domain }] }

export default ContentWorker.make(
	Effect.map(publishDomain, contentWorkerProps),
	Effect.gen(function* () {
		const mac = yield* Mac.Mac
		const digest = yield* Digest.Digest
		const store = yield* ArtifactReader
		const scope = yield* storageScope
		const domain = yield* publishDomain
		const api = yield* bindApiAs("content", ApiWorker)
		const resolveArtifactVersion = (artifactId: string, version: number) =>
			apiCall(() => api.resolveArtifactVersion(artifactId, version))
		const resolvePublication = (address: string) => apiCall(() => api.resolvePublication(address))
		const artifactData = (address: DataAddress, call: DataCall) =>
			apiCall(() => api.artifactData(address, call))
		const secret = yield* (yield* ArtifactLinkSecret).text
		const runtime = yield* Cloudflare.Worker
		const key = yield* Effect.cached(
			Effect.flatMap(secret, (value) => linkKey(Redacted.value(value))).pipe(
				Effect.provideService(RuntimeContext, runtime),
				Effect.orDie,
			),
		)
		const nowMillis = Clock.currentTimeMillis
		return {
			fetch: Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				const serve = serveContent({
					mac,
					digest,
					key: yield* key,
					store,
					resolveArtifactVersion,
					resolvePublication,
					artifactData,
					scope,
					publishDomain: domain,
					nowMillis,
				})
				return yield* serve(contentRequestOf(request))
			}),
		}
	}).pipe(Effect.provide(ContentLive)),
)
