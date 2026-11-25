import type { ApiError } from "@checkfu/sdk/Api"
import {
	apiErrorStatus,
	isApiErrorEnvelope,
	isTransientHttpError,
	isTransientHttpStatus,
} from "@checkfu/sdk/Errors"
import type { ApiErrorEnvelope } from "@checkfu/sdk/Errors"
import * as Data from "effect/Data"
import * as Sse from "effect/encoding/Sse"
import * as HttpClientError from "effect/http/HttpClientError"
import * as Predicate from "effect/Predicate"
import * as Runtime from "effect/Runtime"
import * as Schema from "effect/Schema"

export { apiErrorStatus, isApiErrorEnvelope, isTransientHttpError, isTransientHttpStatus }
export type { ApiErrorEnvelope }

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

export const ACTION_REQUIRED_EXIT_CODE = 3

export const actionRequired = (message: string): CliFailure =>
	new CliFailure({ message, exitCode: ACTION_REQUIRED_EXIT_CODE })

export const apiFailure = (status: number, type: string, message: string): CliFailure =>
	new CliFailure({ message: `API error (${status} ${type}): ${message}`, exitCode: 1 })

const PRINTABLE_REQUEST_ID = /^[\w-]{1,128}$/
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
	const requestId =
		error.request_id !== undefined && PRINTABLE_REQUEST_ID.test(error.request_id)
			? ` [request_id: ${error.request_id}]`
			: ""
	return apiFailure(status, error.error.type, `${error.error.message}${detail}${requestId}`)
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
