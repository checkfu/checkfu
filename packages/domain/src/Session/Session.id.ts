export { SessionId } from "@checkfu/sdk/Schemas"

export const sessionEventId = (sessionId: string, position: string | number): string =>
	`sevt_${sessionId}_${position}`

// Each send command records one user event, and its command ID survives view replay.
export const submittedSessionEventId = (sessionId: string, commandId: string): string =>
	sessionEventId(sessionId, `input_${commandId.slice(4)}`)
