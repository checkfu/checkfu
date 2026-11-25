import { createFileRoute } from "@tanstack/react-router"
import { AutomationPage } from "../../../pages/automations.tsx"
import { automationQuery, automationRunsQuery } from "../../../queries.ts"

export const Route = createFileRoute("/_app/automations/$automationId")({
	loader: ({ context, params }) =>
		Promise.all([
			context.queryClient.ensureQueryData(automationQuery(params.automationId)),
			context.queryClient.ensureInfiniteQueryData(automationRunsQuery(params.automationId)),
		]),
	component: AutomationPage,
})
