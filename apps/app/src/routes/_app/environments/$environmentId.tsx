import { createFileRoute } from "@tanstack/react-router"
import { EnvironmentPage } from "../../../pages/environments.tsx"
import { environmentQuery } from "../../../queries.ts"

export const Route = createFileRoute("/_app/environments/$environmentId")({
	loader: ({ context, params }) =>
		context.queryClient.ensureQueryData(environmentQuery(params.environmentId)),
	component: EnvironmentPage,
})
