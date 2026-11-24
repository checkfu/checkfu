import { createFileRoute } from "@tanstack/react-router"
import { SessionPage } from "../../../pages/sessions.tsx"
import { sessionHistory, sessionQuery } from "../../../queries.ts"

export const Route = createFileRoute("/_app/sessions/$sessionId")({
	loader: ({ context, params }) =>
		Promise.all([
			context.queryClient.ensureQueryData(sessionQuery(params.sessionId)),
			context.queryClient.ensureInfiniteQueryData(sessionHistory(params.sessionId)),
		]),
	component: SessionPage,
})
