import * as Domain from "@alchemy.run/domain"
import { ConfirmTool, UserToolConfirmation } from "./ConfirmTool.command.ts"
import { TurnContinued } from "./PauseTurn.command.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { Session } from "./Session.aggregate.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import { ToolConfirmation, ToolConfirmationAnswered } from "./ToolConfirmation.aggregate.ts"
import { ToolConfirmationNotPending } from "./ToolConfirmationNotPending.rejection.ts"

export class ConfirmToolDecision extends Domain.Decision(ConfirmTool, {
	reads: { call: ToolConfirmation, session: Session },
	keyOf: (cmd) => ({ call: cmd.confirmation_id, session: cmd.session_id }),
	decide: ({ call, session }, cmd, { now }) => {
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
			call.state.awaits !== "confirmation" ||
			call.state.session_id !== session.id ||
			call.state.tool_use_id !== cmd.tool_use_id ||
			call.state.turn !== state.turn
		) {
			return new ToolConfirmationNotPending({
				session_id: session.id,
				tool_use_id: cmd.tool_use_id,
			})
		}
		const answered = [
			call.record(
				new ToolConfirmationAnswered({ result: cmd.result, deny_message: cmd.deny_message }),
			),
			session.record(
				new UserToolConfirmation({
					processed_at: now,
					tool_use_id: cmd.tool_use_id,
					result: cmd.result,
					...(cmd.result === "deny" && cmd.deny_message !== ""
						? { deny_message: cmd.deny_message }
						: {}),
				}),
			),
		]
		return state.paused && state.awaiting_calls === 1
			? [
					...answered,
					session.record(new SessionStatusRunning({ turn: state.turn })),
					session.record(
						new TurnContinued({ turn: state.turn, segment: state.model_requests_started + 1 }),
					),
				]
			: answered
	},
	transitions: {
		AnAnswerMatchesItsSessionAndCall: ({ before, command }) =>
			before.call.session_id === command.session_id &&
			before.call.tool_use_id === command.tool_use_id,
		OnlyAPendingCallOfTheRunningTurnIsConfirmed: ({ before, after }) =>
			before.call.status === "pending" &&
			before.call.awaits === "confirmation" &&
			before.session._tag === "Running" &&
			before.call.turn === before.session.turn &&
			(after.call.status === "allowed" || after.call.status === "denied"),
		AnAnswerKeepsTheTurn: ({ before, after }) =>
			before.session._tag !== "Running" ||
			(after.session._tag === "Running" && after.session.turn === before.session.turn),
	},
}) {}
