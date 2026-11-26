export { SessionId } from "@checkfu/sdk/Schemas"

export const sessionEventId = (sessionId: string, position: string | number): string =>
	`sevt_${sessionId}_${position}`

// Each send command records one user event, and its command ID survives view replay.
export const submittedSessionEventId = (sessionId: string, commandId: string): string =>
	sessionEventId(sessionId, `input_${commandId.slice(4)}`)

export const toolUseEventId = (sessionId: string, toolUseId: string): string =>
	sessionEventId(sessionId, `tool_${toolUseId}`)

export const toolUseIdFromEvent = (sessionId: string, eventId: string): string => {
	const prefix = toolUseEventId(sessionId, "")
	return eventId.startsWith(prefix) ? eventId.slice(prefix.length) : eventId
}

export const modelEventId = (
	sessionId: string,
	turn: number,
	startedAt: number,
	type: "agent.message" | "agent.thinking",
) => sessionEventId(sessionId, `${type}_${turn}_${startedAt}`)
