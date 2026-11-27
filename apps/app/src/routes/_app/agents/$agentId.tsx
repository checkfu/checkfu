import { createFileRoute } from "@tanstack/react-router"
import { AgentPage } from "../../../pages/agents.tsx"
import { agentQuery } from "../../../queries.ts"

interface AgentSearch {
	readonly version?: number
}

const agentSearch = ({ version }: { readonly version?: unknown }): AgentSearch => {
	if (version === undefined) {
		return {}
	}
	if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
		throw new Error("Agent version must be a positive integer.")
	}
	return { version }
}

export const Route = createFileRoute("/_app/agents/$agentId")({
	validateSearch: agentSearch,
	loaderDeps: ({ search }) => ({ version: search.version }),
	loader: ({ context, params, deps }) =>
		context.queryClient.ensureQueryData(agentQuery(params.agentId, deps.version)),
	component: AgentPage,
})
