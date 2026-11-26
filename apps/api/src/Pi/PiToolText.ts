import { utf8ByteLength } from "@earendil-works/chord/output"
import type { ToolExecutionResult } from "@earendil-works/pi-durable"

export const MODEL_TEXT_LIMITS = { maxBytes: 50 * 1024, maxLines: 2000 } as const

const NOTE_BYTES = 512

export const looksLikeJson = (text: string): boolean => /^\s*[[{]/u.test(text)

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

export const jsonNote = (what: string, size: string): string =>
	`[${what} is ${size} of JSON, more than the ${MODEL_TEXT_LIMITS.maxBytes} bytes a tool result can show, so it is left out rather than cut. Narrow the request: filter, paginate or ask for fewer fields.]`

export const fitsModelText = (text: string): boolean =>
	utf8ByteLength(text) <= MODEL_TEXT_LIMITS.maxBytes &&
	lineCount(text) <= MODEL_TEXT_LIMITS.maxLines

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
