import { createFileRoute } from "@tanstack/react-router"
import { pageSearch } from "../../../page-search.ts"
import { VaultsPage } from "../../../pages/vaults.tsx"
import { vaultsPage } from "../../../queries.ts"

export const Route = createFileRoute("/_app/vaults/")({
	validateSearch: pageSearch,
	loaderDeps: ({ search }) => search,
	loader: ({ context, deps }) => context.queryClient.ensureQueryData(vaultsPage(deps.after)),
	component: VaultsPage,
})
