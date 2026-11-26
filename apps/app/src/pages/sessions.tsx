import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Field } from "@checkfu/ui/field"
import { shortId, timeAgo } from "@checkfu/ui/format"
import { Input, Textarea } from "@checkfu/ui/input"
import { PageHeader } from "@checkfu/ui/page-header"
import { DataTable } from "@checkfu/ui/table"
import type { JsonSession } from "@checkfu/sdk/client"
import { useQueryClient, useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { PlusIcon } from "lucide-react"
import { useState } from "react"
import type * as React from "react"
import { Pager } from "../pager.tsx"
import { checkfu } from "../api.ts"
import { choicesOf, OptionPicker } from "../option-picker.tsx"
import {
	agentChoices,
	environmentChoices,
	present,
	sessionQuery,
	sessionsPage,
} from "../queries.ts"
import { selection } from "../selection.ts"
import { sessionTitle } from "../session-title.ts"
import { Status } from "../status.tsx"
import { useAction, useSubmissionKey } from "../use-action.ts"
import { Transcript } from "./transcript.tsx"
import { useSessionEvents } from "./use-session-events.ts"

const list = getRouteApi("/_app/sessions/")
const detail = getRouteApi("/_app/sessions/$sessionId")

export function SessionsPage(): React.JSX.Element {
	const search = list.useSearch()
	const page = useSuspenseQuery(sessionsPage(search.after)).data
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
			<Pager next={page.next_page ?? page.next_cursor} paged={search.after !== undefined} />
		</>
	)
}

export function NewSessionPage(): React.JSX.Element {
	const navigate = useNavigate()
	const agentOptions = choicesOf(useSuspenseInfiniteQuery(agentChoices))
	const environmentOptions = choicesOf(useSuspenseInfiniteQuery(environmentChoices))
	const agents = agentOptions.items
	const environments = environmentOptions.items
	const [chosenAgent, setAgentId] = useState(() => agents[0]?.id)
	const [chosenEnvironment, setEnvironmentId] = useState(() => environments[0]?.id)
	const agent = selection(agents, chosenAgent)
	const environment = selection(environments, chosenEnvironment)
	const agentId = agent.id
	const environmentId = environment.id
	const ready = agentId !== "" && environmentId !== ""
	const [title, setTitle] = useState("")
	const startKey = useSubmissionKey()
	const start = useAction(
		async () => {
			if (!ready) {
				return undefined
			}
			const body = {
				agent: agentId,
				environment_id: environmentId,
				title: title.trim() === "" ? null : title.trim(),
			}
			const session = await checkfu.sessions.create(body, startKey.keyFor(body))
			startKey.settle()
			return session
		},
		{
			invalidates: [["sessions"]],
			then: (session) => {
				if (session !== undefined) {
					void navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } })
				}
			},
		},
	)
	return (
		<>
			<PageHeader title="New session" breadcrumb={<Link to="/sessions">Sessions</Link>} />
			{(agents.length === 0 && agentOptions.more === null) ||
			(environments.length === 0 && environmentOptions.more === null) ? (
				<Callout>
					A session needs an{" "}
					<Link to="/agents/new" className="underline">
						agent
					</Link>{" "}
					and an{" "}
					<Link to="/environments/new" className="underline">
						environment
					</Link>
					.
				</Callout>
			) : (
				<form
					className="max-w-2xl"
					onSubmit={(event) => {
						event.preventDefault()
						start.run()
					}}
				>
					<fieldset disabled={start.pending} className="min-w-0 space-y-4">
						<OptionPicker
							label="Agent"
							noun="agents"
							placeholder="Choose an agent"
							options={agentOptions}
							value={agent}
							onChange={setAgentId}
							describe={(agent) => `${agent.name} (${agent.model.id})`}
						/>
						<OptionPicker
							label="Environment"
							noun="environments"
							placeholder="Choose an environment"
							options={environmentOptions}
							value={environment}
							onChange={setEnvironmentId}
							describe={(environment) => environment.name}
						/>
						<Field label="Title">
							<Input value={title} onChange={(event) => setTitle(event.target.value)} />
						</Field>
						{start.error === undefined ? null : <Callout tone="error">{start.error}</Callout>}
						<Button type="submit" disabled={start.pending || !ready}>
							Start session
						</Button>
					</fieldset>
				</form>
			)}
		</>
	)
}

