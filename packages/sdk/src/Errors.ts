import * as Data from "effect/Data"
import * as HttpClientError from "effect/http/HttpClientError"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { API_ERROR_TYPE_LITERALS, statusOfErrorType } from "./Api.ts"
import type { ApiError as ApiErrorEnvelopeWire, ErrorStatus } from "./Api.ts"

const ApiErrorEnvelopeSchema = Schema.Struct({
	type: Schema.Literal("error"),
	error: Schema.Struct({
		type: Schema.Literals(API_ERROR_TYPE_LITERALS),
		message: Schema.String,
	}),
	request_id: Schema.optional(Schema.String),
	accepted: Schema.optional(Schema.Array(Schema.Unknown)),
	failed_index: Schema.optional(Schema.Finite),
	unconfirmed_index: Schema.optional(Schema.Finite),
})

export type ApiErrorEnvelope = typeof ApiErrorEnvelopeSchema.Type

export const isApiErrorEnvelope: (value: unknown) => value is ApiErrorEnvelope =
	Schema.is(ApiErrorEnvelopeSchema)

export const apiErrorStatus = (error: ApiErrorEnvelope): ErrorStatus =>
	statusOfErrorType(error.error.type)

export type ApiErrorBody = ApiErrorEnvelope | string | undefined

export interface ApiStatusErrorFields<Status extends number = number> {
	readonly status: Status
	readonly message: string
	readonly errorType?: string | undefined
	readonly requestId?: string | undefined
	readonly headers?: Readonly<Record<string, string>> | undefined
	readonly body?: ApiErrorBody
	readonly accepted?: ReadonlyArray<unknown> | undefined
	readonly failedIndex?: number | undefined
	readonly unconfirmedIndex?: number | undefined
}

/**
 * The shared shape of the errors for a non-2xx response: `requestID` and `error` read the
 * response's request id and body, and `retryable` says whether the status may succeed later.
 */
const ApiStatusError = <const Tag extends string, Status extends number>(
	tag: Tag,
	retryable: (status: Status) => boolean,
) =>
	class extends Data.TaggedError(tag)<ApiStatusErrorFields<Status>> {
		get requestID(): string | undefined {
			return this.requestId
		}
		get error(): ApiErrorBody {
			return this.body
		}
		get retryable(): boolean {
			return retryable(this.status)
		}
	}

const always = () => true
const never = () => false

export class BadRequestError extends ApiStatusError<"BadRequestError", 400>(
	"BadRequestError",
	never,
) {}
export class AuthenticationError extends ApiStatusError<"AuthenticationError", 401>(
	"AuthenticationError",
	never,
) {}
export class PermissionDeniedError extends ApiStatusError<"PermissionDeniedError", 403>(
	"PermissionDeniedError",
	never,
) {}
export class NotFoundError extends ApiStatusError<"NotFoundError", 404>("NotFoundError", never) {}
export class ConflictError extends ApiStatusError<"ConflictError", 409>("ConflictError", never) {}
export class PayloadTooLargeError extends ApiStatusError<"PayloadTooLargeError", 413>(
	"PayloadTooLargeError",
	never,
) {}
export class UnsupportedMediaTypeError extends ApiStatusError<"UnsupportedMediaTypeError", 415>(
	"UnsupportedMediaTypeError",
	never,
) {}
export class UnprocessableEntityError extends ApiStatusError<"UnprocessableEntityError", 422>(
	"UnprocessableEntityError",
	never,
) {}
export class RateLimitError extends ApiStatusError<"RateLimitError", 429>(
	"RateLimitError",
	always,
) {}
export class InternalServerError extends ApiStatusError<"InternalServerError", number>(
	"InternalServerError",
	always,
) {}
export class ServiceUnavailableError extends ApiStatusError<"ServiceUnavailableError", 503>(
	"ServiceUnavailableError",
	always,
) {}
export class UnexpectedStatusError extends ApiStatusError<"UnexpectedStatusError", number>(
	"UnexpectedStatusError",
	(status) => status === 408,
) {}

export class APIConnectionError extends Data.TaggedError("APIConnectionError")<{
	readonly message: string
	readonly cause?: unknown
	readonly transient?: boolean | undefined
}> {
	get retryable(): boolean {
		return this.transient !== false
	}
}

export class APIConnectionTimeoutError extends Data.TaggedError("APIConnectionTimeoutError")<{
	readonly message: string
	readonly cause?: unknown
}> {
	get retryable(): boolean {
		return true
	}
}

