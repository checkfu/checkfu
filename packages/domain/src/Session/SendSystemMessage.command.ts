import * as Domain from "@alchemy.run/domain"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { InitialMessagesPending } from "./InitialMessagesPending.rejection.ts"
import { SessionAwaitingAction } from "./SessionAwaitingAction.rejection.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import { SessionEventFields } from "./SessionTypes.ts"
import { SystemContextAppended } from "./SystemContext.aggregate.ts"

const ContentJson = Schema.fromJsonString(SessionEventFields["system.message"].content)
const readContent = Schema.decodeUnknownOption(ContentJson)

export const encodeSystemMessage = Schema.encodeSync(ContentJson)
export const decodeSystemMessage = Schema.decodeSync(ContentJson)

const SystemMessageJson = Schema.String.check(
	Schema.isMinLength(2),
	Schema.makeFilter(
		(value) => Option.isSome(readContent(value)) || "Expected system message text blocks.",
	),
)

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
	input: { session_id: SessionId, content_json: SystemMessageJson },
	events: [SystemMessage, SystemContextAppended],
	rejects: [
		SessionNotFound,
		SessionTerminated,
		SessionAwaitingAction,
		InitialMessagesPending,
		SystemContextFull,
	],
}) {}
