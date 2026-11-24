import { createFileRoute } from "@tanstack/react-router"
import { checkfu } from "../../../api.ts"
import { pageSearch } from "../../../page-search.ts"
import { AgentsPage } from "../../../pages/agents.tsx"

export const Route = createFileRoute("/_app/agents/")({
	validateSearch: pageSearch,
	loaderDeps: ({ search }) => search,
	loader: ({ deps }) => checkfu.agents.list(deps.after),
	component: AgentsPage,
})
