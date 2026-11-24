export const conversationName = (sessionId: string, generation: number): string =>
	`${generation}:${sessionId}`

export const parseConversation = (conversation: string | undefined) => {
	const separator = conversation?.indexOf(":") ?? -1
	const generation = Number(conversation?.slice(0, separator))
	if (
		conversation === undefined ||
		separator < 1 ||
		separator === conversation.length - 1 ||
		!Number.isSafeInteger(generation) ||
		generation < 0
	) {
		throw new Error("PiSession must be addressed by its conversation name.")
	}
	return { sessionId: conversation.slice(separator + 1), generation }
}
