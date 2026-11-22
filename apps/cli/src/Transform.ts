import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as YAML from "yaml"
import { escapeTerminalControlCharacters, stringifyTerminalSafeJson } from "./TerminalOutput.ts"

export const OUTPUT_FORMATS = ["auto", "json", "jsonl", "yaml", "pretty", "raw"] as const
export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

export const normalizeJsonValue = (value: unknown): unknown => {
	if (DateTime.isDateTime(value)) return DateTime.formatIso(value)
	if (Array.isArray(value)) return value.map((item) => normalizeJsonValue(item))
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {}
		for (const [key, entry] of Object.entries(value)) {
			if (entry !== undefined) {
				out[key] = normalizeJsonValue(entry)
			}
		}
		return out
	}
	return value
}

const splitTopLevel = (input: string, delimiter: string): Array<string> => {
	const parts: Array<string> = []
	let current = ""
	let braceDepth = 0
	let bracketDepth = 0
	let inQuote: "'" | '"' | null = null
	let escaped = false

	for (let i = 0; i < input.length; i++) {
		const ch = input[i] ?? ""
		if (escaped) {
			current += ch
			escaped = false
			continue
		}
		if (ch === "\\") {
			current += ch
			escaped = true
			continue
		}
		if (inQuote !== null) {
			current += ch
			if (ch === inQuote) inQuote = null
			continue
		}
		if (ch === '"' || ch === "'") {
			inQuote = ch
			current += ch
			continue
		}
		if (ch === "{") {
			braceDepth++
			current += ch
			continue
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--
			current += ch
			continue
		}
		if (ch === "[") {
			bracketDepth++
			current += ch
			continue
		}
		if (ch === "]") {
			if (bracketDepth > 0) bracketDepth--
			current += ch
			continue
		}
		if (ch === delimiter && braceDepth === 0 && bracketDepth === 0) {
			parts.push(current)
			current = ""
			continue
		}
		current += ch
	}
	if (current.length > 0 || parts.length > 0) {
		parts.push(current)
	}
	return parts
}

