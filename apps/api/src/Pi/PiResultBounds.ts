import type { JsonValue } from "@earendil-works/chord/json"
import { utf8ByteLength } from "@earendil-works/chord/output"
import { ToolTask, defineExtension, hook } from "@earendil-works/pi-durable"
import type { ToolExecutionResult } from "@earendil-works/pi-durable"

/** What one SQLite row of Durable Object storage holds; Pi stores a tool result as one row. */
export const STORAGE_ROW_BYTES = 2_000_000

/** Pi's `DEFAULT_MAX_BYTES`: the UTF-8 bytes of text Pi keeps of a result after this hook. */
const PI_TEXT_BYTES = 50 * 1024

/** What that text can take in the row: JSON escaping writes a control character as six bytes. */
const TEXT_RESERVE_BYTES = 6 * PI_TEXT_BYTES

/** Pi's own fields of the entry: ids, the tool's name, diagnostics, timestamps. */
const ENTRY_RESERVE_BYTES = 64 * 1024

/**
 * Serialized bytes the images and `details` of one tool result may take together: the row, less
 * what its text and Pi's own fields can take.
 */
export const RESULT_BUDGET_BYTES = STORAGE_ROW_BYTES - TEXT_RESERVE_BYTES - ENTRY_RESERVE_BYTES

type Output = NonNullable<ToolExecutionResult["output"]>
type Item = Output[number]

/** Bytes a value takes in the row: Pi stores entries as JSON text. */
export const serializedBytes = (value: unknown): number =>
	value === undefined ? 0 : utf8ByteLength(JSON.stringify(value))

const imageBytes = (output: Output): number =>
	output.reduce((sum, item) => (item.type === "image" ? sum + serializedBytes(item) + 1 : sum), 0)

const isObject = (value: JsonValue): value is Readonly<Record<string, JsonValue>> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const DETAILS_CUT: JsonValue = { truncated: true }

/**
 * `details` within `room` serialized bytes. Code mode's list every call its script made, so they
 * keep the first calls that fit and say how many they left out; any other details that do not
 * fit are replaced by a marker.
 */
export const boundResultDetails = (
	details: JsonValue | undefined,
	room: number,
): JsonValue | undefined => {
	if (details === undefined || serializedBytes(details) <= room) {
		return details
	}
	if (isObject(details) && Array.isArray(details["calls"])) {
		const calls = details["calls"]
		const frame = { ...details, calls: [] as Array<JsonValue>, omitted_calls: calls.length }
		let left = room - serializedBytes(frame)
		const kept: Array<JsonValue> = []
		for (const call of calls) {
			const size = serializedBytes(call) + 1
			if (size > left) {
				break
			}
			kept.push(call)
			left -= size
		}
		const trimmed = { ...details, calls: kept, omitted_calls: calls.length - kept.length }
		if (serializedBytes(trimmed) <= room) {
			return trimmed
		}
	}
	return DETAILS_CUT
}

const imageNote = (item: Extract<Item, { type: "image" }>, bytes: number): Item => ({
	type: "text",
	text: `[${item.mimeType} image of ${bytes} bytes left out: a tool result keeps at most ${RESULT_BUDGET_BYTES} bytes of images and details. Ask for a smaller one.]`,
})

/** Keeps images, in order, while their serialized bytes fit `room`; each one past that becomes a note. */
export const boundResultImages = (output: Output, room: number): Output => {
	let left = room
	let changed = false
	const bounded = output.map((item) => {
		if (item.type !== "image") {
			return item
		}
		const bytes = serializedBytes(item) + 1
		if (bytes <= left) {
			left -= bytes
			return item
		}
		changed = true
		return imageNote(item, bytes)
	})
	return changed ? bounded : output
}

/**
 * Bounds what Pi does not bound itself, so a tool result always fits its row. Images and
 * `details` share one budget of serialized bytes; images are for the model and `details` only
 * for UIs, so `details` give way first (their call list, then the whole of them), then images.
 */
export const boundResult = <R extends Pick<ToolExecutionResult, "output" | "details">>(
	result: R,
): R => {
	const output = result.output ?? []
	const images = imageBytes(output)
	if (images + serializedBytes(result.details) <= RESULT_BUDGET_BYTES) {
		return result
	}
	const details = boundResultDetails(result.details, Math.max(0, RESULT_BUDGET_BYTES - images))
	const bounded =
		result.output === undefined
			? undefined
			: boundResultImages(output, RESULT_BUDGET_BYTES - serializedBytes(details))
	return {
		...result,
		...(bounded === undefined ? {} : { output: bounded }),
		...(details === undefined ? {} : { details }),
	}
}

/** One hook for every tool a session has: the workspace's, code mode, MCP, API and custom tools. */
export const resultBoundsExtension = defineExtension({
	name: "checkfu.result-bounds",
	hooks: [
		hook(ToolTask, {
			afterTool: (_call, result) => {
				const bounded = boundResult(result)
				return bounded === result ? undefined : bounded
			},
		}),
	],
})
