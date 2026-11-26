import * as Domain from "@alchemy.run/domain"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { SessionCreated } from "./CreateSession.command.ts"
import { decodeInitialMessages } from "./InitialMessages.ts"
import { RecordInitialMessage } from "./RecordInitialMessage.command.ts"
import { Session } from "./Session.aggregate.ts"
import type { SessionId } from "./Session.id.ts"

export const recordInitialMessages = (
	sessions: Context.Service.Shape<typeof Session>,
	session_id: SessionId,
	encoded: string,
) =>
	Effect.gen(function* () {
		const messages = decodeInitialMessages(encoded)
		return yield* Effect.forEach(messages, (text, index) =>
			sessions.send(
				new RecordInitialMessage({ session_id, text, remaining: messages.length - index }),
				{ commandId: `initial-message:${index}` },
			),
		)
	})

export class RecordInitialMessages extends Domain.Policy("RecordInitialMessages", {
	from: Session,
	on: [SessionCreated],
}) {}

export const RecordInitialMessagesLive = RecordInitialMessages.toLayer(
	Effect.gen(function* () {
		const sessions = yield* Session
		return ({ source, event }) =>
			event.initial_messages === undefined
				? Effect.void
				: Effect.asVoid(recordInitialMessages(sessions, source.id, event.initial_messages.messages))
	}),
)
