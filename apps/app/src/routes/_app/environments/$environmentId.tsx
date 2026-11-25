import { createFileRoute } from "@tanstack/react-router"
import { checkfu } from "../../../api.ts"
import { EnvironmentPage } from "../../../pages/environments.tsx"

export const Route = createFileRoute("/_app/environments/$environmentId")({
	loader: ({ params }) => checkfu.environments.retrieve(params.environmentId),
	component: EnvironmentPage,
})
