const isHighSurrogate = (code: number): boolean => code >= 0xd8_00 && code <= 0xdb_ff

/**
 * The first `maxLength` UTF-16 code units of `text`, one fewer when the cut would split a
 * surrogate pair, so what is kept is always a valid prefix.
 */
export const truncateText = (text: string, maxLength: number): string => {
	if (text.length <= maxLength) {
		return text
	}
	if (maxLength <= 0) {
		return ""
	}
	return text.slice(0, isHighSurrogate(text.charCodeAt(maxLength - 1)) ? maxLength - 1 : maxLength)
}
