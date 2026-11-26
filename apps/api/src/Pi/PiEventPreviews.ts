import { modelEventId } from "@checkfu/domain/Session/Session.id"
import { truncateText } from "@checkfu/domain/Session/TextBounds"
import { MAX_MESSAGE_TEXT_LENGTH } from "@checkfu/domain/Session/SessionTypes"
import type { SessionEventPreview, SessionPreviewType } from "@checkfu/sdk/Api"
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import type { MutableModels } from "@earendil-works/pi-ai/models"

export interface PreviewPacket {
	readonly event: SessionEventPreview
	readonly offset: number
}

const observe = (
	source: AssistantMessageEventStream,
	sessionId: string,
	turn: number,
	publish: (packet: PreviewPacket) => void,
): AssistantMessageEventStream => {
	const original = source[Symbol.asyncIterator].bind(source)
	source[Symbol.asyncIterator] = async function* () {
		const started = new Set<SessionPreviewType>()
		let offset = 0
		let textSize = 0
		for await (const event of { [Symbol.asyncIterator]: original }) {
			if (
				event.type === "thinking_start" ||
				event.type === "text_start" ||
				event.type === "text_delta"
			) {
				const type = event.type === "thinking_start" ? "agent.thinking" : "agent.message"
				const id = modelEventId(sessionId, turn, event.partial.timestamp, type)
				if (!started.has(type)) {
					started.add(type)
					publish({ event: { type: "event_start", event: { type, id } }, offset: 0 })
				}
				if (event.type === "text_delta" && textSize < MAX_MESSAGE_TEXT_LENGTH) {
					const text = truncateText(event.delta, MAX_MESSAGE_TEXT_LENGTH - textSize)
					if (text.length > 0) {
						textSize += text.length
						offset += 1
						publish({
							event: {
								type: "event_delta",
								event_id: id,
								delta: { type: "content_delta", index: 0, content: { type: "text", text } },
							},
							offset,
						})
					}
					if (text.length < event.delta.length) {
						textSize = MAX_MESSAGE_TEXT_LENGTH
					}
				}
			}
			yield event
		}
	}
	return source
}

export const previewModelRequests = (
	models: MutableModels,
	sessionId: string,
	turn: () => number,
	publish: (packet: PreviewPacket) => void,
): MutableModels => ({
	...models,
	streamSimple: (model, context, options) =>
		observe(models.streamSimple(model, context, options), sessionId, turn(), publish),
})
