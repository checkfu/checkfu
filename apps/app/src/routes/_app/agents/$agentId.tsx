import { createFileRoute } from "@tanstack/react-router"
import { checkfu } from "../../../api.ts"
import { AgentPage } from "../../../pages/agents.tsx"

export const Route = createFileRoute("/_app/agents/$agentId")({
	loader: ({ params }) => checkfu.agents.retrieve(params.agentId),
	component: AgentPage,
})