export class APIUserAbortError extends Data.TaggedError("APIUserAbortError")<{
	readonly message: string
	readonly cause?: unknown
}> {
	get retryable(): boolean {
		return false
	}
}

export class PaginationCursorCycleError extends Data.TaggedError("PaginationCursorCycleError")<{
	readonly message: string
}> {
	get retryable(): boolean {
		return false
	}
}

export class CheckfuConfigError extends Data.TaggedError("CheckfuConfigError")<{
	readonly message: string
	readonly cause?: unknown
}> {
	get retryable(): boolean {
		return false
	}
}

export type CheckfuApiError =
	| BadRequestError
	| AuthenticationError
	| PermissionDeniedError
	| NotFoundError
	| ConflictError
	| PayloadTooLargeError
	| UnsupportedMediaTypeError
	| UnprocessableEntityError
	| RateLimitError
	| InternalServerError
	| ServiceUnavailableError
	| UnexpectedStatusError

export type CheckfuSdkError =
	| CheckfuApiError
	| APIConnectionError
	| APIConnectionTimeoutError
	| APIUserAbortError
	| PaginationCursorCycleError
	| CheckfuConfigError

const API_ERROR_TAGS = new Set<string>([
	"BadRequestError",
	"AuthenticationError",
	"PermissionDeniedError",
	"NotFoundError",
	"ConflictError",
	"PayloadTooLargeError",
	"UnsupportedMediaTypeError",
	"UnprocessableEntityError",
	"RateLimitError",
	"InternalServerError",
	"ServiceUnavailableError",
	"UnexpectedStatusError",
])

const SDK_ERROR_TAGS = new Set<string>([
	...API_ERROR_TAGS,
	"APIConnectionError",
	"APIConnectionTimeoutError",
	"APIUserAbortError",
	"PaginationCursorCycleError",
	"CheckfuConfigError",
])

export const isAPIError = (value: unknown): value is CheckfuApiError =>
	typeof value === "object" &&
	value !== null &&
	"_tag" in value &&
	typeof value._tag === "string" &&
	API_ERROR_TAGS.has(value._tag)

export const isCheckfuError = (value: unknown): value is CheckfuSdkError =>
	typeof value === "object" &&
	value !== null &&
	"_tag" in value &&
	typeof value._tag === "string" &&
	SDK_ERROR_TAGS.has(value._tag)

/**
 * Runtime base guard supporting `err instanceof CheckfuError` across all SDK errors.
 */
export class CheckfuError extends Error {
	static override [Symbol.hasInstance](value: unknown): value is CheckfuSdkError {
		return isCheckfuError(value)
	}
}

/**
 * Runtime base guard supporting `err instanceof APIError` across all HTTP status SDK errors.
 */
export class APIError extends CheckfuError {
	readonly status: number = 0
	readonly errorType: string | undefined = undefined
	readonly requestId: string | undefined = undefined
	readonly headers: Readonly<Record<string, string>> | undefined = undefined
	readonly body: ApiErrorBody = undefined
	readonly accepted: ReadonlyArray<unknown> | undefined = undefined
	readonly failedIndex: number | undefined = undefined
	readonly unconfirmedIndex: number | undefined = undefined

	get requestID(): string | undefined {
		return this.requestId
	}

	get error(): ApiErrorBody {
		return this.body
	}

	static override [Symbol.hasInstance](value: unknown): value is CheckfuApiError {
		return isAPIError(value)
	}
}

export const isTransientHttpStatus = (status: number): boolean =>
	status === 408 || status === 429 || status >= 500

export const isTransientHttpError = (error: HttpClientError.HttpClientError): boolean => {
	const reason = error.reason
	if (reason._tag === "TransportError") {
		return true
	}
	if (
		reason._tag === "StatusCodeError" ||
		reason._tag === "DecodeError" ||
		reason._tag === "EmptyBodyError"
	) {
		return isTransientHttpStatus(reason.response.status)
	}
	return false
}

const buildApiStatusFields = (
	status: number,
	message: string,
	options?: {
		readonly errorType?: string | undefined
		readonly requestId?: string | undefined
		readonly headers?: Readonly<Record<string, string>> | undefined
		readonly body?: ApiErrorBody
		readonly accepted?: ReadonlyArray<unknown> | undefined
		readonly failedIndex?: number | undefined
		readonly unconfirmedIndex?: number | undefined
	},
) => ({
	status,
	message,
	...(options?.errorType === undefined ? {} : { errorType: options.errorType }),
	...(options?.requestId === undefined ? {} : { requestId: options.requestId }),
	...(options?.headers === undefined ? {} : { headers: options.headers }),
	...(options?.body === undefined ? {} : { body: options.body }),
	...(options?.accepted === undefined ? {} : { accepted: options.accepted }),
	...(options?.failedIndex === undefined ? {} : { failedIndex: options.failedIndex }),
	...(options?.unconfirmedIndex === undefined
		? {}
		: { unconfirmedIndex: options.unconfirmedIndex }),
})

