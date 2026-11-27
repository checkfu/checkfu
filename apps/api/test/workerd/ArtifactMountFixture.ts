import * as Cloudflare from "@alchemy.run/cloudflare"
import { InMemory } from "@alchemy.run/domain/InMemory"
import * as Domain from "@alchemy.run/domain"
import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import { SessionView } from "@checkfu/domain/Session/SessionView.view"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import {
	ArtifactStoreError,
	artifactBlobKey,
	artifactManifestKey,
	artifactReads,
} from "../../src/Artifacts/ArtifactStore.ts"
import { makeArtifactStoreMemory } from "../../src/Artifacts/ArtifactStoreMemory.ts"
import { COMPATIBILITY_DATE } from "../../src/Compatibility.ts"
import {
	measureMountReads,
	mountFixtureArtifactId,
	mountFixtureBlobHash,
	mountFixtureBytes,
	mountFixtureManifest,
	mountFixturePinHash,
	mountReadCases,
	mountReadChunkBytes,
} from "../helpers/ArtifactMountMeasurements.ts"

import { measureStaging, qualifyConditionalPut } from "./ArtifactStagingMeasurement.ts"

export class ArtifactMountTestWorker extends Cloudflare.Worker<
	ArtifactMountTestWorker,
	Record<never, never>
>()("ArtifactMountTestWorker") {}

class MountFixtureModel extends Domain.Model("MountFixture", {
	aggregates: [Artifact, Session],
	views: [SessionView],
}) {}

const services = Layer.mergeAll(
	MountFixtureModel.layer(Layer.empty),
	makeArtifactStoreMemory().layer,
).pipe(Layer.provide(InMemory), Layer.provide(SecureRandom.layerWebCrypto))

export default ArtifactMountTestWorker.make(
	{ main: import.meta.url, compatibility: { date: COMPATIBILITY_DATE }, dev: { port: 1390 } },
	Effect.gen(function* () {
		const bucket = yield* Cloudflare.R2.ReadWriteBucket(
			yield* Cloudflare.R2.Bucket("ArtifactMountFixtureBucket", { forceDestroy: true }),
		)
		return {
			fetch: Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				const path = new URL(request.url, "http://fixture.test").pathname
				if (path === "/health") {
					return HttpServerResponse.empty({ status: 200 })
				}
				if (path === "/staging/qualify") {
					return HttpServerResponse.jsonUnsafe(yield* qualifyConditionalPut(bucket))
				}
				const [, route, fileCount, distribution, strategy, extra] = path.split("/")
				if (
					route === "staging" &&
					(fileCount === "2" || fileCount === "64") &&
					(distribution === "cold" || distribution === "warm" || distribution === "mixed") &&
					(strategy === "head" || strategy === "conditional") &&
					extra === undefined
				) {
					return HttpServerResponse.jsonUnsafe(
						yield* measureStaging(bucket, Number(fileCount), distribution, strategy),
					)
				}
				const index = Number(path.slice(1))
				const measurement = String(index) === path.slice(1) ? mountReadCases[index] : undefined
				if (measurement === undefined) {
					return HttpServerResponse.empty({ status: 404 })
				}
				const [, size, files] = measurement
				const scope = `fixture-${size}-${files}`
				const blob = artifactBlobKey(scope, mountFixtureArtifactId, mountFixtureBlobHash)
				const manifest = artifactManifestKey(scope, mountFixtureArtifactId, mountFixturePinHash)
				if ((yield* bucket.head(manifest)) === null) {
					const bytes = Stream.range(0, Math.ceil(size / mountReadChunkBytes) - 1, 1).pipe(
						Stream.map((chunk) => {
							const offset = chunk * mountReadChunkBytes
							return mountFixtureBytes(offset, Math.min(mountReadChunkBytes, size - offset))
						}),
					)
					yield* bucket.put(blob, bytes, { contentLength: size })
					yield* bucket.put(manifest, JSON.stringify(mountFixtureManifest(size, files)))
				}
				const runtime = yield* RuntimeContext
				const reader = artifactReads(scope, bucket, (effect) =>
					effect.pipe(
						Effect.mapError((cause) => new ArtifactStoreError({ cause })),
						Effect.provideService(RuntimeContext, runtime),
					),
				)
				const samples = yield* measureMountReads(measurement, reader).pipe(Effect.provide(services))
				return HttpServerResponse.jsonUnsafe(samples)
			}),
		}
	}).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
)
