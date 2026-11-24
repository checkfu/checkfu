import { createFileRoute } from "@tanstack/react-router"
import { checkfu } from "../../../api.ts"
import { pageSearch } from "../../../page-search.ts"
import { SessionsPage } from "../../../pages/sessions.tsx"

export const Route = createFileRoute("/_app/sessions/")({
	validateSearch: pageSearch,
	loaderDeps: ({ search }) => search,
	loader: ({ deps }) => checkfu.sessions.list(deps.after),
	component: SessionsPage,
})
