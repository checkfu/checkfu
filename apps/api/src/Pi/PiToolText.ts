import { utf8ByteLength } from "@earendil-works/chord/output"
import type { ToolExecutionResult } from "@earendil-works/pi-durable"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

export const MODEL_TEXT_LIMITS = { maxBytes: 50 * 1024, maxLines: 2000 } as const

const NOTE_BYTES = 512

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export const looksLikeJson = (text: string): boolean => {
	const value = Option.getOrNull(decodeJson(text))
	return typeof value === "object" && value !== null
}

const lineCount = (text: string): number => {
	let lines = 1
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
		lines += 1
	}
	return lines
}

const headWithin = (text: string, maxBytes: number): string => {
	let bytes = 0
	let end = 0
	for (const char of text) {
		const size = utf8ByteLength(char)
		if (bytes + size > maxBytes) {
			break
		}
		bytes += size
		end += char.length
	}
	return text.slice(0, end)
}

const jsonNote = (what: string, size: number, unit: "bytes" | "lines"): string => {
	const limit = unit === "bytes" ? MODEL_TEXT_LIMITS.maxBytes : MODEL_TEXT_LIMITS.maxLines
	return `[${what} is ${size} ${unit} of JSON, more than the ${limit} ${unit} a tool result can show, so it is left out rather than cut. Narrow the request: filter, paginate or ask for fewer fields.]`
}

export const fitsModelText = (text: string): boolean =>
	utf8ByteLength(text) <= MODEL_TEXT_LIMITS.maxBytes &&
	lineCount(text) <= MODEL_TEXT_LIMITS.maxLines

export const boundModelText = (text: string, what: string, json?: boolean): string => {
	const bytes = utf8ByteLength(text)
	const lines = lineCount(text)
	if (bytes <= MODEL_TEXT_LIMITS.maxBytes && lines <= MODEL_TEXT_LIMITS.maxLines) {
		return text
	}
	if (json ?? looksLikeJson(text)) {
		return bytes > MODEL_TEXT_LIMITS.maxBytes
			? jsonNote(what, bytes, "bytes")
			: jsonNote(what, lines, "lines")
	}
	const room = MODEL_TEXT_LIMITS.maxBytes - NOTE_BYTES
	const kept: Array<string> = []
	let used = 0
	const inputLines = text.split("\n")
	for (const line of inputLines.slice(0, MODEL_TEXT_LIMITS.maxLines - 1)) {
		const size = utf8ByteLength(line) + 1
		if (used + size > room) {
			break
		}
		kept.push(line)
		used += size
	}
	const head = kept.length > 0 ? kept.join("\n") : headWithin(inputLines[0] ?? "", room)
	return `${head}\n[truncated: ${bytes - utf8ByteLength(head)} bytes more; narrow the request]`
}

type Output = NonNullable<ToolExecutionResult["output"]>

export const boundModelOutput = (output: Output, what: string): Output => {
	const texts = output.flatMap((item) => (item.type === "text" ? [item.text] : []))
	const joined = texts.join("\n")
	if (texts.length === 0 || fitsModelText(joined)) {
		return output
	}
	const bounded = boundModelText(joined, what)
	let placed = false
	const result: Output = []
	for (const item of output) {
		if (item.type !== "text") {
			result.push(item)
		} else if (!placed) {
			placed = true
			result.push({ type: "text", text: bounded })
		}
	}
	return result
}
