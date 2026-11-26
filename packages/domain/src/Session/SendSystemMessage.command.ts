import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { InitialMessagesPending } from "./InitialMessagesPending.rejection.ts"
import { SessionAwaitingAction } from "./SessionAwaitingAction.rejection.ts"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import { MAX_AGENT_SYSTEM_LENGTH, NonNegativeInt, SessionEventFields } from "./SessionTypes.ts"

const content = SessionEventFields["system.message"].content

export const SystemContextLength = NonNegativeInt.check(
	Schema.isLessThanOrEqualTo(MAX_AGENT_SYSTEM_LENGTH),
)

export const systemMessageText = (blocks: typeof content.Type): string =>
	blocks.map((block) => block.text).join("\n")

export class SystemMessage extends Domain.Event("system.message", {
	...SessionEventFields["system.message"],
	processed_at: Schema.DateTimeUtc,
	context_length: SystemContextLength,
}) {}

export class SystemContextFull extends Domain.Rejection(
	"SystemContextFull",
	{ session_id: SessionId },
	{ httpApiStatus: 400, description: "The session's system context is full." },
) {}

export class SendSystemMessage extends Domain.Command("SendSystemMessage", {
	input: { session_id: SessionId, content },
	events: [SystemMessage],
	rejects: [
		SessionNotFound,
		SessionTerminated,
		SessionAwaitingAction,
		InitialMessagesPending,
		SystemContextFull,
	],
}) {}
