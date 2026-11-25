import { createFileRoute } from "@tanstack/react-router"
import { NewSessionPage } from "../../../pages/sessions.tsx"
import { agentChoices, environmentChoices } from "../../../queries.ts"

export const Route = createFileRoute("/_app/sessions/new")({
	loader: ({ context }) =>
		Promise.all([
			context.queryClient.ensureInfiniteQueryData(agentChoices),
			context.queryClient.ensureInfiniteQueryData(environmentChoices),
		]),
	component: NewSessionPage,
})
