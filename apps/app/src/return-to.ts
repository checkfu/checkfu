const BASE = "https://dashboard.invalid"

export const returnTo = (value: unknown): string | undefined => {
	if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
		return undefined
	}
	try {
		const url = new URL(value, BASE)
		return url.origin === BASE && !url.pathname.startsWith("/sign-in")
			? `${url.pathname}${url.search}${url.hash}`
			: undefined
	} catch {
		return undefined
	}
}

export const signInSearch = (href: string): { readonly redirect?: string } => {
	const target = returnTo(href)
	return target === undefined ? {} : { redirect: target }
}
