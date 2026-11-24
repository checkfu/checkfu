import { createFileRoute } from "@tanstack/react-router"
import { checkfu } from "../../../api.ts"
import { NewSessionPage } from "../../../pages/sessions.tsx"

export const Route = createFileRoute("/_app/sessions/new")({
	loader: async () => {
		const [agents, environments] = await Promise.all([
			checkfu.agents.list(),
			checkfu.environments.list(),
		])
		return { agents, environments }
	},
	component: NewSessionPage,
})
