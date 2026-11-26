import * as Schema from "effect/Schema"
import type { SessionId } from "./Session.id.ts"

export const ToolConfirmationId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(1024),
).pipe(Schema.brand("ToolConfirmationId"))
export type ToolConfirmationId = typeof ToolConfirmationId.Type

export const toolConfirmationId = (
	session_id: SessionId,
	tool_use_id: string,
): ToolConfirmationId => ToolConfirmationId.make(`${session_id}/${tool_use_id}`)
