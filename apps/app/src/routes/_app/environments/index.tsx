import { createFileRoute } from "@tanstack/react-router"
import { checkfu } from "../../../api.ts"
import { pageSearch } from "../../../page-search.ts"
import { EnvironmentsPage } from "../../../pages/environments.tsx"

export const Route = createFileRoute("/_app/environments/")({
	validateSearch: pageSearch,
	loaderDeps: ({ search }) => search,
	loader: ({ deps }) => checkfu.environments.list(deps.after),
	component: EnvironmentsPage,
})
