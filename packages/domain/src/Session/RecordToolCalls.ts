import * as Effect from "effect/Effect"
import { RecordToolCall } from "./RecordToolCall.command.ts"
import { turnKey } from "./RunTurn.saga.ts"
import { Session } from "./Session.aggregate.ts"
import type { SessionId } from "./Session.id.ts"
import {
	MAX_IDENTIFIER_LENGTH,
	MAX_TOOL_CALLS_PER_TURN,
	MAX_TOOL_INPUT_JSON_LENGTH,
	MAX_TOOL_RESULT_TEXT_LENGTH,
	MAX_TURN_TOOL_TEXT_LENGTH,
} from "./SessionTypes.ts"
import type { TextBlock, ToolCall, ToolEvent } from "./SessionTypes.ts"
import { truncateText } from "./TextBounds.ts"

/** A call as a transcript shows it: a result always comes with its use. */
export type ReadToolCall = Exclude<ToolCall, { readonly _tag: "result" }>

type CallUse = Extract<ToolCall, { readonly _tag: "pair" }>["use"]
type CallResult = Extract<ToolCall, { readonly _tag: "pair" }>["result"]

const DIGEST_LENGTH = 16

// FNV-1a, 64 bits: synchronous and deterministic, so an id is shortened the same way on every send.
const digest = (value: string): string => {
	let hash = 0xcb_f2_9c_e4_84_22_23_25n
	for (let index = 0; index < value.length; index++) {
		hash ^= BigInt(value.charCodeAt(index))
		hash = (hash * 0x01_00_00_00_01_b3n) & 0xff_ff_ff_ff_ff_ff_ff_ffn
	}
	return hash.toString(16).padStart(DIGEST_LENGTH, "0")
}

/**
 * The id a call is published under. An id that fits is kept. A longer one keeps its start and
 * ends with a digest of the whole id, so two ids that share their first characters stay apart.
 */
export const publicToolUseId = (original: string): string =>
	original.length === 0
		? "unknown"
		: original.length <= MAX_IDENTIFIER_LENGTH
			? original
			: `${truncateText(original, MAX_IDENTIFIER_LENGTH - DIGEST_LENGTH - 1)}~${digest(original)}`

const clampName = (value: string): string =>
	value.length === 0 ? "unknown" : truncateText(value, MAX_IDENTIFIER_LENGTH)

export interface ToolCallBounds {
	/** Takes the turn's next tool event, in transcript order. */
	readonly add: (event: ToolEvent) => void
	/** True once no later event can change the calls. */
	readonly complete: () => boolean
	readonly calls: () => Array<ReadToolCall>
}

/**
 * Bounds what one turn's tool calls add to the session log, one event at a time, so a reader
 * never holds more than the bounds allow. Calls past the per-turn count are left out with their
 * results. An input or result that does not fit its own limit or the turn's remaining budget is
 * cut and marked. Results find their call by the id the transcript gave it, not the published one;
 * an id used again names a new call, and a result goes to the latest call with its id.
 */
export const boundToolCalls = (): ToolCallBounds => {
	let budget = MAX_TURN_TOOL_TEXT_LENGTH
	let awaiting = 0
	const calls: Array<{ readonly use: CallUse; result?: CallResult }> = []
	const byId = new Map<string, number>()
	return {
		add: (event) => {
			if (event.type === "tool_use" || event.type === "mcp_tool_use") {
				// A reused id names a new call: the earlier one can no longer get a result, whether
				// or not this one is kept.
				const earlier = byId.get(event.tool_use_id)
				if (earlier !== undefined) {
					byId.delete(event.tool_use_id)
					if (calls[earlier]?.result === undefined) {
						awaiting -= 1
					}
				}
				if (calls.length >= MAX_TOOL_CALLS_PER_TURN) {
					return
				}
				const size = JSON.stringify(event.input).length
				const fits = size <= Math.min(MAX_TOOL_INPUT_JSON_LENGTH, budget)
				budget -= fits ? size : 0
				byId.set(event.tool_use_id, calls.length)
				awaiting += 1
				const use = {
					tool_use_id: publicToolUseId(event.tool_use_id),
					name: clampName(event.name),
					input: fits ? event.input : {},
					...(fits ? {} : { truncated: true as const }),
				}
				calls.push({
					use:
						event.type === "tool_use"
							? { type: "tool_use", ...use }
							: {
									type: "mcp_tool_use",
									...use,
									mcp_server_name: clampName(event.mcp_server_name),
									...(event.evaluated_permission === undefined
										? {}
										: { evaluated_permission: event.evaluated_permission }),
									...(event.parent_tool_use_id === undefined
										? {}
										: { parent_tool_use_id: publicToolUseId(event.parent_tool_use_id) }),
								},
				})
				return
			}
			const index = byId.get(event.tool_use_id)
			const call = index === undefined ? undefined : calls[index]
			if (call === undefined || call.result !== undefined) {
				return
			}
			let room = Math.min(MAX_TOOL_RESULT_TEXT_LENGTH, budget)
			let truncated = false
			const content: Array<TextBlock> = []
			for (const block of event.content) {
				const text = truncateText(block.text, room)
				truncated ||= text.length < block.text.length
				room -= text.length
				budget -= text.length
				if (text.length > 0) {
					content.push({ type: "text", text })
				}
			}
			call.result = {
				type: event.type,
				tool_use_id: call.use.tool_use_id,
				content,
				is_error: event.is_error,
				...(truncated ? { truncated: true as const } : {}),
			}
			awaiting -= 1
		},
		complete: () => calls.length >= MAX_TOOL_CALLS_PER_TURN && awaiting === 0,
		calls: () =>
			calls.map(({ use, result }) =>
				result === undefined ? { _tag: "use", use } : { _tag: "pair", use, result },
			),
	}
}

export const clampToolCalls = (events: Iterable<ToolEvent>): Array<ReadToolCall> => {
	const bounds = boundToolCalls()
	for (const event of events) {
		bounds.add(event)
	}
	return bounds.calls()
}

/**
 * Publishes a turn's tool calls while its model request is still open, so they precede the
 * reply that closes it. Each call's use and result are one command, so the log never shows a
 * use without its result. Sending the same turn's calls again records nothing new. A turn that
 * is no longer live records nothing: its reply would be refused for the same reason.
 */
export const recordToolCalls = Effect.fn("Session.recordToolCalls")(function* (args: {
	readonly session_id: SessionId
	readonly turn: number
	readonly calls: ReadonlyArray<ToolCall>
}) {
	const sessions = yield* Session
	const requestId = `${turnKey(args.session_id, args.turn)}:req:1`
	const seen = new Map<string, number>()
	const named = args.calls.map((call) => {
		const name = `${call._tag}:${call._tag === "result" ? call.result.tool_use_id : call.use.tool_use_id}`
		const earlier = seen.get(name) ?? 0
		seen.set(name, earlier + 1)
		return { call, commandId: `${requestId}:tool:${name}:${earlier}` }
	})
	yield* Effect.forEach(
		named,
		({ call, commandId }) =>
			sessions.send(
				new RecordToolCall({
					session_id: args.session_id,
					turn: args.turn,
					model_request_start_id: requestId,
					call,
				}),
				{ commandId },
			),
		{ discard: true },
	).pipe(
		Effect.catchTag(
			["UnknownModelRequest", "SessionNotFound", "SessionNotRunning", "StaleTurn"],
			() => Effect.void,
		),
	)
})
