import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Field } from "@checkfu/ui/field"
import { shortId, timeAgo } from "@checkfu/ui/format"
import { Input, Textarea } from "@checkfu/ui/input"
import { PageHeader } from "@checkfu/ui/page-header"
import { DataTable } from "@checkfu/ui/table"
import type { JsonSession } from "@checkfu/sdk/client"
import {
	useInfiniteQuery,
	useQueryClient,
	useSuspenseInfiniteQuery,
	useSuspenseQuery,
} from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { PlusIcon } from "lucide-react"
import { useState } from "react"
import type * as React from "react"
import { Pager } from "../pager.tsx"
import { checkfu, errorMessage } from "../api.ts"
import { choicesOf, OptionPicker } from "../option-picker.tsx"
import {
	agentChoices,
	environmentChoices,
	present,
	sessionQuery,
	sessionsPage,
	vaultChoices,
} from "../queries.ts"
import { selection } from "../selection.ts"
import { sessionTitle } from "../session-title.ts"
import { Status } from "../status.tsx"
import { useAction, useSubmissionKey } from "../use-action.ts"
import { sendFailure } from "./tool-call.tsx"
import type { SendAnswer } from "./tool-call.tsx"
import {
	bindingsOf,
	hasFailedLookup,
	hasGoneSelection,
	placeError,
	SessionBindings,
	SessionCredentialFields,
	useSessionChoices,
} from "./session-bindings.tsx"
import type { ExplicitCredentials } from "./session-bindings.tsx"
import { Transcript } from "./transcript.tsx"
import { useSessionEvents } from "./use-session-events.ts"

const list = getRouteApi("/_app/sessions/")
const detail = getRouteApi("/_app/sessions/$sessionId")

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