const unescapeSegment = (segment: string): string => {
	const trimmed = segment.trim()
	if (
		trimmed.length >= 2 &&
		((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
			(trimmed.startsWith("'") && trimmed.endsWith("'")))
	) {
		return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\'", "'")
	}
	return trimmed.replaceAll("\\.", ".")
}

const evaluateObjectLiteral = (value: unknown, body: string): Record<string, unknown> => {
	const result: Record<string, unknown> = {}
	for (const rawEntry of splitTopLevel(body, ",")) {
		const entry = rawEntry.trim()
		if (entry.length === 0) continue
		const colonIndex = findTopLevelColon(entry)
		if (colonIndex === -1) {
			const segments = splitTopLevel(entry, ".")
			const last = segments.at(-1) ?? entry
			const key = unescapeSegment(last)
			result[key] = evaluateTransform(value, entry)
		} else {
			const key = unescapeSegment(entry.slice(0, colonIndex))
			const expr = entry.slice(colonIndex + 1).trim()
			result[key] = evaluateTransform(value, expr)
		}
	}
	return result
}

const findTopLevelColon = (input: string): number => {
	let braceDepth = 0
	let bracketDepth = 0
	let inQuote: "'" | '"' | null = null
	let escaped = false
	for (let i = 0; i < input.length; i++) {
		const ch = input[i] ?? ""
		if (escaped) {
			escaped = false
			continue
		}
		if (ch === "\\") {
			escaped = true
			continue
		}
		if (inQuote !== null) {
			if (ch === inQuote) inQuote = null
			continue
		}
		if (ch === '"' || ch === "'") {
			inQuote = ch
			continue
		}
		if (ch === "{") braceDepth++
		else if (ch === "}" && braceDepth > 0) braceDepth--
		else if (ch === "[") bracketDepth++
		else if (ch === "]" && bracketDepth > 0) bracketDepth--
		else if (ch === ":" && braceDepth === 0 && bracketDepth === 0) return i
	}
	return -1
}

const evaluateSegments = (value: unknown, segments: ReadonlyArray<string>): unknown => {
	let current: unknown = value
	for (let i = 0; i < segments.length; i++) {
		if (current === null || current === undefined) return undefined
		const rawSegment = segments[i] ?? ""
		const segment = unescapeSegment(rawSegment)
		const rest = segments.slice(i + 1)

		if (segment === "@this" || segment.length === 0) continue

		if (segment.startsWith("{") && segment.endsWith("}")) {
			current = evaluateObjectLiteral(current, segment.slice(1, -1))
			continue
		}
		if (segment.startsWith("[") && segment.endsWith("]")) {
			current = splitTopLevel(segment.slice(1, -1), ",")
				.map((item) => item.trim())
				.filter((item) => item.length > 0)
				.map((item) => evaluateTransform(current, item))
			continue
		}

		if (segment === "#") {
			if (!Array.isArray(current)) return undefined
			if (rest.length === 0) return current.length
			const projected: Array<unknown> = []
			for (const element of current) {
				const mapped = evaluateSegments(element, rest)
				if (mapped !== undefined) projected.push(mapped)
			}
			return projected
		}

		if (Array.isArray(current)) {
			if (/^-?\d+$/.test(segment)) {
				const rawIndex = Number(segment)
				const idx = rawIndex < 0 ? current.length + rawIndex : rawIndex
				current = idx >= 0 && idx < current.length ? current[idx] : undefined
				continue
			}
			return undefined
		}

		if (typeof current === "object") {
			current = (current as Record<string, unknown>)[segment]
			continue
		}

		return undefined
	}
	return current
}

export const evaluateTransform = (value: unknown, expression: string): unknown => {
	const trimmed = expression.trim()
	if (trimmed.length === 0) return value
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		return evaluateObjectLiteral(value, trimmed.slice(1, -1))
	}
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return splitTopLevel(trimmed.slice(1, -1), ",")
			.map((item) => item.trim())
			.filter((item) => item.length > 0)
			.map((item) => evaluateTransform(value, item))
	}
	const segments = splitTopLevel(trimmed, ".")
	return evaluateSegments(value, segments)
}

export interface FormatOptions {
	readonly format: OutputFormat
	readonly transform: Option.Option<string>
	readonly rawOutput: boolean
	readonly isTerminal: boolean
	readonly streaming?: boolean
}

export const formatOutput = (value: unknown, options: FormatOptions): string => {
	const normalized = normalizeJsonValue(value)
	const transformed = Option.isSome(options.transform)
		? evaluateTransform(normalized, options.transform.value)
		: normalized

	const effectiveFormat =
		options.format === "auto"
			? options.streaming === true
				? "jsonl"
				: options.isTerminal
					? "pretty"
					: "json"
			: options.format

	if (options.rawOutput || effectiveFormat === "raw") {
		if (typeof transformed === "string") {
			return options.isTerminal ? escapeTerminalControlCharacters(transformed) : transformed
		}
		if (transformed === undefined) return ""
		if (transformed === null) return "null"
		if (typeof transformed === "number" || typeof transformed === "boolean") {
			return String(transformed)
		}
		return stringifyTerminalSafeJson(transformed)
	}

	const serializable = transformed === undefined ? null : transformed
	if (effectiveFormat === "yaml") {
		const doc = new YAML.Document(serializable)
		if (options.streaming === true && doc.directives !== undefined) {
			doc.directives.docStart = true
		}
		const rendered = doc.toString().replace(/\r?\n$/, "")
		return options.isTerminal ? escapeTerminalControlCharacters(rendered) : rendered
	}
	if (effectiveFormat === "pretty") {
		return stringifyTerminalSafeJson(serializable, 2)
	}
	return stringifyTerminalSafeJson(serializable)
}
