// Hand-written file transfer methods. Forge skips `files.upload` and `files.content` (`x-forge-skip`:
// raw byte bodies), so these sit beside the generated `list`/`retrieve`/`delete` with the same retry,
// idempotency and error behavior. They are installed on `client.files` for both clients.
import * as Effect from "effect/Effect"
import * as HttpApiClient from "effect/http-api/HttpApiClient"
import * as Stream from "effect/Stream"
import { CheckfuApi } from "./Api.ts"
import type { IsoDateTimes } from "./Boundary.ts"
import { CheckfuConfigError } from "./Errors.ts"
import type { CheckfuSdkError } from "./Errors.ts"
import { MAX_FILE_BYTES } from "./Limits.ts"
import { EffectFilesResource, FilesResource } from "./generated/Resources.ts"
import { executeUnaryPromise } from "./PromiseRuntime.ts"
import type { APIPromise, PromiseRequestOptions, PromiseSdkRuntime } from "./PromiseRuntime.ts"
import {
	decodeEndpointParams,
	executeWithRetries,
	forbidIdempotencyKey,
	resolveCallIdempotencyKey,
	snapshotRequestOptions,
	unwrapResponse,
	withResolvedIdempotencyKey,
} from "./Runtime.ts"
import type {
	AnyRequestOptions,
	EffectSdkRuntime,
	EndpointQuery,
	EndpointSuccess,
	PathParam,
	RequestOptions,
	WithResponse,
	WithResponseRequestOptions,
} from "./Runtime.ts"
import { streamResponseBody } from "./Transport.ts"

export const decodeFileContentResponse = HttpApiClient.decodeResponse(CheckfuApi, {
	group: "files",
	endpoint: "content",
})

export type FileBytes = Uint8Array | ArrayBuffer | Blob

export interface UploadFileParams {
	/** The file's bytes. A file never changes after upload. */
	readonly body: FileBytes
	readonly filename: NonNullable<EndpointQuery<"files", "upload">["filename"]>
	/** Media type; inferred from the filename extension when omitted. */
	readonly content_type?: EndpointQuery<"files", "upload">["content_type"]
}

const fileTooLarge = () =>
	new CheckfuConfigError({ message: `File uploads may be at most ${MAX_FILE_BYTES} bytes.` })

const snapshotUploadBytes = (body: FileBytes) =>
	Effect.tryPromise({
		try: async () => {
			const blob = "arrayBuffer" in body
			if ((blob ? body.size : body.byteLength) > MAX_FILE_BYTES) {
				throw fileTooLarge()
			}
			const source = blob ? await body.arrayBuffer() : body
			if (source.byteLength > MAX_FILE_BYTES) {
				throw fileTooLarge()
			}
			return new Uint8Array(ArrayBuffer.isView(source) ? source : new Uint8Array(source))
		},
		catch: (cause) =>
			cause instanceof CheckfuConfigError
				? cause
				: new CheckfuConfigError({ message: "Could not read the file upload body.", cause }),
	})

export const joinBinaryChunks = (chunks: Iterable<Uint8Array>): Uint8Array => {
	const parts = [...chunks]
	const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
	let offset = 0
	for (const p of parts) {
		out.set(p, offset)
		offset += p.byteLength
	}
	return out
}

/** Effect client: `files` with `upload` and `content`. */
export class EffectFiles extends EffectFilesResource {
	readonly #rt: EffectSdkRuntime

	constructor(runtime: EffectSdkRuntime) {
		super(runtime)
		this.#rt = runtime
	}

