import { createFileRoute } from "@tanstack/react-router"
import { sessionsPage } from "../../../queries.ts"
import { pageSearch } from "../../../page-search.ts"
import { SessionsPage } from "../../../pages/sessions.tsx"

export const Route = createFileRoute("/_app/sessions/")({
	validateSearch: pageSearch,
	loaderDeps: ({ search }) => search,
	loader: ({ context, deps }) => context.queryClient.ensureQueryData(sessionsPage(deps.after)),
	component: SessionsPage,
})
