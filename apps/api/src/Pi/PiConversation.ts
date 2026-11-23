export const conversationName = (sessionId: string, generation: number): string =>
	`${generation}:${sessionId}`

export const sessionIdOfConversation = (conversation: string | undefined): string => {
	const separator = conversation?.indexOf(":") ?? -1
	if (conversation === undefined || separator < 1 || separator === conversation.length - 1) {
		throw new Error("PiSession must be addressed by its conversation name.")
	}
	return conversation.slice(separator + 1)
}