	/** Upload one file (at most the API's file size limit). Retried only when an idempotency key is set. */
	upload(
		params: UploadFileParams,
		options: WithResponseRequestOptions,
	): Effect.Effect<WithResponse<EndpointSuccess<"files", "upload">>, CheckfuSdkError>
	upload(
		params: UploadFileParams,
		options?: RequestOptions,
	): Effect.Effect<EndpointSuccess<"files", "upload">, CheckfuSdkError>
	upload(
		params: UploadFileParams,
		options?: AnyRequestOptions,
	): Effect.Effect<unknown, CheckfuSdkError> {
		const rt = this.#rt
		const requestOptions = snapshotRequestOptions(options)
		return unwrapResponse(
			Effect.gen(function* () {
				const { body, filename, content_type } = params
				const bytes = yield* snapshotUploadBytes(body)
				const key = yield* resolveCallIdempotencyKey(rt, requestOptions)
				return yield* executeWithRetries(
					rt,
					"checkfu.files.upload",
					key !== undefined ? "idempotent" : "pre-commit-only",
					withResolvedIdempotencyKey(requestOptions, key),
					() =>
						rt.raw.files.upload({
							headers: key === undefined ? {} : { "idempotency-key": key },
							query: {
								filename,
								...(content_type === undefined ? {} : { content_type }),
							},
							payload: bytes,
							responseMode: "decoded-and-response",
						}),
				)
			}),
			requestOptions,
		)
	}

	/** Download a file's bytes. An unchanged response has zero bytes and status 304. */
	content(
		fileId: PathParam<"files", "content", "file_id">,
		options: WithResponseRequestOptions<never>,
	): Effect.Effect<WithResponse<Uint8Array>, CheckfuSdkError>
	content(
		fileId: PathParam<"files", "content", "file_id">,
		options?: RequestOptions<never>,
	): Effect.Effect<Uint8Array, CheckfuSdkError>
	content(
		fileId: PathParam<"files", "content", "file_id">,
		options?: AnyRequestOptions<never>,
	): Effect.Effect<unknown, CheckfuSdkError> {
		const rt = this.#rt
		const requestOptions = snapshotRequestOptions(options)
		return unwrapResponse(
			Effect.gen(function* () {
				yield* forbidIdempotencyKey("files.content", requestOptions)
				const params = yield* decodeEndpointParams("files", "content", { file_id: fileId })
				return yield* executeWithRetries(
					rt,
					"checkfu.files.content",
					"idempotent",
					requestOptions,
					() =>
						Effect.gen(function* () {
							const response = yield* rt.raw.files.content({
								params,
								responseMode: "response-only",
							})
							if (response.status === 304) {
								return [new Uint8Array(0), response] as const
							}
							if (response.status === 200 || response.status === 206) {
								const bytes = joinBinaryChunks(
									yield* Stream.runCollect(streamResponseBody(response)),
								)
								return [bytes, response] as const
							}
							yield* decodeFileContentResponse(response)
							return yield* new CheckfuConfigError({
								message: "Unexpected file download response.",
							})
						}),
				)
			}),
			requestOptions,
		)
	}
}

/** Promise client: `files` with `upload` and `content`. */
export class Files extends FilesResource {
	readonly #rt: PromiseSdkRuntime

	constructor(runtime: PromiseSdkRuntime) {
		super(runtime)
		this.#rt = runtime
	}

	/** Upload one file. Pass `idempotencyKey` to make retries safe. */
	upload(
		params: UploadFileParams,
		options?: PromiseRequestOptions,
	): APIPromise<IsoDateTimes<EndpointSuccess<"files", "upload">>> {
		return executeUnaryPromise(this.#rt, options, (effectRuntime, effectOpts) =>
			new EffectFiles(effectRuntime).upload(params, { ...effectOpts, withResponse: true }),
		)
	}

	/** Download a file's bytes. */
	content(
		fileId: PathParam<"files", "content", "file_id">,
		options?: PromiseRequestOptions<never>,
	): APIPromise<Uint8Array> {
		return executeUnaryPromise(this.#rt, options, (effectRuntime, effectOpts) =>
			new EffectFiles(effectRuntime).content(fileId, { ...effectOpts, withResponse: true }),
		)
	}
}
