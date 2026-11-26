import * as Schema from "effect/Schema"

export { SessionId } from "@checkfu/sdk/Schemas"

export const SessionInputEventId = Schema.NonEmptyString

export const sessionEventId = (sessionId: string, position: string | number): string =>
	`sevt_${sessionId}_${position}`

export const submittedSessionEventId = (sessionId: string, commandId: string): string =>
	sessionEventId(sessionId, `input_${commandId.slice(4)}`)
