import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as YAML from "yaml"
import {
	escapeQuotedTerminalCodePoints,
	escapeTerminalControlCharacters,
	hasUnsafeTerminalCodePoint,
	stringifyTerminalSafeJson,
} from "./TerminalOutput.ts"

export const OUTPUT_FORMATS = ["auto", "json", "jsonl", "yaml", "pretty", "raw"] as const
export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

export type NormalizedPrimitive = string | number | boolean | null | undefined
export type NormalizedArray = ReadonlyArray<NormalizedValue>
export interface NormalizedObject {
	readonly [key: string]: NormalizedValue
}
export type NormalizedValue = NormalizedPrimitive | NormalizedArray | NormalizedObject
type MutableNormalizedObject = Record<string, NormalizedValue>

const isNormalizedArray = (value: NormalizedValue): value is NormalizedArray => Array.isArray(value)

const isNormalizedObject = (value: NormalizedValue): value is NormalizedObject =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const setOwnProperty = (
	target: MutableNormalizedObject,
	key: string,
	value: NormalizedValue,
): void => {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	})
}

export const normalizeJsonValue = (value: unknown): NormalizedValue => {
	if (DateTime.isDateTime(value)) {
		return DateTime.formatIso(value)
	}
	if (Array.isArray(value)) {
		return value.map((item) => normalizeJsonValue(item))
	}
	if (typeof value === "object" && value !== null) {
		const out: MutableNormalizedObject = {}
		for (const [key, entry] of Object.entries(value)) {
			if (entry !== undefined) {
				setOwnProperty(out, key, normalizeJsonValue(entry))
			}
		}
		return out
	}
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		value === null ||
		value === undefined
	) {
		return value
	}
	return String(value)
}

const evaluatePath = (
	value: NormalizedValue,
	path: ReadonlyArray<string>,
	start: number = 0,
): NormalizedValue => {
	let current = value
	for (let index = start; index < path.length; index++) {
		if (current === null || current === undefined) {
			return undefined
		}
		const segment = (path[index] ?? "").trim()
		if (segment.length === 0) {
			continue
		}
		if (segment === "#") {
			if (!isNormalizedArray(current)) {
				return undefined
			}
			return index === path.length - 1
				? current.length
				: current
						.map((item) => evaluatePath(item, path, index + 1))
						.filter((item) => item !== undefined)
		}
		if (isNormalizedArray(current)) {
			if (!/^-?\d+$/.test(segment)) {
				return undefined
			}
			const position = Number(segment)
			current = current[position < 0 ? current.length + position : position]
		} else {
			current =
				isNormalizedObject(current) && Object.hasOwn(current, segment)
					? current[segment]
					: undefined
		}
	}
	return current
}

const pathOf = (text: string): ReadonlyArray<string> => {
	const trimmed = text.trim()
	return trimmed.length === 0 ? [] : trimmed.split(".")
}

const UNSUPPORTED_SYNTAX = /[{}[\]"'\\]/

const evaluateNormalizedTransform = (
	value: NormalizedValue,
	expression: string,
): NormalizedValue => {
	const trimmed = expression.trim()
	const pick = trimmed.startsWith("{") && trimmed.endsWith("}")
	const body = pick ? trimmed.slice(1, -1) : trimmed
	if (UNSUPPORTED_SYNTAX.test(body)) {
		return undefined
	}
	const entries = (pick ? body.split(",") : [body])
		.map((entry) => entry.trim())
		.filter((entry) => !pick || entry.length > 0)
		.map((entry) => {
			const colon = pick ? entry.indexOf(":") : -1
			const path = pathOf(colon === -1 ? entry : entry.slice(colon + 1))
			return {
				key: colon === -1 ? (path.at(-1) ?? "").trim() : entry.slice(0, colon).trim(),
				path,
			}
		})
	if (entries.some((entry) => entry.path.some((segment) => segment.trim() === "@this"))) {
		return undefined
	}
	if (!pick) {
		return evaluatePath(value, entries[0]?.path ?? [])
	}
	if (value === null || value === undefined) {
		return undefined
	}
	const picked: MutableNormalizedObject = {}
	for (const entry of entries) {
		setOwnProperty(picked, entry.key, evaluatePath(value, entry.path))
	}
	return picked
}

export const evaluateTransform = (value: unknown, expression: string): NormalizedValue =>
	evaluateNormalizedTransform(normalizeJsonValue(value), expression)

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
		? evaluateNormalizedTransform(normalized, options.transform.value)
		: normalized

	const effectiveFormat =
		options.format === "auto"
			? options.streaming === true
				? "jsonl"
				: options.isTerminal
					? "pretty"
					: "json"
			: options.format

	if (options.rawOutput && typeof transformed === "string") {
		return options.isTerminal ? escapeTerminalControlCharacters(transformed) : transformed
	}

	if (effectiveFormat === "raw") {
		if (typeof transformed === "string") {
			return options.isTerminal ? escapeTerminalControlCharacters(transformed) : transformed
		}
		if (transformed === undefined) {
			return ""
		}
		if (transformed === null) {
			return "null"
		}
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
		YAML.visit(doc, {
			Scalar(_key, node) {
				if (
					typeof node.value === "string" &&
					(hasUnsafeTerminalCodePoint(node.value) || node.value.startsWith("\uFEFF"))
				) {
					node.type = YAML.Scalar.QUOTE_DOUBLE
				}
			},
		})
		const rendered = doc.toString().replace(/\r?\n$/, "")
		return escapeQuotedTerminalCodePoints(rendered)
	}
	if (effectiveFormat === "pretty") {
		return stringifyTerminalSafeJson(serializable, 2)
	}
	return stringifyTerminalSafeJson(serializable)
}
