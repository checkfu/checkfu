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
	readonly use_published?: true
}

export interface ParkedCall {
	readonly task_id: number
	readonly name: string
	readonly content: ReadonlyArray<TextBlock>
	readonly is_error: boolean
	readonly content_truncated?: true
	readonly rejected?: ToolRejection
}

export type McpToolOf = (name: string) =>
	| {
			readonly server: string
			readonly tool: string
			readonly permission?: "allow" | "ask"
	  }
	| undefined

export interface TurnCalls {
	readonly admit: (taskId: number) => boolean
	readonly admitted: () => ReadonlyArray<number>
}

export const turnCalls = (): TurnCalls => {
	const places = new Set<number>()
	return {
		admit: (taskId) => {
			if (!places.has(taskId) && places.size < MAX_TOOL_CALLS_PER_TURN) {
				places.add(taskId)
			}
			return places.has(taskId)
		},
		admitted: () => [...places],
	}
}

export interface ToolEventBounds {
	readonly round: () => void
	readonly use: (call: TranscriptToolUse) => void
	readonly result: (result: TranscriptToolResult, parked?: ReadonlyArray<ParkedCall>) => void
	readonly complete: () => boolean
	readonly events: () => Array<ToolEvent>
}

const clampName = (value: string): string =>
	value.length === 0 ? "unknown" : truncateText(value, MAX_IDENTIFIER_LENGTH)

const isJsonObject = (input: Schema.Json): input is Schema.JsonObject =>
	typeof input === "object" && input !== null && !Array.isArray(input)

const asObject = (input: Schema.Json): Schema.JsonObject =>
	isJsonObject(input) ? input : { value: input }

export const boundToolEvents = (
	turn: number,
	mcpToolOf: McpToolOf = () => undefined,
	calls: TurnCalls = turnCalls(),
): ToolEventBounds => {
	let budget = MAX_TURN_TOOL_TEXT_LENGTH
	const pending = new Map<string, { readonly slot: number; readonly call: TranscriptToolUse }>()
	const settled = new Set<number>()
	let placed: ReadonlyArray<number> | undefined
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
		result: (result, parked = []) => {
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
			const published = result.use_published === true || parked.length > 0
			if (!published && !calls.admit(result.task_id)) {
				return
			}
			settled.add(result.task_id)
			const { slot, call } = reserved
			const input = asObject(call.input)
			const size = JSON.stringify(input).length
			const fits = !published && size <= Math.min(MAX_TOOL_INPUT_JSON_LENGTH, budget)
			budget -= fits ? size : 0
			const resultOf = (
				taskId: number,
				name: string,
				content: ReadonlyArray<TextBlock>,
				is_error: boolean,
				cut: true | undefined,
				rejected: ToolRejection | undefined,
			): ToolEvent => {
				let room = Math.min(MAX_TOOL_RESULT_TEXT_LENGTH, budget)
				let truncated = cut === true
				const blocks: Array<TextBlock> = []
				for (const block of content) {
					const text = truncateText(block.text, room)
					truncated ||= text.length < block.text.length
					room -= text.length
					budget -= text.length
					if (text.length > 0) {
						blocks.push({ type: "text", text })
					}
				}
				return {
					type: "tool_result",
					tool_use_id: toolUseId(turn, taskId),
					content: blocks,
					is_error,
					...(truncated ? { truncated: true as const } : {}),
					...(rejected === undefined ? {} : { rejected }),
					...(mcpToolOf(name) === undefined ? {} : { mcp: true as const }),
				}
			}
			const events: Array<ToolEvent> = []
			const mcp = mcpToolOf(call.name)
			if (!published) {
				events.push({
					type: "tool_use",
					tool_use_id: toolUseId(turn, result.task_id),
					name: clampName(mcp?.tool ?? call.name),
					input: fits ? input : {},
					...(fits && call.truncated !== true ? {} : { truncated: true as const }),
					...(mcp === undefined ? {} : { mcp_server_name: mcp.server }),
					...(mcp?.permission === "allow" ? { evaluated_permission: "allow" as const } : {}),
				})
			}
			for (const nested of parked) {
				settled.add(nested.task_id)
				events.push(
					resultOf(
						nested.task_id,
						nested.name,
						nested.content,
						nested.is_error,
						nested.content_truncated,
						nested.rejected,
					),
				)
			}
			events.push(
				resultOf(
					result.task_id,
					call.name,
					result.content,
					result.is_error,
					result.truncated,
					result.rejected,
				),
			)
			slots[slot] = events
		},
		complete: () => {
			if (pending.size > 0) {
				return false
			}
			if (placed === undefined) {
				const places = calls.admitted()
				placed = places.length >= MAX_TOOL_CALLS_PER_TURN ? places : undefined
			}
			return placed !== undefined && placed.every((taskId) => settled.has(taskId))
		},
		events: () => slots.flat(),
	}
}
