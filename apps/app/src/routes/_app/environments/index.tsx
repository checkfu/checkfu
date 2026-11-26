import { createFileRoute } from "@tanstack/react-router"
import { environmentsPage } from "../../../queries.ts"
import { pageSearch } from "../../../page-search.ts"
import { EnvironmentsPage } from "../../../pages/environments.tsx"

export const Route = createFileRoute("/_app/environments/")({
	validateSearch: pageSearch,
	loaderDeps: ({ search }) => search,
	loader: ({ context, deps }) => context.queryClient.ensureQueryData(environmentsPage(deps.page)),
	component: EnvironmentsPage,
})
