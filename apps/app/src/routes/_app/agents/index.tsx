import { createFileRoute } from "@tanstack/react-router"
import { agentsPage } from "../../../queries.ts"
import { pageSearch } from "../../../page-search.ts"
import { AgentsPage } from "../../../pages/agents.tsx"

export const Route = createFileRoute("/_app/agents/")({
	validateSearch: pageSearch,
	loaderDeps: ({ search }) => search,
	loader: ({ context, deps }) => context.queryClient.ensureQueryData(agentsPage(deps.page)),
	component: AgentsPage,
})
