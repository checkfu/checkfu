import { isJsonValue } from "@earendil-works/chord/json"
import type { JsonValue } from "@earendil-works/chord/json"

export const REDACTED = "[redacted]"

/**
 * Every spelling of a secret that a request can carry or an echo can return:
 * as sent, URI-encoded, form-encoded (a query parameter set through
 * `URLSearchParams`), and escaped inside a JSON string, with and without
 * escaped slashes.
 */
export const secretForms = (secret: string): ReadonlyArray<string> => {
	if (secret.length === 0) {
		return []
	}
	const json = JSON.stringify(secret).slice(1, -1)
	const forms = new Set([
		secret,
		encodeURIComponent(secret),
		new URLSearchParams({ s: secret }).toString().slice(2),
		json,
		json.replaceAll("/", String.raw`\/`),
	])
	// Longest first, so a form that contains another is replaced whole.
	return [...forms].filter((form) => form.length > 0).toSorted((a, b) => b.length - a.length)
}

export interface Scrubber {
	readonly text: (text: string) => string
	readonly value: (value: JsonValue) => JsonValue
	/** A response body, read the way its content type says, with every string scrubbed. */
	readonly body: (contentType: string | null, body: string) => string
}

/** Removes every spelling of every held secret from what leaves a connection. */
export const makeScrubber = (secrets: ReadonlyArray<string>): Scrubber => {
	const forms = [...new Set(secrets.flatMap(secretForms))].toSorted((a, b) => b.length - a.length)
	const text = (input: string): string =>
		forms.reduce((clean, form) => clean.replaceAll(form, REDACTED), input)
	const value = (input: JsonValue): JsonValue => {
		if (typeof input === "string") {
			return text(input)
		}
		if (Array.isArray(input)) {
			return input.map(value)
		}
		if (typeof input === "object" && input !== null) {
			return Object.fromEntries(
				Object.entries(input).map(([key, item]) => [text(key), value(item)]),
			)
		}
		return input
	}
	const json = (input: string): string => {
		try {
			const parsed: unknown = JSON.parse(input)
			return isJsonValue(parsed) ? JSON.stringify(value(parsed)) : text(input)
		} catch {
			return text(input)
		}
	}
	const body = (contentType: string | null, input: string): string => {
		if (forms.length === 0) {
			return input
		}
		const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? ""
		if (type === "application/json" || type.endsWith("+json")) {
			return text(json(input))
		}
		if (type === "text/event-stream") {
			return text(
				input
					.split("\n")
					.map((line) => (line.startsWith("data:") ? `data: ${json(line.slice(5).trim())}` : line))
					.join("\n"),
			)
		}
		return text(input)
	}
	return { text, value, body }
}
