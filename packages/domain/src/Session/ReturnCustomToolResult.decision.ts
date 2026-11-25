import * as Domain from "@alchemy.run/domain"
import { TurnContinued } from "./PauseTurn.command.ts"
import { ReturnCustomToolResult, UserCustomToolResult } from "./ReturnCustomToolResult.command.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { Session } from "./Session.aggregate.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import { ToolConfirmation, ToolResultReturned } from "./ToolConfirmation.aggregate.ts"
import { ToolConfirmationNotPending } from "./ToolConfirmationNotPending.rejection.ts"

export class ReturnCustomToolResultDecision extends Domain.Decision(ReturnCustomToolResult, {
	reads: { call: ToolConfirmation, session: Session },
	keyOf: (cmd) => ({ call: cmd.confirmation_id, session: cmd.session_id }),
	decide: ({ call, session }, cmd) => {
		const state = session.state
		if (state._tag === "Uninitialized") {
			return new SessionNotFound({ session_id: session.id })
		}
		if (state._tag === "Terminated") {
			return new SessionTerminated({ session_id: session.id })
		}
		if (
			state._tag !== "Running" ||
			call.state.status !== "pending" ||
			call.state.awaits !== "result" ||
			call.state.session_id !== session.id ||
			call.state.tool_use_id !== cmd.custom_tool_use_id ||
			call.state.turn !== state.turn
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
		return state.paused && state.awaiting_calls === 1
			? [
					...returned,
					session.record(new SessionStatusRunning({ turn: state.turn })),
					session.record(
						new TurnContinued({ turn: state.turn, segment: state.model_requests_started + 1 }),
					),
				]
			: returned
	},
	transitions: {
		OnlyAPendingCallOfTheRunningTurnGetsAResult: ({ before, after }) =>
			before.call.status === "pending" &&
			before.call.awaits === "result" &&
			before.session._tag === "Running" &&
			before.call.turn === before.session.turn &&
			after.call.status === "returned",
		AResultKeepsTheTurn: ({ before, after }) =>
			before.session._tag !== "Running" ||
			(after.session._tag === "Running" && after.session.turn === before.session.turn),
	},
}) {}
