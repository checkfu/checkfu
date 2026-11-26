import type { JsonSessionEvent } from "@checkfu/sdk/client"
import { emptySessionFold, foldSessionEvents, outstandingCalls } from "@checkfu/sdk/SessionFold"
import type { SessionFold } from "@checkfu/sdk/SessionFold"

export { TOOL_REJECTIONS } from "@checkfu/sdk/SessionFold"
export type { ToolCall, ToolCallStatus } from "@checkfu/sdk/SessionFold"

export type ToolCalls = SessionFold

export const toolCallsOf = (events: ReadonlyArray<JsonSessionEvent>): ToolCalls =>
	foldSessionEvents(emptySessionFold(), events)

export interface SessionCalls {
	readonly fold: ToolCalls
	readonly waiting: ReadonlySet<string>
	readonly unseen: ReadonlyArray<string>
}

export const sessionCallsOf = (events: ReadonlyArray<JsonSessionEvent>): SessionCalls => {
	const fold = toolCallsOf(events)
	const waiting = outstandingCalls(fold)
	return { fold, waiting, unseen: [...waiting].filter((id) => !fold.calls.has(id)) }
}

export interface LoadedHistory {
	readonly events: ReadonlyArray<JsonSessionEvent>
	readonly more: boolean
	readonly failure?: Error | undefined
}

export const loadUntilWaitingCallsSeen = async (
	loadOlder: () => Promise<LoadedHistory>,
): Promise<null> => {
	for (;;) {
		const loaded = await loadOlder()
		if (loaded.failure !== undefined) {
			throw loaded.failure
		}
		if (!loaded.more || sessionCallsOf(loaded.events).unseen.length === 0) {
			return null
		}
	}
}

export const allowEvent = (id: string) => ({
	type: "user.tool_confirmation" as const,
	tool_use_id: id,
	result: "allow" as const,
})

export const denyEvent = (id: string, message: string) => ({
	type: "user.tool_confirmation" as const,
	tool_use_id: id,
	result: "deny" as const,
	...(message.trim() === "" ? {} : { deny_message: message.trim() }),
})

export const customResultEvent = (id: string, result: string, isError: boolean) => ({
	type: "user.custom_tool_result" as const,
	custom_tool_use_id: id,
	content: [{ type: "text" as const, text: result }],
	...(isError ? { is_error: true } : {}),
})

export type AnswerEvent =
	| ReturnType<typeof allowEvent>
	| ReturnType<typeof denyEvent>
	| ReturnType<typeof customResultEvent>
