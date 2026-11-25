export const sessionTitle = (session: { readonly title: string | null }): string | undefined =>
	session.title === null || session.title.trim() === "" ? undefined : session.title
