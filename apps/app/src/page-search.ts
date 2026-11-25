export const pageSearch = (search: { readonly after?: unknown }): { readonly after?: string } =>
	typeof search.after === "string" ? { after: search.after } : {}
