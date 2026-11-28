// Hand-written file transfer methods. Forge skips `files.upload` and `files.content` (`x-forge-skip`:
// raw byte bodies), so these sit beside the generated `list`/`retrieve`/`delete` with the same retry,
// idempotency and error behavior. They are installed on `client.files` for both clients.
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
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

const concat = (chunks: Iterable<Uint8Array>): Uint8Array => {
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

	/** Download a file's bytes. */
	content(
		fileId: PathParam<"files", "content", "file_id">,
		options: WithResponseRequestOptions,
	): Effect.Effect<WithResponse<Uint8Array>, CheckfuSdkError>
	content(
		fileId: PathParam<"files", "content", "file_id">,
		options?: RequestOptions,
	): Effect.Effect<Uint8Array, CheckfuSdkError>
	content(
		fileId: PathParam<"files", "content", "file_id">,
		options?: AnyRequestOptions,
	): Effect.Effect<unknown, CheckfuSdkError> {
		const rt = this.#rt
		options = snapshotRequestOptions(options)
		return unwrapResponse(
			Effect.flatMap(decodeEndpointParams("files", "content", { file_id: fileId }), (pathParams) =>
				executeWithRetries(rt, "checkfu.files.content", "idempotent", options, () =>
					Effect.flatMap(
						rt.raw.files.content({ params: pathParams, responseMode: "decoded-and-response" }),
						([stream, response]) =>
							Effect.map(
								Stream.runCollect(stream),
								(chunks): readonly [Uint8Array, HttpClientResponse.HttpClientResponse] => [
									concat(chunks),
									response,
								],
							),
					),
				),
			),
			options,
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
