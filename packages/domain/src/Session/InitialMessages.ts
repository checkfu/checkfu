import * as Schema from "effect/Schema"
import {
	MAX_MESSAGE_TEXT_LENGTH,
	MAX_SESSION_INITIAL_EVENTS,
	MessageText,
	PositiveInt,
} from "./SessionTypes.ts"

const Messages = Schema.Array(MessageText).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_SESSION_INITIAL_EVENTS),
)

export const InitialMessages = Schema.Struct({
	count: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_SESSION_INITIAL_EVENTS)),
	messages: Schema.String.check(
		Schema.isMaxLength(MAX_SESSION_INITIAL_EVENTS * (MAX_MESSAGE_TEXT_LENGTH * 6 + 3) + 2),
	),
})

const InitialMessagesJson = Schema.fromJsonString(Messages)

export const encodeInitialMessages = Schema.encodeSync(InitialMessagesJson)
export const decodeInitialMessages = Schema.decodeSync(InitialMessagesJson)
