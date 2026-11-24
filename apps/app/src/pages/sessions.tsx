import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Field } from "@checkfu/ui/field"
import { shortId, timeAgo } from "@checkfu/ui/format"
import { Input, Select, Textarea } from "@checkfu/ui/input"
import { PageHeader } from "@checkfu/ui/page-header"
import { DataTable } from "@checkfu/ui/table"
import type { JsonSession } from "@checkfu/sdk/client"
import { getRouteApi, Link, useNavigate, useRouter } from "@tanstack/react-router"
import { PlusIcon } from "lucide-react"
import * as React from "react"
import { checkfu } from "../api.ts"
import { Status } from "../status.tsx"
import { useAction } from "../use-action.ts"
import { Transcript, useSessionEvents } from "./transcript.tsx"

const list = getRouteApi("/app/sessions")
const create = getRouteApi("/app/sessions/new")
const detail = getRouteApi("/app/sessions/$sessionId")

export function SessionsPage(): React.JSX.Element {
	const page = list.useLoaderData()
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
								{session.title ?? shortId(session.id)}
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
		</>
	)
}

export function NewSessionPage(): React.JSX.Element {
	const { agents, environments } = create.useLoaderData()
	const navigate = useNavigate()
	const [agentId, setAgentId] = React.useState(agents[0]?.id ?? "")
	const [environmentId, setEnvironmentId] = React.useState(environments[0]?.id ?? "")
	const [title, setTitle] = React.useState("")
	const start = useAction(async () => {
		const session = await checkfu.waitForPending(
			await checkfu.sessions.create({
				agent: agentId,
				environment_id: environmentId,
				title: title.trim() === "" ? null : title.trim(),
			}),
		)
		await navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } })
	})
	return (
		<>
			<PageHeader title="New session" breadcrumb={<Link to="/sessions">Sessions</Link>} />
			{agents.length === 0 || environments.length === 0 ? (
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
					className="max-w-2xl space-y-4"
					onSubmit={(event) => {
						event.preventDefault()
						start.run()
					}}
				>
					<Field label="Agent">
						<Select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
							{agents.map((agent) => (
								<option key={agent.id} value={agent.id}>
									{agent.name} ({agent.model.id})
								</option>
							))}
						</Select>
					</Field>
					<Field label="Environment">
						<Select
							value={environmentId}
							onChange={(event) => setEnvironmentId(event.target.value)}
						>
							{environments.map((environment) => (
								<option key={environment.id} value={environment.id}>
									{environment.name}
								</option>
							))}
						</Select>
					</Field>
					<Field label="Title">
						<Input value={title} onChange={(event) => setTitle(event.target.value)} />
					</Field>
					{start.error === undefined ? null : <Callout tone="error">{start.error}</Callout>}
					<Button type="submit" disabled={start.pending}>
						Start session
					</Button>
				</form>
			)}
		</>
	)
}

export function SessionPage(): React.JSX.Element {
	const session = detail.useLoaderData()
	return <SessionView key={session.id} session={session} />
}

function SessionView({ session }: { readonly session: JsonSession }): React.JSX.Element {
	const router = useRouter()
	const { events, status, error } = useSessionEvents(session.id, session.status)
	const [text, setText] = React.useState("")
	const send = useAction(async (message: string) => {
		await checkfu.sessions.events.send(session.id, {
			events: [{ type: "user.message", content: [{ type: "text", text: message }] }],
		})
		setText("")
	})
	const interrupt = useAction(async () => {
		await checkfu.sessions.events.send(session.id, { events: [{ type: "user.interrupt" }] })
	})
	const archive = useAction(async () => {
		await checkfu.sessions.archive(session.id)
		await router.invalidate()
	})
	const open = session.archived_at === null && status !== "terminated"
	return (
		<>
			<PageHeader
				title={session.title ?? "Untitled session"}
				id={session.id}
				breadcrumb={<Link to="/sessions">Sessions</Link>}
				accessory={<Status status={session.archived_at === null ? status : "archived"} />}
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
					session.archived_at === null ? (
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
			{[error, send.error, interrupt.error, archive.error].map((message) =>
				message === undefined ? null : (
					<Callout key={message} tone="error">
						{message}
					</Callout>
				),
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
