import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { ConversationMessage } from "./ModelProvider.external.ts"
import { SessionStatusRunning } from "./SendUserMessage.command.ts"
import { Session } from "./Session.aggregate.ts"
import {
	MAX_IDENTIFIER_LENGTH,
	NonNegativeInt,
	PositiveInt,
	type TextBlock,
} from "./SessionTypes.ts"

export const MAX_TRANSCRIPT_MESSAGES = 64
// Worst-case JSON escaping is 6 UTF-8 bytes per UTF-16 code unit (\u0000).
// 131_072 chars keeps RunTurn input <= ~791 KiB and SessionTranscript
// (messages + pending_messages) <= ~1.51 MiB, strictly below the 2 MiB DO row
// limit while still accommodating a full 8 x 16 KiB pending user message queue.
export const MAX_TRANSCRIPT_CHARS = 131_072
export const OVERSIZED_MESSAGE_PLACEHOLDER = "[message omitted: exceeds transcript size limit]"

const toTranscriptMessages = (
	role: "user" | "assistant",
	blocks: ReadonlyArray<TextBlock>,
): ReadonlyArray<ConversationMessage> =>
	blocks
		.filter((block) => block.text.length > 0)
		.map((block) => ({
			role,
			text: block.text.length > MAX_TRANSCRIPT_CHARS ? OVERSIZED_MESSAGE_PLACEHOLDER : block.text,
		}))

const trimHistory = (
	items: ReadonlyArray<ConversationMessage>,
): ReadonlyArray<ConversationMessage> => {
	const capped = items.slice(-MAX_TRANSCRIPT_MESSAGES)
	let totalChars = 0
	let start = capped.length
	for (let i = capped.length - 1; i >= 0; i--) {
		const item = capped[i]
		if (item === undefined) continue
		const len = item.text.length
		if (totalChars + len > MAX_TRANSCRIPT_CHARS) {
			break
		}
		totalChars += len
		start = i
	}
	return start === 0 ? capped : capped.slice(start)
}

export const SessionTranscriptState = Schema.Struct({
	agent_id: Schema.String,
	agent_version: PositiveInt,
	environment_id: Schema.String,
	turn: NonNegativeInt,
	running: Schema.Boolean,
	messages: Schema.Array(ConversationMessage),
	pending_messages: Schema.Array(ConversationMessage),
})
export type SessionTranscriptState = typeof SessionTranscriptState.Type

export class SessionTranscript extends Domain.View("SessionTranscript", {
	version: 1,
	from: [Session],
	key: Session,
	state: Schema.NullOr(SessionTranscriptState),
	initial: null,
	events: [SessionStatusRunning],
	evolve: {
		"session.created": (state, e) =>
			state !== null
				? state
				: {
						agent_id: e.agent_id.length > MAX_IDENTIFIER_LENGTH ? "" : e.agent_id,
						agent_version: e.agent_version,
						environment_id: e.environment_id.length > MAX_IDENTIFIER_LENGTH ? "" : e.environment_id,
						turn: 0,
						running: false,
						messages: [],
						pending_messages: [],
					},
		"user.message": (state, e) => {
			if (state === null) return null
			const incoming = toTranscriptMessages("user", e.content)
			return state.running
				? {
						...state,
						pending_messages: trimHistory([...state.pending_messages, ...incoming]),
					}
				: {
						...state,
						messages: trimHistory([...state.messages, ...incoming]),
					}
		},
		"agent.message": (state, e) =>
			state === null
				? null
				: {
						...state,
						messages: trimHistory([
							...state.messages,
							...toTranscriptMessages("assistant", e.content),
						]),
					},
		"user.interrupt": (state) =>
			state === null
				? null
				: {
						...state,
						pending_messages: [],
					},
		"session.status_running": (state) =>
			state === null
				? null
				: {
						...state,
						turn: state.turn + 1,
						running: true,
					},
		"session.status_idle": (state) =>
			state === null
				? null
				: {
						...state,
						running: false,
						messages: trimHistory([...state.messages, ...state.pending_messages]),
						pending_messages: [],
					},
		"session.status_terminated": (state) =>
			state === null
				? null
				: {
						...state,
						running: false,
						pending_messages: [],
					},
	},
}) {}
