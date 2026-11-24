import { utf8ByteLength } from "@earendil-works/chord/output"
import type { ToolExecutionResult } from "@earendil-works/pi-durable"

/**
 * What Pi keeps of a result's text: its default output limits, declared on our tools so the
 * bound below them stays the one that applies.
 */
export const MODEL_TEXT_LIMITS = { maxBytes: 50 * 1024, maxLines: 2000 } as const

// Room under the limits for the note that says what was left out.
const NOTE_BYTES = 512

export const looksLikeJson = (text: string): boolean => /^\s*[[{]/u.test(text)

const lineCount = (text: string): number => {
	let lines = 1
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
		lines += 1
	}
	return lines
}

// The longest start of `text` within `maxBytes` of UTF-8, never splitting a character.
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

/** What the model gets instead of a JSON document too large to show. */
export const jsonNote = (what: string, size: string): string =>
	`[${what} is ${size} of JSON, more than the ${MODEL_TEXT_LIMITS.maxBytes} bytes a tool result can show, so it is left out rather than cut. Narrow the request: filter, paginate or ask for fewer fields.]`

export const fitsModelText = (text: string): boolean =>
	utf8ByteLength(text) <= MODEL_TEXT_LIMITS.maxBytes &&
	lineCount(text) <= MODEL_TEXT_LIMITS.maxLines

/**
 * A result's text within what Pi keeps of it, so Pi never cuts it itself. A JSON document is
 * never cut: one that does not fit is replaced by a note asking for less. Other text keeps its
 * whole first lines that fit and says how much more there was.
 */
export const boundModelText = (text: string, what: string, json = looksLikeJson(text)): string => {
	if (fitsModelText(text)) {
		return text
	}
	const bytes = utf8ByteLength(text)
	if (json) {
		return jsonNote(what, `${bytes} bytes`)
	}
	const room = MODEL_TEXT_LIMITS.maxBytes - NOTE_BYTES
	const lines = text.split("\n")
	const kept: Array<string> = []
	let used = 0
	for (const line of lines.slice(0, MODEL_TEXT_LIMITS.maxLines - 1)) {
		const size = utf8ByteLength(line) + 1
		if (used + size > room) {
			break
		}
		kept.push(line)
		used += size
	}
	const head = kept.length > 0 ? kept.join("\n") : headWithin(lines[0] ?? "", room)
	return `${head}\n[truncated: ${bytes - utf8ByteLength(head)} bytes more; narrow the request]`
}

type Output = NonNullable<ToolExecutionResult["output"]>

/** A result's text items, joined as Pi joins them, within what Pi keeps; images are left as they are. */
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
