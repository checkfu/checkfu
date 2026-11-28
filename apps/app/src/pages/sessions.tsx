import { Button } from "@checkfu/ui/button"
import { shortId, timeAgo } from "@checkfu/ui/format"
import { PageHeader } from "@checkfu/ui/page-header"
import { DataTable } from "@checkfu/ui/table"
import { useSuspenseQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { PlusIcon } from "lucide-react"
import type * as React from "react"
import { Pager } from "../pager.tsx"
import { sessionsPage } from "../queries.ts"
import { sessionTitle } from "../session-title.ts"
import { Status } from "../status.tsx"

const list = getRouteApi("/_app/sessions/")

export function SessionsPage(): React.JSX.Element {
	const search = list.useSearch()
	const page = useSuspenseQuery(sessionsPage(search.page)).data
	return (
		<>
			<PageHeader
				title="Sessions"
				description="Conversations with an agent in an environment."
				actions={
					<Button size="sm" asChild>
						<Link to="/sessions/new">
							<PlusIcon /> New session
						</Link>
					</Button>
				}
			/>
			<DataTable
				rows={page.data}
				rowKey={(session) => session.id}
				empty="No sessions yet."
				columns={[
					{
						key: "title",
						header: "Session",
						cell: (session) => (
							<Link
								to="/sessions/$sessionId"
								params={{ sessionId: session.id }}
								className="hover:underline"
							>
								{sessionTitle(session) ?? shortId(session.id)}
							</Link>
						),
					},
					{
						key: "status",
						header: "Status",
						cell: (session) => (
							<Status status={session.archived_at === null ? session.status : "archived"} />
						),
					},
					{
						key: "agent",
						header: "Agent",
						cell: (session) => (
							<Link
								to="/agents/$agentId"
								params={{ agentId: session.agent.id }}
								search={{ version: session.agent.version }}
								className="font-mono text-xs hover:underline"
							>
								{shortId(session.agent.id)} v{session.agent.version}
							</Link>
						),
					},
					{
						key: "turns",
						header: "Turns",
						cell: (session) => session.turn,
						className: "text-muted-foreground",
					},
					{
						key: "updated",
						header: "Updated",
						cell: (session) => timeAgo(session.updated_at),
						className: "text-muted-foreground",
					},
				]}
			/>
			<Pager next={page.next_page} paged={search.page !== undefined} />
		</>
	)
}
