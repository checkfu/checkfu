import * as Domain from "@alchemy.run/domain"
import { ReturnCustomToolResult, UserCustomToolResult } from "./ReturnCustomToolResult.command.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { Session } from "./Session.aggregate.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import { ToolConfirmation, ToolResultReturned } from "./ToolConfirmation.aggregate.ts"
import { ToolConfirmationNotPending } from "./ToolConfirmationNotPending.rejection.ts"

/**
 * Records a custom tool's result on the waiting call and on its session at
 * once, so a result either stands and shows in the session's events, or is
 * refused. Like a person's answer, the first one to a paused session sets it
 * running again, and one that arrives while it runs is picked up by the turn
 * in progress.
 */
export class ReturnCustomToolResultDecision extends Domain.Decision(ReturnCustomToolResult, {
	reads: { call: ToolConfirmation, session: Session },
	keyOf: (cmd) => ({ call: cmd.confirmation_id, session: cmd.session_id }),
	decide: ({ call, session }, cmd) => {
		if (session.state._tag === "Uninitialized") {
			return new SessionNotFound({ session_id: session.id })
		}
		if (session.state._tag === "Terminated") {
			return new SessionTerminated({ session_id: session.id })
		}
		if (
			call.state.status !== "pending" ||
			call.state.awaits !== "result" ||
			call.state.session_id !== session.id ||
			call.state.tool_use_id !== cmd.custom_tool_use_id ||
			(session.state._tag === "Idle" && !session.state.awaiting)
		) {
			return new ToolConfirmationNotPending({
				session_id: session.id,
				tool_use_id: cmd.custom_tool_use_id,
			})
		}
		const returned = [
			call.record(new ToolResultReturned({ text: cmd.text, is_error: cmd.is_error })),
			session.record(
				new UserCustomToolResult({
					custom_tool_use_id: cmd.custom_tool_use_id,
					content: [{ type: "text", text: cmd.text }],
					...(cmd.is_error ? { is_error: true } : {}),
				}),
			),
		]
		return session.state._tag === "Idle"
			? [...returned, session.record(new SessionStatusRunning({ turn: session.state.turn + 1 }))]
			: returned
	},
	transitions: {
		OnlyAPendingCallOfTheSessionGetsAResult: ({ before, after }) =>
			before.call.status === "pending" &&
			before.call.awaits === "result" &&
			before.call.session_id !== "" &&
			after.call.status === "returned",
		AResultResumesAWaitingSession: ({ before, after }) =>
			before.session._tag !== "Idle" ||
			(before.session.awaiting &&
				after.session._tag === "Running" &&
				after.session.turn === before.session.turn + 1),
		AResultLeavesARunningTurnRunning: ({ before, after }) =>
			before.session._tag !== "Running" ||
			(after.session._tag === "Running" && after.session.turn === before.session.turn),
	},
}) {}
