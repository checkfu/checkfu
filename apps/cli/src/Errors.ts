import { type ApiError, statusOf } from "@checkfu/api/Http/Api"
import * as Data from "effect/Data"
import * as Sse from "effect/encoding/Sse"
import * as HttpClientError from "effect/http/HttpClientError"
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

export const usageError = (message: string): CliFailure => new CliFailure({ message, exitCode: 1 })

export const configError = (message: string): CliFailure => new CliFailure({ message, exitCode: 1 })

export const networkFailure = (message: string): CliFailure =>
	new CliFailure({ message, exitCode: 1 })

export const apiFailure = (status: number, type: string, message: string): CliFailure =>
	new CliFailure({ message: `API error (${status} ${type}): ${message}`, exitCode: 1 })

export const isApiErrorEnvelope = (value: unknown): value is ApiError => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false
	const record = value as Record<string, unknown>
	if (record["type"] !== "error") return false
	const inner = record["error"]
	if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return false
	const innerRecord = inner as Record<string, unknown>
	if (typeof innerRecord["type"] !== "string" || typeof innerRecord["message"] !== "string") {
		return false
	}
	if (typeof statusOf(record as unknown as ApiError) !== "number") {
		return false
	}
	if (record["request_id"] !== undefined && typeof record["request_id"] !== "string") {
		return false
	}
	if (record["accepted"] !== undefined && !Array.isArray(record["accepted"])) {
		return false
	}
	if (
		record["failed_index"] !== undefined &&
		(typeof record["failed_index"] !== "number" || !Number.isFinite(record["failed_index"]))
	) {
		return false
	}
	if (
		record["unconfirmed_index"] !== undefined &&
		(typeof record["unconfirmed_index"] !== "number" ||
			!Number.isFinite(record["unconfirmed_index"]))
	) {
		return false
	}
	return true
}

export const formatApiErrorEnvelope = (error: ApiError, observedStatus?: number): CliFailure => {
	const knownStatus = statusOf(error)
	const status = observedStatus ?? (typeof knownStatus === "number" ? knownStatus : 500)
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
	if (reason._tag === "TransportError") return true
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
	if (error instanceof CliFailure) return error
	if (isApiErrorEnvelope(error)) return formatApiErrorEnvelope(error)
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
	if (error instanceof Sse.SseError) {
		return networkFailure(`Event stream decode failed: ${error.message}`)
	}
	if (Sse.Retry.is(error)) {
		return networkFailure("Event stream requested retry.")
	}
	return networkFailure(String(error))
}
