export const pageSearch = (search: { readonly page?: unknown }): { readonly page?: string } =>
	typeof search.page === "string" ? { page: search.page } : {}
