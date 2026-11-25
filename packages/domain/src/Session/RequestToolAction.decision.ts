import * as Domain from "@alchemy.run/domain"
import { AgentCustomToolUse, AgentMcpToolUse } from "./RecordToolCall.command.ts"
import { RequestToolAction } from "./RequestToolAction.command.ts"
import { Session } from "./Session.aggregate.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { StaleTurn } from "./StaleTurn.rejection.ts"
import { ToolConfirmation, ToolConfirmationRequested } from "./ToolConfirmation.aggregate.ts"
import { UnknownModelRequest } from "./UnknownModelRequest.rejection.ts"

export class RequestToolActionDecision extends Domain.Decision(RequestToolAction, {
	reads: { call: ToolConfirmation, session: Session },
	keyOf: (cmd) => ({ call: cmd.confirmation_id, session: cmd.session_id }),
	decide: ({ call, session }, cmd) => {
		const state = session.state
		if (state._tag === "Uninitialized") {
			return new SessionNotFound({ session_id: session.id })
		}
		if (state._tag !== "Running") {
			return new SessionNotRunning({
				session_id: session.id,
				status: state._tag === "Idle" ? "idle" : "terminated",
			})
		}
		if (state.turn !== cmd.turn) {
			return new StaleTurn({
				session_id: session.id,
				active_turn: state.turn,
				received_turn: cmd.turn,
			})
		}
		if (state.open_model_request_id !== cmd.model_request_start_id) {
			return new UnknownModelRequest({
				session_id: session.id,
				model_request_start_id: cmd.model_request_start_id,
			})
		}
		if (call.state.status !== "") {
			return []
		}
		const use =
			cmd.awaits === "result"
				? new AgentCustomToolUse({ tool_use_id: cmd.tool_use_id, name: cmd.name, input: cmd.input })
				: new AgentMcpToolUse({
						tool_use_id: cmd.tool_use_id,
						mcp_server_name: cmd.mcp_server_name,
						name: cmd.name,
						input: cmd.input,
						evaluated_permission: "ask",
					})
		return [
			call.record(
				new ToolConfirmationRequested({
					session_id: session.id,
					tool_use_id: cmd.tool_use_id,
					turn: cmd.turn,
					awaits: cmd.awaits,
				}),
			),
			session.record(use),
		]
	},
	transitions: {
		ARequestWaitsInItsOwnTurn: ({ before, after }) =>
			before.call.status !== "" ||
			after.call.status === "" ||
			(before.session._tag === "Running" &&
				after.session._tag === "Running" &&
				after.call.turn === before.session.turn &&
				after.session.awaiting_calls === before.session.awaiting_calls + 1),
	},
}) {}