const NO_VAULTS: ReadonlyArray<string> = []
const NO_CREDENTIALS: ExplicitCredentials = {}

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
	const [picked, setPicked] = useState<{
		readonly agentId: string
		readonly vaultIds: ReadonlyArray<string>
		readonly explicit: ExplicitCredentials
	}>({ agentId: "", vaultIds: NO_VAULTS, explicit: NO_CREDENTIALS })
	const mine = picked.agentId === agentId ? picked : undefined
	const vaultIds = mine?.vaultIds ?? NO_VAULTS
	const explicit = mine?.explicit ?? NO_CREDENTIALS
	const setVaultIds = (ids: ReadonlyArray<string>) =>
		setPicked({ agentId, vaultIds: ids, explicit })
	const setExplicit = (next: ExplicitCredentials) =>
		setPicked({ agentId, vaultIds, explicit: next })
	const shown = agents.find((option) => option.id === agentId)
	const servers = shown?.mcp_servers ?? []
	const usesVaults = servers.length > 0
	const vaultQuery = useInfiniteQuery({ ...vaultChoices, enabled: usesVaults })
	const vaultList = {
		items: usesVaults ? (vaultQuery.data?.pages.flatMap((page) => page.data) ?? []) : [],
		more: usesVaults && vaultQuery.hasNextPage ? () => void vaultQuery.fetchNextPage() : null,
		loading: usesVaults && vaultQuery.isPending,
		error:
			!usesVaults || vaultQuery.error === null || vaultQuery.isFetchNextPageError
				? undefined
				: errorMessage(vaultQuery.error),
		moreError:
			usesVaults && vaultQuery.isFetchNextPageError && vaultQuery.error !== null
				? errorMessage(vaultQuery.error)
				: undefined,
		retry: () => void vaultQuery.refetch(),
	}
	const chosenVaults = usesVaults ? vaultIds : NO_VAULTS
	const chosenCredentials = usesVaults ? explicit : NO_CREDENTIALS
	const choices = useSessionChoices(servers, vaultList.items, chosenVaults, chosenCredentials)
	const blocked = hasGoneSelection(choices.gone)
	const unchecked = hasFailedLookup(choices.failed)
	const canStart = ready && !blocked && !unchecked && !choices.checking
	const startKey = useSubmissionKey()
	const start = useAction(
		async () => {
			if (!canStart) {
				return undefined
			}
			const body = {
				agent:
					shown === undefined
						? agentId
						: { type: "agent" as const, id: shown.id, version: shown.version },
				environment_id: environmentId,
				title: title.trim() === "" ? null : title.trim(),
				...bindingsOf(servers, chosenVaults, chosenCredentials, choices.credentials),
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
	const startError = placeError(start.error, servers)
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
						<SessionCredentialFields
							agent={agents.find((option) => option.id === agentId)}
							vaultList={vaultList}
							vaultIds={chosenVaults}
							onVaults={setVaultIds}
							explicit={chosenCredentials}
							onExplicit={setExplicit}
							error={startError}
						/>
						{startError.server !== undefined || startError.message === undefined ? null : (
							<Callout tone="error">{startError.message}</Callout>
						)}
						{blocked ? (
							<Callout tone="error">
								A vault or credential chosen above is no longer available. Remove or replace it to
								start the session.
							</Callout>
						) : null}
						{unchecked ? (
							<Callout tone="error">
								A vault or credential chosen above could not be checked. Retry it, or remove it, to
								start the session.
							</Callout>
						) : null}
						{choices.checking ? (
							<p className="text-control text-muted-foreground">Checking your choices…</p>
						) : null}
						<Button type="submit" disabled={start.pending || !canStart}>
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
	const { events, calls, reconnecting, earlier, findingCalls } = useSessionEvents({
		session,
		onSnapshotChange: () => void queryClient.invalidateQueries({ queryKey: ["sessions"] }),
	})
	const { status, turn } = session
	const waiting = calls.waiting.size
	const [text, setText] = useState("")
	const sendKey = useSubmissionKey()
	const send = useAction(
		async (message: string) => {
			const body = {
				events: [
					{ type: "user.message" as const, content: [{ type: "text" as const, text: message }] },
				],
			}
			await checkfu.sessions
				.send(session.id, body, sendKey.keyFor(body))
				.catch((error: unknown) => {
					throw sendFailure(error)
				})
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
	const canSend = !send.pending && waiting === 0 && text.trim() !== ""
	const sendAnswer: SendAnswer = async (event, idempotencyKey) => {
		await checkfu.sessions.send(session.id, { events: [event] }, idempotencyKey)
	}
	return (
		<>
			<PageHeader
				title={sessionTitle(session) ?? "Untitled session"}
				id={session.id}
				breadcrumb={<Link to="/sessions">Sessions</Link>}
				accessory={<Status status={archived ? "archived" : waiting > 0 ? "waiting" : status} />}
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
			<SessionBindings session={session} />
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
			<Transcript events={events} calls={calls.fold} send={open ? sendAnswer : undefined} />
			{open && findingCalls !== null ? (
				findingCalls.error !== undefined ? (
					<div className="space-y-2">
						<Callout tone="error">
							The tool call waiting on you could not be loaded: {findingCalls.error}
						</Callout>
						<Button variant="outline" size="sm" onClick={findingCalls.retry}>
							Retry
						</Button>
					</div>
				) : (
					<Callout>
						{findingCalls.pending
							? "Loading the tool call waiting on you…"
							: "A tool call is waiting on you, but it is not in this session's history. Interrupt to end the turn."}
					</Callout>
				)
			) : null}
			{open && waiting > 0 && findingCalls === null ? (
				<Callout>
					The agent is waiting on you to answer{" "}
					{waiting === 1 ? "a tool call" : `${waiting} tool calls`} above. It takes no new message
					until then; interrupt to end the turn without answering.
				</Callout>
			) : null}
			{open ? (
				<form
					className="sticky bottom-0 space-y-2 bg-background pt-2 pb-4"
					onSubmit={(event) => {
						event.preventDefault()
						if (canSend) {
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
						{status === "running" || waiting > 0 ? (
							<Button
								variant="outline"
								disabled={interrupt.pending}
								onClick={() => interrupt.run()}
							>
								Interrupt
							</Button>
						) : null}
						<Button type="submit" disabled={!canSend}>
							Send
						</Button>
					</div>
				</form>
			) : null}
		</>
	)
}