export function SessionPage(): React.JSX.Element {
	const { sessionId } = detail.useParams()
	const session = present(useSuspenseQuery(sessionQuery(sessionId)))
	return <SessionView key={session.id} session={session} />
}

function SessionView({ session }: { readonly session: JsonSession }): React.JSX.Element {
	const queryClient = useQueryClient()
	const { events, reconnecting, earlier } = useSessionEvents({
		session,
		onSnapshotChange: () => void queryClient.invalidateQueries({ queryKey: ["sessions"] }),
	})
	const { status, turn } = session
	const [text, setText] = useState("")
	const sendKey = useSubmissionKey()
	const send = useAction(
		async (message: string) => {
			const body = {
				events: [
					{ type: "user.message" as const, content: [{ type: "text" as const, text: message }] },
				],
			}
			await checkfu.sessions.send(session.id, body, sendKey.keyFor(body))
			sendKey.settle()
		},
		{
			invalidates: [["sessions", "one", session.id]],
			then: (_, message) => {
				setText((current) => (current === message ? "" : current))
			},
		},
	)
	const interruptKey = useSubmissionKey()
	const interrupt = useAction(
		async () => {
			const body = { events: [{ type: "user.interrupt" as const }] }
			await checkfu.sessions.send(session.id, body, interruptKey.keyFor({ ...body, turn }))
			interruptKey.settle()
		},
		{ invalidates: [["sessions", "one", session.id]] },
	)
	const archive = useAction(
		async () => {
			await checkfu.sessions.archive(session.id)
		},
		{ invalidates: [["sessions"]] },
	)
	const archived = session.archived_at !== null
	const open = !archived && status !== "terminated"
	return (
		<>
			<PageHeader
				title={sessionTitle(session) ?? "Untitled session"}
				id={session.id}
				breadcrumb={<Link to="/sessions">Sessions</Link>}
				accessory={<Status status={archived ? "archived" : status} />}
				description={
					<>
						<Link
							to="/agents/$agentId"
							params={{ agentId: session.agent.id }}
							className="hover:underline"
						>
							Agent v{session.agent.version}
						</Link>
						{" · "}
						<Link
							to="/environments/$environmentId"
							params={{ environmentId: session.environment_id }}
							className="hover:underline"
						>
							Environment
						</Link>
						{` · ${session.usage.input_tokens + session.usage.output_tokens} tokens`}
					</>
				}
				actions={
					!archived ? (
						<Button
							variant="destructive"
							size="sm"
							disabled={archive.pending}
							onClick={() => archive.run()}
						>
							Archive
						</Button>
					) : undefined
				}
			/>
			{[
				reconnecting ? "Live updates were interrupted. Reconnecting…" : undefined,
				send.error,
				interrupt.error,
				archive.error,
			].map((message) =>
				message === undefined ? null : (
					<Callout key={message} tone="error">
						{message}
					</Callout>
				),
			)}
			{earlier === null ? null : (
				<div className="space-y-2">
					<Button
						variant="ghost"
						size="sm"
						disabled={earlier.pending}
						onClick={() => earlier.run()}
					>
						Load earlier messages
					</Button>
					{earlier.error === undefined ? null : <Callout tone="error">{earlier.error}</Callout>}
				</div>
			)}
			<Transcript events={events} />
			{open ? (
				<form
					className="sticky bottom-0 space-y-2 bg-background pt-2 pb-4"
					onSubmit={(event) => {
						event.preventDefault()
						if (!send.pending && text.trim() !== "") {
							send.run(text)
						}
					}}
				>
					<Textarea
						aria-label="Message"
						placeholder="Message the agent"
						value={text}
						onChange={(event) => setText(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
								event.currentTarget.form?.requestSubmit()
							}
						}}
					/>
					<div className="flex justify-end gap-2">
						{status === "running" ? (
							<Button
								variant="outline"
								disabled={interrupt.pending}
								onClick={() => interrupt.run()}
							>
								Interrupt
							</Button>
						) : null}
						<Button type="submit" disabled={send.pending || text.trim() === ""}>
							Send
						</Button>
					</div>
				</form>
			) : null}
		</>
	)
}
