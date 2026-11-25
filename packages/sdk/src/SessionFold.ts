import type { SessionEvent } from "./Api.ts"
import type { ToolRejection } from "./Schemas.ts"

type Body<E> = E extends unknown
	? Omit<E, "id" | "seq" | "created_at"> & { readonly seq?: number | undefined }
	: never

export type SessionFoldEvent = Body<SessionEvent>

type EventOf<T extends SessionFoldEvent["type"]> = Extract<SessionFoldEvent, { readonly type: T }>
type Use = EventOf<"agent.tool_use" | "agent.mcp_tool_use" | "agent.custom_tool_use">

export type ToolCallStatus =
	| "running"
	| "waiting"
	| "done"
	| "error"
	| "rejected"
	| "denied"
	| "cancelled"

export const TOOL_REJECTIONS = {
	unavailable: "the tool is not available",
	invalid_arguments: "its arguments were invalid",
	blocked: "it was blocked before it ran",
} satisfies Record<ToolRejection, string>

export interface ToolCallOutcome {
	readonly text: string
	readonly isError: boolean
	readonly truncated: boolean
	readonly rejected: ToolRejection | undefined
}

export type ToolCallAnswer =
	| { readonly kind: "allow" }
	| { readonly kind: "deny"; readonly message: string }
	| { readonly kind: "result"; readonly text: string; readonly isError: boolean }

export interface ToolCall {
	readonly id: string
	readonly kind: "tool" | "mcp" | "custom"
	readonly name: string
	readonly server: string | undefined
	readonly input: Use["input"]
	readonly inputTruncated: boolean
	readonly askedFirst: boolean
	readonly awaits: "confirmation" | "result"
	readonly outcome: ToolCallOutcome | undefined
	readonly answer: ToolCallAnswer | undefined
	readonly cancelled: boolean
	readonly status: ToolCallStatus
}

export type TurnState =
	| { readonly status: "running"; readonly turn: number }
	| {
			readonly status: "paused"
			readonly turn: number
			readonly seq: number | undefined
			readonly outstanding: ReadonlySet<string>
	  }
	| { readonly status: "settled"; readonly turn: number; readonly stopReason: string | undefined }

export type SessionFoldRetention = "all" | "waiting" | "none"

export interface SettledTurn {
	readonly turn: number
	readonly stopReason: string | undefined
}

export interface SessionFold {
	readonly retain: SessionFoldRetention
	readonly turn: TurnState
	readonly settled: SettledTurn
	readonly ended: boolean
	readonly calls: ReadonlyMap<string, ToolCall>
	readonly closed: ReadonlySet<string>
	readonly open: ReadonlySet<string>
	readonly early: ReadonlyMap<string, EarlyCall>
}

interface EarlyCall {
	readonly outcome?: ToolCallOutcome
	readonly answer?: ToolCallAnswer
	readonly cancelled?: true
}

const NO_IDS: ReadonlySet<string> = new Set()

export const emptySessionFold = (retain: SessionFoldRetention = "all"): SessionFold => ({
	retain,
	turn: { status: "settled", turn: 0, stopReason: undefined },
	settled: { turn: 0, stopReason: undefined },
	ended: false,
	calls: new Map(),
	closed: NO_IDS,
	open: NO_IDS,
	early: new Map(),
})

export const outstandingCalls = (fold: SessionFold): ReadonlySet<string> =>
	fold.turn.status === "paused" ? fold.turn.outstanding : NO_IDS

const textOf = (content: ReadonlyArray<{ readonly text: string }>): string =>
	content.map((block) => block.text).join("")

const asks = (use: Use): boolean =>
	use.type === "agent.custom_tool_use" ||
	(use.type === "agent.mcp_tool_use" && use.evaluated_permission === "ask")

const statusOf = (
	call: Pick<ToolCall, "outcome" | "answer" | "cancelled">,
	waiting: boolean,
): ToolCallStatus =>
	call.answer?.kind === "deny"
		? "denied"
		: call.outcome !== undefined
			? call.outcome.rejected !== undefined
				? "rejected"
				: call.outcome.isError
					? "error"
					: "done"
			: call.answer?.kind === "result"
				? call.answer.isError
					? "error"
					: "done"
				: waiting
					? "waiting"
					: call.cancelled
						? "cancelled"
						: "running"

const answered = (
	before: { readonly answer?: ToolCallAnswer | undefined } | undefined,
	patch: Pick<EarlyCall, "outcome" | "answer">,
): Pick<EarlyCall, "outcome" | "answer"> =>
	before?.answer === undefined || patch.answer === undefined
		? patch
		: { ...patch, answer: before.answer }

