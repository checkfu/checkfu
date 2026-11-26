import * as Domain from "@alchemy.run/domain"
import { InitialMessagesPending } from "./InitialMessagesPending.rejection.ts"
import {
	decodeSystemMessage,
	SendSystemMessage,
	SystemContextFull,
	SystemMessage,
} from "./SendSystemMessage.command.ts"
import { Session } from "./Session.aggregate.ts"
import { SessionAwaitingAction } from "./SessionAwaitingAction.rejection.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import { MAX_AGENT_SYSTEM_LENGTH } from "./SessionTypes.ts"
import { SystemContext, SystemContextAppended } from "./SystemContext.aggregate.ts"

export class SendSystemMessageDecision extends Domain.Decision(SendSystemMessage, {
	reads: { session: Session, system: SystemContext },
	keyOf: (cmd) => ({ session: cmd.session_id, system: cmd.session_id }),
	decide: ({ session, system }, cmd, { now }) => {
		const state = session.state
		if (state._tag === "Uninitialized") {
			return new SessionNotFound({ session_id: session.id })
		}
		if (state._tag === "Terminated") {
			return new SessionTerminated({ session_id: session.id })
		}
		if (state._tag === "Idle" && state.initial_messages_remaining) {
			return new InitialMessagesPending({ session_id: session.id })
		}
		if (state._tag === "Running" && state.paused) {
			return new SessionAwaitingAction({ session_id: session.id })
		}
		const length = system.state.length + cmd.content_json.length
		if (length > MAX_AGENT_SYSTEM_LENGTH || length <= system.state.length) {
			return new SystemContextFull({ session_id: session.id })
		}
		return [
			system.record(new SystemContextAppended({ length })),
			session.record(
				new SystemMessage({ content: decodeSystemMessage(cmd.content_json), processed_at: now }),
			),
		]
	},
	transitions: {
		SystemContextGrowsOnAnActiveSession: ({ before, after }) =>
			((before.session._tag === "Idle" && !before.session.initial_messages_remaining) ||
				(before.session._tag === "Running" && !before.session.paused)) &&
			after.system.length > before.system.length,
	},
}) {}
