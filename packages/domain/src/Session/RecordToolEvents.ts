import * as Effect from "effect/Effect"
import { RecordToolCall } from "./RecordToolCall.command.ts"
import { turnKey } from "./RunTurn.saga.ts"
import { Session } from "./Session.aggregate.ts"
import type { SessionId } from "./Session.id.ts"
import type { ToolCall, ToolEvent } from "./SessionTypes.ts"

export {
	boundToolEvents,
	toolUseId,
	toolUseOf,
	type McpToolOf,
	type ToolEventBounds,
	type TranscriptToolResult,
	type TranscriptToolUse,
} from "./ToolEventBounds.ts"

export const toolCallCommandId = (toolUseId: string): string => `tool:call:${toolUseId}`

export const toolCallsOf = (events: ReadonlyArray<ToolEvent>): Array<ToolCall> => {
	const calls: Array<ToolCall> = []
	for (const [index, use] of events.entries()) {
		const result = events[index + 1]
		if (
			use.type !== "tool_use" ||
			result?.type !== "tool_result" ||
			result.tool_use_id !== use.tool_use_id
		) {
			continue
		}
		calls.push({
			tool_use_id: use.tool_use_id,
			name: use.name,
			input: use.input,
			...(use.truncated === true ? { input_truncated: true as const } : {}),
			...(use.mcp_server_name === undefined ? {} : { mcp_server_name: use.mcp_server_name }),
			content: result.content,
			is_error: result.is_error,
			...(result.truncated === true ? { result_truncated: true as const } : {}),
			...(result.rejected === undefined ? {} : { rejected: result.rejected }),
		})
	}
	return calls
}

export const recordToolEvents = Effect.fn("Session.recordToolEvents")(function* (args: {
	readonly session_id: SessionId
	readonly turn: number
	readonly events: ReadonlyArray<ToolEvent>
}) {
	const sessions = yield* Session
	const requestId = `${turnKey(args.session_id, args.turn)}:req:1`
	yield* Effect.forEach(
		toolCallsOf(args.events),
		(call) =>
			sessions.send(
				new RecordToolCall({
					session_id: args.session_id,
					turn: args.turn,
					model_request_start_id: requestId,
					call,
				}),
				{ commandId: toolCallCommandId(call.tool_use_id) },
			),
		{ discard: true },
	).pipe(
		Effect.catchTag(
			["UnknownModelRequest", "SessionNotFound", "SessionNotRunning", "StaleTurn"],
			() => Effect.void,
		),
	)
})
