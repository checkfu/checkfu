import { createFileRoute } from "@tanstack/react-router"
import { checkfu } from "../../../api.ts"
import { SessionPage } from "../../../pages/sessions.tsx"

export const Route = createFileRoute("/_app/sessions/$sessionId")({
	loader: async ({ params }) => {
		const [session, history] = await Promise.all([
			checkfu.sessions.retrieve(params.sessionId),
			checkfu.sessions.events(params.sessionId),
		])
		return { session, history }
	},
	component: SessionPage,
})
