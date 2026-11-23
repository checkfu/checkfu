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

const segmentsOf = (path: string): ReadonlyArray<string> =>
	path
		.split(".")
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0)

const evaluatePath = (value: NormalizedValue, path: ReadonlyArray<string>): NormalizedValue => {
	const [head, ...rest] = path
	if (head === undefined) {
		return value
	}
	if (head === "#") {
		if (!isNormalizedArray(value)) {
			return undefined
		}
		return rest.length === 0
			? value.length
			: value.map((item) => evaluatePath(item, rest)).filter((item) => item !== undefined)
	}
	if (isNormalizedArray(value)) {
		if (!/^-?\d+$/.test(head)) {
			return undefined
		}
		const index = Number(head)
		return evaluatePath(value[index < 0 ? value.length + index : index], rest)
	}
	return isNormalizedObject(value) && Object.hasOwn(value, head)
		? evaluatePath(value[head], rest)
		: undefined
}

const UNSUPPORTED_SYNTAX = /[{}[\]"'\\]/

const evaluateNormalizedTransform = (
	value: NormalizedValue,
	expression: string,
): NormalizedValue => {
	const trimmed = expression.trim()
	if (trimmed.length === 0) {
		return value
	}
	const pick = trimmed.startsWith("{") && trimmed.endsWith("}")
	const body = pick ? trimmed.slice(1, -1) : trimmed
	if (UNSUPPORTED_SYNTAX.test(body)) {
		return undefined
	}
	if (!pick) {
		return evaluatePath(value, segmentsOf(body))
	}
	if (value === null || value === undefined) {
		return undefined
	}
	const picked: MutableNormalizedObject = {}
	for (const entry of body.split(",")) {
		const colon = entry.indexOf(":")
		const path = segmentsOf(colon === -1 ? entry : entry.slice(colon + 1))
		const key = colon === -1 ? (path.at(-1) ?? "") : entry.slice(0, colon).trim()
		if (key.length > 0) {
			setOwnProperty(picked, key, evaluatePath(value, path))
		}
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
