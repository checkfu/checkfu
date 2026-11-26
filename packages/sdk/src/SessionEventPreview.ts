import type { SessionEventPreview, SessionStreamEvent } from "./Api.ts"
import type { JsonSessionEvent, JsonSessionEventPreview } from "./Checkfu.ts"
import type { TextBlock } from "./Schemas.ts"

export interface SessionMessagePreview {
	readonly id: string
	readonly type: "agent.message"
	readonly content: Readonly<Record<number, TextBlock | undefined>>
}

/** Accumulate the content of one assistant message by block index. */
export const accumulateSessionEvent = (
	preview: SessionMessagePreview | undefined,
	event: SessionStreamEvent | JsonSessionEvent | JsonSessionEventPreview,
): SessionMessagePreview | undefined => {
	switch (event.type) {
		case "event_start":
			return event.event.type === "agent.message"
				? { id: event.event.id, type: event.event.type, content: {} }
				: preview
		case "event_delta":
			return appendDelta(preview, event)
		case "agent.message":
			return { id: event.id, type: event.type, content: event.content }
		default:
			return preview
	}
}

const appendDelta = (
	preview: SessionMessagePreview | undefined,
	event: Extract<SessionEventPreview, { readonly type: "event_delta" }>,
): SessionMessagePreview | undefined => {
	if (preview?.id !== event.event_id) {
		return preview
	}
	const { index, content } = event.delta
	return {
		...preview,
		content: {
			...preview.content,
			[index]: { type: "text", text: (preview.content[index]?.text ?? "") + content.text },
		},
	}
}
