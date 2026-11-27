import { MAX_MESSAGE_TEXT_LENGTH, MAX_SESSION_INITIAL_EVENTS } from "@checkfu/sdk/Schemas"

export const fullAsciiInitialMessages = (): ReadonlyArray<string> =>
	Array.from({ length: MAX_SESSION_INITIAL_EVENTS }, (_, index) =>
		`Message ${index} `.padEnd(MAX_MESSAGE_TEXT_LENGTH, "x"),
	)

export const mixedInitialMessagesAt = (size: number): ReadonlyArray<string> => {
	const messages = fullAsciiInitialMessages()
	// One wide character makes the stored string two-byte. Quotes use one extra JSON byte each.
	let quotes = size - JSON.stringify(messages).length - 2
	return messages.map((message, index) => {
		const prefix = index === 0 ? "漢" + message.slice(1) : message
		const count = Math.min(quotes, prefix.length - 32)
		quotes -= count
		return prefix.slice(0, prefix.length - count) + '"'.repeat(count)
	})
}

export const asInitialEvents = (messages: ReadonlyArray<string>) =>
	messages.map((text) => ({
		type: "user.message" as const,
		content: [{ type: "text" as const, text }],
	}))
