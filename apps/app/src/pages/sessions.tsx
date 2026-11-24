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
import { useState } from "react"
import type * as React from "react"
import { Pager } from "../pager.tsx"
import { checkfu } from "../api.ts"
import type { EventPage } from "../api.ts"
import { useMorePages } from "../use-more-pages.ts"
import { Status } from "../status.tsx"
import { useAction, useSubmissionKey } from "../use-action.ts"
import { Transcript } from "./transcript.tsx"
import { useSessionEvents } from "./use-session-events.ts"

const list = getRouteApi("/_app/sessions/")
const create = getRouteApi("/_app/sessions/new")
const detail = getRouteApi("/_app/sessions/$sessionId")

export function SessionsPage(): React.JSX.Element {
	const page = list.useLoaderData()
	const search = list.useSearch()
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
			<Pager next={page.next_cursor} paged={search.after !== undefined} />
		</>
	)
}

const selectedOrFirst = (
	options: ReadonlyArray<{ readonly id: string }>,
	chosen: string | undefined,
): string =>
	options.some((option) => option.id === chosen) ? (chosen ?? "") : (options[0]?.id ?? "")

function OptionPicker<T extends { readonly id: string }>({
	label,
	noun,
	options,
	value,
	onChange,
	describe,
}: {
	readonly label: string
	readonly noun: string
	readonly options: ReturnType<typeof useMorePages<T>>
	readonly value: string
	readonly onChange: (id: string) => void
	readonly describe: (option: T) => string
}): React.JSX.Element {
	return (
		<div className="space-y-2">
			<Field label={label}>
				<Select value={value} onChange={(event) => onChange(event.target.value)}>
					{options.items.map((option) => (
						<option key={option.id} value={option.id}>
							{describe(option)}
						</option>
					))}
				</Select>
			</Field>
			{options.more === null ? null : (
				<Button variant="ghost" size="sm" disabled={options.pending} onClick={options.more}>
					Load more {noun}
				</Button>
			)}
			{options.error === undefined ? null : <Callout tone="error">{options.error}</Callout>}
		</div>
	)
}

export function NewSessionPage(): React.JSX.Element {
	const first = create.useLoaderData()
	const navigate = useNavigate()
	const agentOptions = useMorePages(first.agents, (after) => checkfu.agents.list(after))
	const environmentOptions = useMorePages(first.environments, (after) =>
		checkfu.environments.list(after),
	)
	const agents = agentOptions.items
	const environments = environmentOptions.items
	const [chosenAgent, setAgentId] = useState<string>()
	const [chosenEnvironment, setEnvironmentId] = useState<string>()
	const agentId = selectedOrFirst(agents, chosenAgent)
	const environmentId = selectedOrFirst(environments, chosenEnvironment)
	const [title, setTitle] = useState("")
	const startKey = useSubmissionKey()
	const start = useAction(async () => {
		const body = {
			agent: agentId,
			environment_id: environmentId,
			title: title.trim() === "" ? null : title.trim(),
		}
		const session = await checkfu.sessions.create(body, startKey.keyFor(body))
		startKey.settle()
		await navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } })
	})
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
					className="max-w-2xl space-y-4"
					onSubmit={(event) => {
						event.preventDefault()
						start.run()
					}}
				>
					<OptionPicker
						label="Agent"
						noun="agents"
						options={agentOptions}
						value={agentId}
						onChange={setAgentId}
						describe={(agent) => `${agent.name} (${agent.model.id})`}
					/>
					<OptionPicker
						label="Environment"
						noun="environments"
						options={environmentOptions}
						value={environmentId}
						onChange={setEnvironmentId}
						describe={(environment) => environment.name}
					/>
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
	const { session, history } = detail.useLoaderData()
	return <SessionView key={session.id} session={session} history={history} />
}

function SessionView({
	session,
	history,
}: {
	readonly session: JsonSession
	readonly history: EventPage
}): React.JSX.Element {
	const router = useRouter()
	const { events, status, turn, error, earlier } = useSessionEvents({
		sessionId: session.id,
		snapshot: session,
		history,
		onTransition: () => void router.invalidate(),
	})
	const [text, setText] = useState("")
	const sendKey = useSubmissionKey()
	const send = useAction(async (message: string) => {
		const body = {
			events: [
				{ type: "user.message" as const, content: [{ type: "text" as const, text: message }] },
			],
		}
		await checkfu.sessions.send(session.id, body, sendKey.keyFor(body))
		sendKey.settle()
		setText((current) => (current === message ? "" : current))
	})
	const interruptKey = useSubmissionKey()
	const interrupt = useAction(async () => {
		const body = { events: [{ type: "user.interrupt" as const }] }
		await checkfu.sessions.send(session.id, body, interruptKey.keyFor({ ...body, turn }))
		interruptKey.settle()
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
