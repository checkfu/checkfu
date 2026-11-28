import type * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { NewSessionPage } from "../../../pages/new-session.tsx"
import { agentChoices, environmentChoices } from "../../../queries.ts"

export const Route = createFileRoute("/_app/sessions/new")({
	validateSearch: (search: { readonly file?: unknown }): { readonly file?: string } =>
		typeof search["file"] === "string" && search["file"] !== "" ? { file: search["file"] } : {},
	loader: ({ context }) =>
		Promise.all([
			context.queryClient.ensureInfiniteQueryData(agentChoices),
			context.queryClient.ensureInfiniteQueryData(environmentChoices),
		]),
	component: NewSessionRoute,
})

function NewSessionRoute(): React.JSX.Element {
	const { file } = Route.useSearch()
	return <NewSessionPage fileId={file} />
}
