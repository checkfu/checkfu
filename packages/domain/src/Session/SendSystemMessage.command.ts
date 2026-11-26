import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { InitialMessagesPending } from "./InitialMessagesPending.rejection.ts"
import { SessionAwaitingAction } from "./SessionAwaitingAction.rejection.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import { MessageText, SessionEventFields } from "./SessionTypes.ts"

export class SystemMessage extends Domain.Event("system.message", {
	...SessionEventFields["system.message"],
	processed_at: Schema.DateTimeUtc,
}) {}

export class SystemContextFull extends Domain.Rejection(
	"SystemContextFull",
	{ session_id: SessionId },
	{ httpApiStatus: 400, description: "The session's system context is full." },
) {}

export class SendSystemMessage extends Domain.Command("SendSystemMessage", {
	input: { session_id: SessionId, text: MessageText },
	events: [SystemMessage],
	rejects: [
		SessionNotFound,
		SessionTerminated,
		SessionAwaitingAction,
		InitialMessagesPending,
		SystemContextFull,
	],
}) {}
