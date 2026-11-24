import { createFileRoute } from "@tanstack/react-router"
import { checkfu } from "../../../api.ts"
import { EnvironmentsPage } from "../../../pages/environments.tsx"

export const Route = createFileRoute("/_app/environments/")({
	loader: () => checkfu.environments.list(),
	component: EnvironmentsPage,
})
