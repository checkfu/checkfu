import { createFileRoute } from "@tanstack/react-router"
import { artifactsPage } from "../../../queries.ts"
import { pageSearch } from "../../../page-search.ts"
import { ArtifactsPage } from "../../../pages/artifacts.tsx"

export const Route = createFileRoute("/_app/artifacts/")({
	validateSearch: pageSearch,
	loaderDeps: ({ search }) => search,
	loader: ({ context, deps }) => context.queryClient.ensureQueryData(artifactsPage(deps.page)),
	component: ArtifactsPage,
})
