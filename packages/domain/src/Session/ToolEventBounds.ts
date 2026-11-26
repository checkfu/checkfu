import type * as Schema from "effect/Schema"
import {
	MAX_IDENTIFIER_LENGTH,
	MAX_TOOL_CALLS_PER_TURN,
	MAX_TOOL_INPUT_JSON_LENGTH,
	MAX_TOOL_RESULT_TEXT_LENGTH,
	MAX_TURN_TOOL_TEXT_LENGTH,
} from "./SessionTypes.ts"
import type { TextBlock, ToolEvent, ToolRejection } from "./SessionTypes.ts"
import { truncateText } from "./TextBounds.ts"

const TOOL_USE_ID_PREFIX = "tu"

const idNumber = (text: string | undefined): number | undefined => {
	const value = Number(text)
	return text !== undefined && Number.isSafeInteger(value) && value >= 0 && String(value) === text
		? value
		: undefined
}

export const toolUseId = (turn: number, taskId: number): string =>
	`${TOOL_USE_ID_PREFIX}_${turn}_${taskId}`

export const toolUseOf = (
	id: string,
): { readonly turn: number; readonly task_id: number } | undefined => {
	const [prefix, turnText, taskText, ...rest] = id.split("_")
	const turn = idNumber(turnText)
	const task_id = idNumber(taskText)
	return prefix === TOOL_USE_ID_PREFIX &&
		rest.length === 0 &&
		turn !== undefined &&
		task_id !== undefined
		? { turn, task_id }
		: undefined
}

export interface TranscriptToolUse {
	readonly id: string
	readonly name: string
	readonly input: Schema.Json
	readonly truncated?: true
}

export interface TranscriptToolResult {
	readonly id: string
	readonly task_id: number
	readonly content: ReadonlyArray<TextBlock>
	readonly is_error: boolean
	readonly truncated?: true
	readonly rejected?: ToolRejection
}

export interface ToolEventBounds {
	readonly round: () => void
	readonly use: (call: TranscriptToolUse) => void
	readonly result: (result: TranscriptToolResult) => void
	readonly complete: () => boolean
	readonly events: () => Array<ToolEvent>
}

const clampName = (value: string): string =>
	value.length === 0 ? "unknown" : truncateText(value, MAX_IDENTIFIER_LENGTH)

const isJsonObject = (input: Schema.Json): input is Schema.JsonObject =>
	typeof input === "object" && input !== null && !Array.isArray(input)

const asObject = (input: Schema.Json): Schema.JsonObject =>
	isJsonObject(input) ? input : { value: input }

export const boundToolEvents = (turn: number): ToolEventBounds => {
	let budget = MAX_TURN_TOOL_TEXT_LENGTH
	let published = 0
	const pending = new Map<string, { readonly slot: number; readonly call: TranscriptToolUse }>()
	const slots: Array<ReadonlyArray<ToolEvent>> = []
	const ambiguous = new Map<string, number>()
	return {
		round: () => {
			pending.clear()
			ambiguous.clear()
		},
		use: (call) => {
			const open = ambiguous.get(call.id) ?? (pending.has(call.id) ? 1 : 0)
			if (open > 0) {
				pending.delete(call.id)
				ambiguous.set(call.id, open + 1)
				return
			}
			pending.set(call.id, { slot: slots.push([]) - 1, call })
		},
		result: (result) => {
			const open = ambiguous.get(result.id)
			if (open !== undefined) {
				if (open > 1) {
					ambiguous.set(result.id, open - 1)
				} else {
					ambiguous.delete(result.id)
				}
				return
			}
			const reserved = pending.get(result.id)
			if (reserved === undefined) {
				return
			}
			pending.delete(result.id)
			if (published >= MAX_TOOL_CALLS_PER_TURN) {
				return
			}
			published += 1
			const { slot, call } = reserved
			const input = asObject(call.input)
			const size = JSON.stringify(input).length
			const fits = size <= Math.min(MAX_TOOL_INPUT_JSON_LENGTH, budget)
			budget -= fits ? size : 0
			let room = Math.min(MAX_TOOL_RESULT_TEXT_LENGTH, budget)
			let truncated = result.truncated === true
			const content: Array<TextBlock> = []
			for (const block of result.content) {
				const text = truncateText(block.text, room)
				truncated ||= text.length < block.text.length
				room -= text.length
				budget -= text.length
				if (text.length > 0) {
					content.push({ type: "text", text })
				}
			}
			const tool_use_id = toolUseId(turn, result.task_id)
			slots[slot] = [
				{
					type: "tool_use",
					tool_use_id,
					name: clampName(call.name),
					input: fits ? input : {},
					...(fits && call.truncated !== true ? {} : { truncated: true as const }),
				},
				{
					type: "tool_result",
					tool_use_id,
					content,
					is_error: result.is_error,
					...(truncated ? { truncated: true as const } : {}),
					...(result.rejected === undefined ? {} : { rejected: result.rejected }),
				},
			]
		},
		complete: () => published >= MAX_TOOL_CALLS_PER_TURN,
		events: () => slots.flat(),
	}
}
