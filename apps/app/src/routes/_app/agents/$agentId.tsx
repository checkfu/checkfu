import { createFileRoute } from "@tanstack/react-router"
import { AgentPage } from "../../../pages/agents.tsx"
import { agentQuery } from "../../../queries.ts"

export const Route = createFileRoute("/_app/agents/$agentId")({
	loader: ({ context, params }) => context.queryClient.ensureQueryData(agentQuery(params.agentId)),
	component: AgentPage,
})
