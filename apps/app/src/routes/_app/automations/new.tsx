import { createFileRoute } from "@tanstack/react-router"
import { NewAutomationPage } from "../../../pages/automations.tsx"
import { agentChoices, environmentChoices } from "../../../queries.ts"

export const Route = createFileRoute("/_app/automations/new")({
	loader: ({ context }) =>
		Promise.all([
			context.queryClient.ensureInfiniteQueryData(agentChoices),
			context.queryClient.ensureInfiniteQueryData(environmentChoices),
		]),
	component: NewAutomationPage,
})