export const foldSessionEvents = (
	fold: SessionFold,
	events: Iterable<SessionFoldEvent>,
): SessionFold => {
	const { retain } = fold
	let turn = fold.turn
	let settled = fold.settled
	let ended = fold.ended
	let outstanding: Set<string> | undefined
	const settledBefore = (number: number) => {
		if (number - 1 > settled.turn) {
			settled = { turn: number - 1, stopReason: undefined }
		}
	}
	const calls = new Map(fold.calls)
	const closed = new Set(fold.closed)
	const open = new Set(fold.open)
	const early = new Map(fold.early)

	const waitingOn = (): Set<string> => {
		if (outstanding === undefined) {
			outstanding = new Set(turn.status === "paused" ? turn.outstanding : undefined)
		}
		return outstanding
	}
	const put = (call: Omit<ToolCall, "status">) => {
		calls.set(call.id, { ...call, status: statusOf(call, waitingOn().has(call.id)) })
	}
	const refresh = (id: string) => {
		const call = calls.get(id)
		if (call !== undefined) {
			put(call)
		}
	}
	const noteEarly = (id: string, patch: EarlyCall) => {
		if (retain === "all") {
			early.set(id, { ...early.get(id), ...patch })
		}
	}
	const close = (id: string, patch: Pick<EarlyCall, "outcome" | "answer">) => {
		closed.add(id)
		if (patch.answer?.kind !== "allow") {
			open.delete(id)
		}
		waitingOn().delete(id)
		const call = calls.get(id)
		if (retain === "waiting") {
			calls.delete(id)
		} else if (call !== undefined) {
			put({ ...call, ...answered(call, patch) })
		} else {
			noteEarly(id, answered(early.get(id), patch))
		}
	}
	const leavePause = () => {
		const were = Array.from(waitingOn())
		waitingOn().clear()
		were.forEach(refresh)
	}
	const end = (named: ReadonlyArray<string> = []) => {
		leavePause()
		if (retain === "waiting") {
			calls.clear()
		}
		for (const id of [...open, ...named]) {
			const call = calls.get(id)
			if (call !== undefined) {
				put({ ...call, cancelled: true })
			} else {
				noteEarly(id, { cancelled: true })
			}
		}
		open.clear()
		closed.clear()
	}

	for (const event of events) {
		switch (event.type) {
			case "agent.tool_use":
			case "agent.mcp_tool_use":
			case "agent.custom_tool_use": {
				const id = event.tool_use_id
				if (retain === "none" || (retain === "waiting" && (!asks(event) || closed.has(id)))) {
					break
				}
				const before = calls.get(id) ?? early.get(id)
				early.delete(id)
				const answer = before?.answer
				put({
					id,
					kind:
						event.type === "agent.mcp_tool_use"
							? "mcp"
							: event.type === "agent.custom_tool_use"
								? "custom"
								: "tool",
					name: event.name,
					server: event.type === "agent.mcp_tool_use" ? event.mcp_server_name : undefined,
					input: event.input,
					inputTruncated: "truncated" in event && event.truncated === true,
					askedFirst:
						(event.type === "agent.mcp_tool_use" && event.evaluated_permission === "ask") ||
						answer?.kind === "allow" ||
						answer?.kind === "deny",
					awaits: event.type === "agent.custom_tool_use" ? "result" : "confirmation",
					outcome: before?.outcome,
					answer,
					cancelled: before?.cancelled === true,
				})
				if (retain !== "all") {
					break
				}
				if (before?.outcome === undefined && (answer === undefined || answer.kind === "allow")) {
					open.add(id)
				}
				break
			}
			case "agent.tool_result":
			case "agent.mcp_tool_result":
				close(event.tool_use_id, {
					outcome: {
						text: textOf(event.content),
						isError: event.is_error,
						truncated: event.truncated === true,
						rejected: event.rejected,
					},
				})
				break
			case "user.tool_confirmation": {
				const answer: ToolCallAnswer =
					event.result === "allow"
						? { kind: "allow" }
						: { kind: "deny", message: event.deny_message ?? "" }
				close(event.tool_use_id, { answer })
				const call = calls.get(event.tool_use_id)
				if (call !== undefined && !call.askedFirst) {
					put({ ...call, askedFirst: true })
				}
				break
			}
			case "user.custom_tool_result":
				close(event.custom_tool_use_id, {
					answer: {
						kind: "result",
						text: textOf(event.content),
						isError: event.is_error === true,
					},
				})
				break
			case "session.status_running":
				leavePause()
				turn = {
					status: "running",
					turn: event.turn ?? (turn.status === "settled" ? turn.turn + 1 : turn.turn),
				}
				settledBefore(turn.turn)
				break
			case "session.status_idle": {
				const number = event.turn ?? turn.turn
				if (event.stop_reason.type === "requires_action") {
					leavePause()
					const named = event.stop_reason.event_ids.filter((id) => !closed.has(id))
					outstanding = new Set(named)
					turn = { status: "paused", turn: number, seq: event.seq, outstanding }
					named.forEach(refresh)
					settledBefore(number)
				} else {
					end(event.cancelled_event_ids)
					turn = { status: "settled", turn: number, stopReason: event.stop_reason.type }
					if (number >= settled.turn) {
						settled = { turn: number, stopReason: event.stop_reason.type }
					}
				}
				break
			}
			case "session.status_terminated":
				end(event.cancelled_event_ids)
				ended = true
				turn = { status: "settled", turn: turn.turn, stopReason: undefined }
				break
			case "session.archived":
				end()
				ended = true
				turn = { status: "settled", turn: turn.turn, stopReason: undefined }
				break
			default:
				break
		}
	}
	if (turn.status === "paused" && outstanding !== undefined) {
		turn = { ...turn, outstanding }
	}
	return { retain, turn, settled, ended, calls, closed, open, early }
}

export const foldSessionEvent = (fold: SessionFold, event: SessionFoldEvent): SessionFold =>
	foldSessionEvents(fold, [event])
