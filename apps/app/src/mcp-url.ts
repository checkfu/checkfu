export const canonicalServerUrl = (url: string): string | undefined => {
	if (!URL.canParse(url)) {
		return undefined
	}
	const parsed = new URL(url)
	parsed.hash = ""
	return parsed.href
}
