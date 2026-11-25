import { createFileRoute } from "@tanstack/react-router"
import { pageSearch } from "../../../page-search.ts"
import { MemoryStoresPage } from "../../../pages/memory.tsx"
import { memoryStoresPage } from "../../../queries.ts"

export const Route = createFileRoute("/_app/memory-stores/")({
	validateSearch: pageSearch,
	loaderDeps: ({ search }) => search,
	loader: ({ context, deps }) => context.queryClient.ensureQueryData(memoryStoresPage(deps.after)),
	component: MemoryStoresPage,
})
