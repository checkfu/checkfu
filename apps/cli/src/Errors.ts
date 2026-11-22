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
	if (typeof value !== "object" || value === null) return false
	const record = value as Record<string, unknown>
	if (record["type"] !== "error") return false
	const inner = record["error"]
	if (typeof inner !== "object" || inner === null) return false
	const innerRecord = inner as Record<string, unknown>
	return typeof innerRecord["type"] === "string" && typeof innerRecord["message"] === "string"
}

export const formatApiErrorEnvelope = (error: ApiError): CliFailure => {
	const status = statusOf(error)
	const parts: Array<string> = []
	if (error.accepted !== undefined && error.accepted.length > 0) {
		parts.push(`${error.accepted.length} event(s) accepted`)
	}
	if (error.failed_index !== undefined) {
		parts.push(`failed_index=${error.failed_index}`)
	}
	if (error.unconfirmed_index !== undefined) {
		parts.push(`unconfirmed_index=${error.unconfirmed_index}`)
	}
	const detail = parts.length > 0 ? ` (${parts.join(", ")})` : ""
	return apiFailure(status, error.error.type, `${error.error.message}${detail}`)
}

export const isTransientHttpError = (error: HttpClientError.HttpClientError): boolean => {
	const reason = error.reason
	if (reason._tag === "TransportError") return true
	if (reason._tag === "StatusCodeError") {
		const status = reason.response.status
		return status === 429 || status >= 500
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