export const makeApiStatusError = (
	status: number,
	message: string,
	options?: {
		readonly errorType?: string | undefined
		readonly requestId?: string | undefined
		readonly headers?: Readonly<Record<string, string>> | undefined
		readonly body?: ApiErrorBody
		readonly accepted?: ReadonlyArray<unknown> | undefined
		readonly failedIndex?: number | undefined
		readonly unconfirmedIndex?: number | undefined
	},
): CheckfuApiError => {
	const base = buildApiStatusFields(status, message, options)
	switch (status) {
		case 400:
			return new BadRequestError({ ...base, status: 400 })
		case 401:
			return new AuthenticationError({ ...base, status: 401 })
		case 403:
			return new PermissionDeniedError({ ...base, status: 403 })
		case 404:
			return new NotFoundError({ ...base, status: 404 })
		case 409:
			return new ConflictError({ ...base, status: 409 })
		case 413:
			return new PayloadTooLargeError({ ...base, status: 413 })
		case 415:
			return new UnsupportedMediaTypeError({ ...base, status: 415 })
		case 422:
			return new UnprocessableEntityError({ ...base, status: 422 })
		case 429:
			return new RateLimitError({ ...base, status: 429 })
		case 503:
			return new ServiceUnavailableError({ ...base, status: 503 })
		default:
			if (status >= 500) {
				return new InternalServerError(base)
			}
			return new UnexpectedStatusError(base)
	}
}

export const fromApiErrorEnvelope = (
	envelope: ApiErrorEnvelope | ApiErrorEnvelopeWire,
	options?: {
		readonly status?: number | undefined
		readonly headers?: Readonly<Record<string, string>> | undefined
	},
): CheckfuApiError => {
	const status = options?.status ?? apiErrorStatus(envelope)
	const requestId =
		envelope.request_id ?? options?.headers?.["request-id"] ?? options?.headers?.["x-request-id"]
	return makeApiStatusError(status, envelope.error.message, {
		errorType: envelope.error.type,
		requestId,
		headers: options?.headers,
		body: envelope,
		accepted: envelope.accepted,
		failedIndex: envelope.failed_index,
		unconfirmedIndex: envelope.unconfirmed_index,
	})
}

export const mapRawClientError = (
	error: unknown,
	headers?: Readonly<Record<string, string>>,
): CheckfuSdkError => {
	if (isCheckfuError(error)) {
		return error
	}
	if (isApiErrorEnvelope(error)) {
		return fromApiErrorEnvelope(error, headers === undefined ? undefined : { headers })
	}
	if (HttpClientError.isHttpClientError(error)) {
		const reason = error.reason
		if (
			reason._tag === "StatusCodeError" ||
			((reason._tag === "DecodeError" || reason._tag === "EmptyBodyError") &&
				(reason.response.status < 200 || reason.response.status >= 300))
		) {
			const responseHeaders = reason.response.headers
			return makeApiStatusError(
				reason.response.status,
				`HTTP ${reason.response.status}: ${error.message}`,
				{
					headers: responseHeaders,
					requestId: responseHeaders["request-id"] ?? responseHeaders["x-request-id"],
				},
			)
		}
		if (reason._tag === "TransportError") {
			return new APIConnectionError({
				message: `Request failed: ${error.message}`,
				cause: error,
			})
		}
		return new APIConnectionError({
			message: error.message,
			cause: error,
		})
	}
	if (Schema.isSchemaError(error)) {
		return new APIConnectionError({
			message: `Response validation failed: ${error.message}`,
			cause: error,
			transient: false,
		})
	}
	if (Predicate.isTagged(error, "SseError")) {
		const msg =
			"message" in error && typeof error.message === "string"
				? error.message
				: "SSE decoding failed"
		return new APIConnectionError({
			message: `Event stream decode failed: ${msg}`,
			cause: error,
			transient: false,
		})
	}
	if (error instanceof Error) {
		return new APIConnectionError({
			message: error.message,
			cause: error,
		})
	}
	return new APIConnectionError({
		message: String(error),
		cause: error,
	})
}
