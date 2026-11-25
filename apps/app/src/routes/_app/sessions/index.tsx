import { createFileRoute } from "@tanstack/react-router"
import { checkfu } from "../../../api.ts"
import { SessionsPage } from "../../../pages/sessions.tsx"

export const Route = createFileRoute("/_app/sessions/")({
	loader: () => checkfu.sessions.list(),
	component: SessionsPage,
})
