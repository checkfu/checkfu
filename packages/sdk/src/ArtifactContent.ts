import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { APIConnectionError } from "./Errors.ts"
import type { CheckfuSdkError } from "./Errors.ts"
import { joinBinaryChunks } from "./FileTransfer.ts"
import {
	ArtifactsResource,
	ArtifactsVersionsResource,
	EffectArtifactsResource,
	EffectArtifactsVersionsResource,
} from "./generated/Resources.ts"
import { MAX_ARTIFACT_FILE_BYTES } from "./Limits.ts"
import { executeUnaryPromise } from "./PromiseRuntime.ts"
import type { APIPromise, PromiseRequestOptions, PromiseSdkRuntime } from "./PromiseRuntime.ts"
import {
	decodeEndpointParams,
	executeWithRetries,
	forbidIdempotencyKey,
	snapshotRequestOptions,
	unwrapResponse,
} from "./Runtime.ts"
import type {
	AnyRequestOptions,
	EffectSdkRuntime,
	EndpointQuery,
	PathParam,
	RequestOptions,
	WithResponse,
	WithResponseRequestOptions,
} from "./Runtime.ts"

import { streamResponseBody } from "./Transport.ts"

type ArtifactId = PathParam<"artifacts", "getFileContent", "artifact_id">
type ArtifactVersion = PathParam<"artifacts", "getFileContent", "version">
type ArtifactContentQuery = EndpointQuery<"artifacts", "getFileContent">

const collectContent = <E>(stream: Stream.Stream<Uint8Array, E>) =>
	Effect.suspend(() => {
		let size = 0
		let reads = 0
		return stream.pipe(
			Stream.mapEffect(
				Effect.fn(function* (chunk) {
					reads += 1
					if (reads % 512 === 0) {
						yield* Effect.sleep("1 milli")
					}
					size += chunk.byteLength
					if (size > MAX_ARTIFACT_FILE_BYTES) {
						return yield* new APIConnectionError({
							message: "Artifact file content exceeds " + MAX_ARTIFACT_FILE_BYTES + " bytes.",
							transient: false,
						})
					}
					return chunk
				}),
			),
			Stream.filter((chunk) => chunk.byteLength > 0),
			Stream.runCollect,
			Effect.map(joinBinaryChunks),
		)
	})

class EffectArtifactFileVersions extends EffectArtifactsVersionsResource {
	readonly #runtime: EffectSdkRuntime

	constructor(runtime: EffectSdkRuntime) {
		super(runtime)
		this.#runtime = runtime
	}

	/** Download the bytes of one file in the specified immutable version. */
	content(
		artifactId: ArtifactId,
		version: ArtifactVersion,
		query: ArtifactContentQuery,
		options: WithResponseRequestOptions<never>,
	): Effect.Effect<WithResponse<Uint8Array>, CheckfuSdkError>
	content(
		artifactId: ArtifactId,
		version: ArtifactVersion,
		query: ArtifactContentQuery,
		options?: RequestOptions<never>,
	): Effect.Effect<Uint8Array, CheckfuSdkError>
	content(
		artifactId: ArtifactId,
		version: ArtifactVersion,
		query: ArtifactContentQuery,
		options?: AnyRequestOptions<never>,
	): Effect.Effect<unknown, CheckfuSdkError> {
		const runtime = this.#runtime
		const requestOptions = snapshotRequestOptions(options)
		return unwrapResponse(
			Effect.gen(function* () {
				yield* forbidIdempotencyKey("artifacts.versions.content", requestOptions)
				const { file } = query
				const params = yield* decodeEndpointParams("artifacts", "getFileContent", {
					artifact_id: artifactId,
					version,
				})
				return yield* executeWithRetries(
					runtime,
					"checkfu.artifacts.versions.content",
					"idempotent",
					requestOptions,
					() =>
						Effect.gen(function* () {
							const [, response] = yield* runtime.raw.artifacts.getFileContent({
								params,
								query: { file },
								responseMode: "decoded-and-response",
							})
							return [yield* collectContent(streamResponseBody(response)), response] as const
						}),
				)
			}),
			requestOptions,
		)
	}
}

class ArtifactFileVersions extends ArtifactsVersionsResource {
	readonly #runtime: PromiseSdkRuntime

	constructor(runtime: PromiseSdkRuntime) {
		super(runtime)
		this.#runtime = runtime
	}

	/** Download the bytes of one file in the specified immutable version. */
	content(
		artifactId: ArtifactId,
		version: ArtifactVersion,
		query: ArtifactContentQuery,
		options?: PromiseRequestOptions<never>,
	): APIPromise<Uint8Array> {
		return executeUnaryPromise(this.#runtime, options, (runtime, effectOptions) =>
			new EffectArtifactFileVersions(runtime).content(artifactId, version, query, {
				...effectOptions,
				withResponse: true,
			}),
		)
	}
}

export class EffectArtifactsWithContent extends EffectArtifactsResource {
	override readonly versions: EffectArtifactFileVersions

	constructor(runtime: EffectSdkRuntime) {
		super(runtime)
		this.versions = new EffectArtifactFileVersions(runtime)
	}
}

export class ArtifactsWithContent extends ArtifactsResource {
	override readonly versions: ArtifactFileVersions

	constructor(runtime: PromiseSdkRuntime) {
		super(runtime)
		this.versions = new ArtifactFileVersions(runtime)
	}
}
