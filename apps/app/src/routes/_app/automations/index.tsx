import { createFileRoute } from "@tanstack/react-router"
import { automationsPage } from "../../../queries.ts"
import { pageSearch } from "../../../page-search.ts"
import { AutomationsPage } from "../../../pages/automations.tsx"

export const Route = createFileRoute("/_app/automations/")({
	validateSearch: pageSearch,
	loaderDeps: ({ search }) => search,
	loader: ({ context, deps }) => context.queryClient.ensureQueryData(automationsPage(deps.after)),
	component: AutomationsPage,
})
