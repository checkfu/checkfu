import { createFileRoute } from "@tanstack/react-router"
import { checkfu } from "../../../api.ts"
import { SessionPage } from "../../../pages/sessions.tsx"

export const Route = createFileRoute("/_app/sessions/$sessionId")({
	loader: ({ params }) => checkfu.sessions.retrieve(params.sessionId),
	component: SessionPage,
})
