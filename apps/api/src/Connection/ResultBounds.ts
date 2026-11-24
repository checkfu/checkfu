/** JSON characters of structured content one tool result may carry to a script. */
export const MAX_RESULT_STRUCTURED_CHARS = 262_144

/** Structured content that fits, or the reason it was dropped. */
export interface BoundedStructured {
	readonly value?: unknown
	readonly dropped?: string
}

export const boundStructured = (value: unknown): BoundedStructured => {
	if (value === undefined) {
		return {}
	}
	const size = JSON.stringify(value).length
	return size <= MAX_RESULT_STRUCTURED_CHARS
		? { value }
		: {
				dropped: `[Structured result of ${size} characters left out: a tool result carries at most ${MAX_RESULT_STRUCTURED_CHARS}]`,
			}
}
