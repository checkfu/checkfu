import { createFileRoute } from "@tanstack/react-router"
import { artifactSearch } from "../../../artifact-view.ts"
import { ArtifactPage } from "../../../pages/artifacts.tsx"
import { artifactQuery, artifactVersionQuery } from "../../../queries.ts"

export const Route = createFileRoute("/_app/artifacts/$artifactId")({
	validateSearch: artifactSearch,
	loaderDeps: ({ search }) => ({ version: search.version }),
	loader: ({ context, params, deps }) =>
		Promise.all([
			context.queryClient.ensureQueryData(artifactQuery(params.artifactId)),
			deps.version === undefined
				? undefined
				: context.queryClient.prefetchQuery(artifactVersionQuery(params.artifactId, deps.version)),
		]),
	component: ArtifactPage,
})
