import { createFileRoute } from "@tanstack/react-router"
import { SessionPage } from "../../../pages/sessions.tsx"
import { sessionQuery, transcriptQuery } from "../../../queries.ts"

export const Route = createFileRoute("/_app/sessions/$sessionId")({
	loader: ({ context, params }) =>
		Promise.all([
			context.queryClient.ensureQueryData(sessionQuery(params.sessionId)),
			context.queryClient.ensureInfiniteQueryData(transcriptQuery(params.sessionId)),
		]),
	component: SessionPage,
})
