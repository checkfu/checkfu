import * as Domain from "@alchemy.run/domain"
import { ConfirmTool, UserToolConfirmation } from "./ConfirmTool.command.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { Session } from "./Session.aggregate.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import { ToolConfirmation, ToolConfirmationAnswered } from "./ToolConfirmation.aggregate.ts"
import { ToolConfirmationNotPending } from "./ToolConfirmationNotPending.rejection.ts"

/**
 * Records a person's answer on the waiting call and on its session at once, so
 * an answer either stands and shows in the session's events, or is refused.
 * The first answer to a paused session sets it running again; an answer that
 * arrives while it already runs is picked up by the turn in progress.
 */
export class ConfirmToolDecision extends Domain.Decision(ConfirmTool, {
	reads: { confirmation: ToolConfirmation, session: Session },
	keyOf: (cmd) => ({ confirmation: cmd.confirmation_id, session: cmd.session_id }),
	decide: ({ confirmation, session }, cmd) => {
		if (session.state._tag === "Uninitialized") {
			return new SessionNotFound({ session_id: session.id })
		}
		if (session.state._tag === "Terminated") {
			return new SessionTerminated({ session_id: session.id })
		}
		if (
			confirmation.state.status !== "pending" ||
			confirmation.state.awaits !== "confirmation" ||
			confirmation.state.session_id !== session.id ||
			confirmation.state.tool_use_id !== cmd.tool_use_id ||
			(session.state._tag === "Idle" && !session.state.awaiting)
		) {
			return new ToolConfirmationNotPending({
				session_id: session.id,
				tool_use_id: cmd.tool_use_id,
			})
		}
		const answered = [
			confirmation.record(
				new ToolConfirmationAnswered({ result: cmd.result, deny_message: cmd.deny_message }),
			),
			session.record(
				new UserToolConfirmation({
					tool_use_id: cmd.tool_use_id,
					result: cmd.result,
					...(cmd.result === "deny" && cmd.deny_message !== ""
						? { deny_message: cmd.deny_message }
						: {}),
				}),
			),
		]
		return session.state._tag === "Idle"
			? [...answered, session.record(new SessionStatusRunning({ turn: session.state.turn + 1 }))]
			: answered
	},
	transitions: {
		OnlyAPendingConfirmationOfTheSessionIsAnswered: ({ before, after }) =>
			before.confirmation.status === "pending" &&
			before.confirmation.session_id !== "" &&
			(after.confirmation.status === "allowed" || after.confirmation.status === "denied"),
		AnAnswerResumesAWaitingSession: ({ before, after }) =>
			before.session._tag !== "Idle" ||
			(before.session.awaiting &&
				after.session._tag === "Running" &&
				after.session.turn === before.session.turn + 1),
		AnAnswerLeavesARunningTurnRunning: ({ before, after }) =>
			before.session._tag !== "Running" ||
			(after.session._tag === "Running" && after.session.turn === before.session.turn),
	},
}) {}
