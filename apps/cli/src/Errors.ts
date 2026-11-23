import type { ApiError, ErrorStatus } from "@checkfu/api/Http/Api"
import * as Data from "effect/Data"
import * as Sse from "effect/encoding/Sse"
import * as HttpClientError from "effect/http/HttpClientError"
import * as Predicate from "effect/Predicate"
import * as Runtime from "effect/Runtime"
import * as Schema from "effect/Schema"

export class CliFailure extends Data.TaggedError("CliFailure")<{
	readonly message: string
	readonly exitCode: number
}> {
	override readonly [Runtime.errorReported] = false
	override get [Runtime.errorExitCode](): number {
		return this.exitCode
	}
}

export const isCliFailure = (value: unknown): value is CliFailure =>
	Predicate.isTagged(value, "CliFailure") &&
	"message" in value &&
	typeof value.message === "string" &&
	"exitCode" in value &&
	typeof value.exitCode === "number"

export const usageError = (message: string): CliFailure => new CliFailure({ message, exitCode: 1 })

export const configError = (message: string): CliFailure => new CliFailure({ message, exitCode: 1 })

export const networkFailure = (message: string): CliFailure =>
	new CliFailure({ message, exitCode: 1 })

export const apiFailure = (status: number, type: string, message: string): CliFailure =>
	new CliFailure({ message: `API error (${status} ${type}): ${message}`, exitCode: 1 })

const ApiErrorEnvelopeSchema = Schema.Struct({
	type: Schema.Literal("error"),
	error: Schema.Struct({
		type: Schema.Literals([
			"invalid_request_error",
			"authentication_error",
			"not_found_error",
			"conflict_error",
			"payload_too_large",
			"unsupported_media_type",
			"rate_limit_error",
			"internal_error",
			"service_unavailable",
		]),
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

const API_ERROR_STATUS_BY_TYPE: Readonly<Record<ApiError["error"]["type"], ErrorStatus>> = {
	invalid_request_error: 400,
	authentication_error: 401,
	not_found_error: 404,
	conflict_error: 409,
	payload_too_large: 413,
	unsupported_media_type: 415,
	rate_limit_error: 429,
	internal_error: 500,
	service_unavailable: 503,
}

export const apiErrorStatus = (error: ApiErrorEnvelope): ErrorStatus =>
	API_ERROR_STATUS_BY_TYPE[error.error.type]

export const formatApiErrorEnvelope = (
	error: ApiErrorEnvelope,
	observedStatus?: number,
): CliFailure => {
	const status = observedStatus ?? apiErrorStatus(error)
	const parts: Array<string> = []
	if (Array.isArray(error.accepted) && error.accepted.length > 0) {
		parts.push(`${error.accepted.length} event(s) accepted`)
	}
	if (typeof error.failed_index === "number") {
		parts.push(`failed_index=${error.failed_index}`)
	}
	if (typeof error.unconfirmed_index === "number") {
		parts.push(`unconfirmed_index=${error.unconfirmed_index}`)
	}
	const detail = parts.length > 0 ? ` (${parts.join(", ")})` : ""
	return apiFailure(status, error.error.type, `${error.error.message}${detail}`)
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

export const formatClientError = (
	error:
		| ApiError
		| HttpClientError.HttpClientError
		| Schema.SchemaError
		| Sse.SseError
		| Sse.Retry
		| CliFailure,
): CliFailure => {
	if ("_tag" in error && error._tag === "CliFailure") {
		return error
	}
	if (HttpClientError.isHttpClientError(error)) {
		const reason = error.reason
		if (reason._tag === "StatusCodeError") {
			return networkFailure(`HTTP ${reason.response.status}: ${error.message}`)
		}
		if (reason._tag === "TransportError") {
			return networkFailure(`Request failed: ${error.message}`)
		}
		return networkFailure(error.message)
	}
	if (Schema.isSchemaError(error)) {
		return networkFailure(`Response validation failed: ${error.message}`)
	}
	if ("_tag" in error && error._tag === "SseError") {
		return networkFailure(`Event stream decode failed: ${error.message}`)
	}
	if (Sse.Retry.is(error)) {
		return networkFailure("Event stream requested retry.")
	}
	return formatApiErrorEnvelope(error)
}
