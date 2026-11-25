import * as Effect from "effect/Effect"
import { RecordToolCall, RecordToolResult } from "./RecordToolCall.command.ts"
import { segmentKey } from "./RunTurn.saga.ts"
import { Session } from "./Session.aggregate.ts"
import type { SessionId } from "./Session.id.ts"
import type { ToolCall, ToolEvent, ToolResult } from "./SessionTypes.ts"

export {
	boundToolEvents,
	toolUseId,
	toolUseOf,
	turnCalls,
	type McpToolOf,
	type ToolEventBounds,
	type TranscriptToolResult,
	type TranscriptToolUse,
	type TurnCalls,
} from "./ToolEventBounds.ts"

export const toolCallCommandId = (toolUseId: string): string => `tool:call:${toolUseId}`

export const toolResultCommandId = (toolUseId: string): string => `tool:result:${toolUseId}`

export type ToolRecord =
	| { readonly type: "call"; readonly call: ToolCall }
	| { readonly type: "result"; readonly result: ToolResult }

export const toolRecordsOf = (events: ReadonlyArray<ToolEvent>): Array<ToolRecord> => {
	const records: Array<ToolRecord> = []
	for (const [index, event] of events.entries()) {
		if (event.type === "tool_result") {
			const use = events[index - 1]
			if (use?.type !== "tool_use" || use.tool_use_id !== event.tool_use_id) {
				records.push({ type: "result", result: event })
			}
			continue
		}
		const result = events[index + 1]
		if (result?.type !== "tool_result" || result.tool_use_id !== event.tool_use_id) {
			continue
		}
		records.push({
			type: "call",
			call: {
				tool_use_id: event.tool_use_id,
				name: event.name,
				input: event.input,
				...(event.truncated === true ? { input_truncated: true as const } : {}),
				...(event.mcp_server_name === undefined ? {} : { mcp_server_name: event.mcp_server_name }),
				...(event.evaluated_permission === undefined
					? {}
					: { evaluated_permission: event.evaluated_permission }),
				content: result.content,
				is_error: result.is_error,
				...(result.truncated === true ? { result_truncated: true as const } : {}),
				...(result.rejected === undefined ? {} : { rejected: result.rejected }),
			},
		})
	}
	return records
}

export const toolCallsOf = (events: ReadonlyArray<ToolEvent>): Array<ToolCall> =>
	toolRecordsOf(events).flatMap((record) => (record.type === "call" ? [record.call] : []))

export const recordToolEvents = Effect.fn("Session.recordToolEvents")(function* (args: {
	readonly session_id: SessionId
	readonly turn: number
	readonly segment?: number
	readonly events: ReadonlyArray<ToolEvent>
}) {
	const sessions = yield* Session
	const segment = args.segment ?? 1
	const requestId = `${segmentKey(args.session_id, args.turn, segment)}:req:${segment}`
	yield* Effect.forEach(
		toolRecordsOf(args.events),
		(record) => {
			const request = {
				session_id: args.session_id,
				turn: args.turn,
				model_request_start_id: requestId,
			}
			return record.type === "call"
				? sessions.send(new RecordToolCall({ ...request, call: record.call }), {
						commandId: toolCallCommandId(record.call.tool_use_id),
					})
				: sessions.send(new RecordToolResult({ ...request, result: record.result }), {
						commandId: toolResultCommandId(record.result.tool_use_id),
					})
		},
		{ discard: true },
	).pipe(
		Effect.catchTag(
			["UnknownModelRequest", "SessionNotFound", "SessionNotRunning", "StaleTurn"],
			() => Effect.void,
		),
	)
})
