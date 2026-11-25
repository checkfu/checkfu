import { createFileRoute } from "@tanstack/react-router"
import { checkfu } from "../../../api.ts"
import { AgentsPage } from "../../../pages/agents.tsx"

export const Route = createFileRoute("/_app/agents/")({
	loader: () => checkfu.agents.list(),
	component: AgentsPage,
})
