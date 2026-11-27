import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Field } from "@checkfu/ui/field"
import { shortId, timeAgo } from "@checkfu/ui/format"
import { Input, Select, Textarea } from "@checkfu/ui/input"
import { Description, DescriptionList, PageHeader } from "@checkfu/ui/page-header"
import { DataTable } from "@checkfu/ui/table"
import type { JsonSession } from "@checkfu/sdk/client"
import {
	useInfiniteQuery,
	useQueryClient,
	useSuspenseInfiniteQuery,
	useSuspenseQuery,
} from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { PlusIcon, XIcon } from "lucide-react"
import { useState } from "react"
import type * as React from "react"
import { Pager } from "../pager.tsx"
import { checkfu, errorMessage, isSignedOut } from "../api.ts"
import { choicesOf, OptionPicker } from "../option-picker.tsx"
import {
	agentChoices,
	artifactChoices,
	environmentChoices,
	memoryStoreChoices,
	present,
	sessionQuery,
	sessionsPage,
	vaultChoices,
} from "../queries.ts"
import { selection } from "../selection.ts"
import {
	RESOURCE_LABELS,
	describeResource,
	emptyDraft,
	namesResource,
	resourceBody,
	resourceIdentity,
} from "../session-resources.ts"
import type { ResourceDraft, ResourceType, SessionResourceItem } from "../session-resources.ts"
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

const NO_VAULTS: ReadonlyArray<string> = []
const NO_CREDENTIALS: ExplicitCredentials = {}

type ResourceDraftRow = ResourceDraft & { readonly key: string }

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
	const [title, setTitle] = useState("")
	const [resources, setResources] = useState<ReadonlyArray<ResourceDraftRow>>([])
	const ready = agentId !== "" && environmentId !== "" && resources.every(namesResource)
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
				...(resources.length === 0 ? {} : { resources: resources.map(resourceBody) }),
				...bindingsOf(servers, chosenVaults, chosenCredentials, choices.credentials),
			}
			const identity = {
				...body,
				...(resources.length === 0 ? {} : { resources: resources.map(resourceIdentity) }),
			}
			const session = await checkfu.sessions.create(body, startKey.keyFor(identity))
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
						<ResourcesEditor drafts={resources} onChange={setResources} />
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
	const { events, preview, calls, reconnecting, earlier, findingCalls } = useSessionEvents({
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
							search={{ version: session.agent.version }}
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
			{session.resources.length === 0 ? null : <SessionResources session={session} open={open} />}
			<Transcript
				events={events}
				preview={preview}
				calls={calls.fold}
				send={open ? sendAnswer : undefined}
			/>
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

function ResourcesEditor({
	drafts,
	onChange,
}: {
	readonly drafts: ReadonlyArray<ResourceDraftRow>
	readonly onChange: (drafts: ReadonlyArray<ResourceDraftRow>) => void
}): React.JSX.Element {
	const types: ReadonlyArray<ResourceType> = [
		"github_repository",
		"memory_store",
		"artifact",
		"skill",
	]
	return (
		<div className="space-y-3">
			<div>
				<h2 className="text-sm font-medium">Resources</h2>
				<p className="text-control text-muted-foreground">
					Mounted in the workspace: repositories under /workspace, memory under /mnt/memory,
					artifact files under /mnt/artifacts and skills under /mnt/skills.
				</p>
			</div>
			{drafts.map((draft, index) => (
				<div key={draft.key} className="space-y-3 rounded-lg border p-3">
					<div className="flex items-center justify-between">
						<span className="text-sm font-medium">{RESOURCE_LABELS[draft.type]}</span>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={`Remove ${RESOURCE_LABELS[draft.type].toLowerCase()}`}
							onClick={() => onChange(drafts.filter((_, at) => at !== index))}
						>
							<XIcon />
						</Button>
					</div>
					<ResourceFields
						draft={draft}
						onChange={(next) => onChange(drafts.with(index, { ...next, key: draft.key }))}
					/>
				</div>
			))}
			<div className="flex flex-wrap gap-2">
				{types.map((type) => (
					<Button
						key={type}
						variant="outline"
						size="sm"
						onClick={() => onChange([...drafts, { ...emptyDraft(type), key: crypto.randomUUID() }])}
					>
						<PlusIcon /> {RESOURCE_LABELS[type]}
					</Button>
				))}
			</div>
		</div>
	)
}

function ResourceFields({
	draft,
	onChange,
}: {
	readonly draft: ResourceDraft
	readonly onChange: (draft: ResourceDraft) => void
}): React.JSX.Element {
	switch (draft.type) {
		case "github_repository":
			return (
				<>
					<Field label="URL">
						<Input
							required
							placeholder="https://github.com/owner/repository"
							value={draft.url}
							onChange={(event) => onChange({ ...draft, url: event.target.value })}
						/>
					</Field>
					<Field label="Token" description="Used to clone and push. Never shown again.">
						<Input
							type="password"
							autoComplete="off"
							value={draft.token}
							onChange={(event) => onChange({ ...draft, token: event.target.value })}
						/>
					</Field>
					<Field label="Branch or commit" description="Defaults to the default branch.">
						<Input
							value={draft.checkout}
							onChange={(event) => onChange({ ...draft, checkout: event.target.value })}
						/>
					</Field>
					<Field label="Mount path" description="Defaults to /workspace/<repository>.">
						<Input
							className="font-mono"
							value={draft.mountPath}
							onChange={(event) => onChange({ ...draft, mountPath: event.target.value })}
						/>
					</Field>
				</>
			)
		case "memory_store":
			return (
				<>
					<MemoryStorePicker
						chosen={draft.memoryStoreId}
						onChange={(memoryStoreId) => onChange({ ...draft, memoryStoreId })}
					/>
					<Field label="Access">
						<Select
							value={draft.access}
							onChange={(event) =>
								onChange({
									...draft,
									access: event.target.value === "read_only" ? "read_only" : "read_write",
								})
							}
						>
							<option value="read_write">Read and write</option>
							<option value="read_only">Read only</option>
						</Select>
					</Field>
					<Field label="Instructions" description="How this session should use the store.">
						<Input
							value={draft.instructions}
							onChange={(event) => onChange({ ...draft, instructions: event.target.value })}
						/>
					</Field>
				</>
			)
		case "artifact":
		case "skill":
			return (
				<>
					<ArtifactPicker
						skill={draft.type === "skill"}
						chosen={draft.artifactId}
						onChange={(artifactId) => onChange({ ...draft, artifactId })}
					/>
					<Field label="Version" description="Defaults to the current version.">
						<Input
							type="number"
							min={1}
							value={draft.version}
							onChange={(event) => onChange({ ...draft, version: event.target.value })}
						/>
					</Field>
				</>
			)
	}
}

interface LazyChoices<T> {
	readonly data: { readonly pages: ReadonlyArray<{ readonly data: ReadonlyArray<T> }> } | undefined
	readonly isFetchingNextPage: boolean
	readonly error: unknown
	readonly hasNextPage: boolean
	readonly fetchNextPage: () => Promise<{ readonly isError: boolean }>
}

function LazyPicker<T extends { readonly id: string }>({
	query,
	label,
	noun,
	placeholder,
	empty,
	chosen,
	onChange,
	describe,
}: {
	readonly query: LazyChoices<T>
	readonly label: string
	readonly noun: string
	readonly placeholder: string
	readonly empty: React.ReactNode
	readonly chosen: string
	readonly onChange: (id: string) => void
	readonly describe: (option: T) => string
}): React.JSX.Element {
	const { data, error, isFetchingNextPage, hasNextPage, fetchNextPage } = query
	if (data === undefined) {
		return error === null || isSignedOut(error) ? (
			<p className="text-control text-muted-foreground">Loading {noun}…</p>
		) : (
			<Callout tone="error">{errorMessage(error)}</Callout>
		)
	}
	const options = choicesOf({ data, error, isFetchingNextPage, hasNextPage, fetchNextPage })
	if (options.items.length === 0 && options.more === null) {
		return <Callout>{empty}</Callout>
	}
	return (
		<OptionPicker
			label={label}
			noun={noun}
			placeholder={placeholder}
			options={options}
			value={chosen === "" ? { id: "", gone: false } : selection(options.items, chosen)}
			onChange={onChange}
			describe={describe}
		/>
	)
}

function MemoryStorePicker({
	chosen,
	onChange,
}: {
	readonly chosen: string
	readonly onChange: (id: string) => void
}): React.JSX.Element {
	return (
		<LazyPicker
			query={useInfiniteQuery(memoryStoreChoices)}
			label="Store"
			noun="memory stores"
			placeholder="Choose a store"
			empty={
				<>
					There are no memory stores yet.{" "}
					<Link to="/memory-stores/new" className="underline">
						Create one
					</Link>
					.
				</>
			}
			chosen={chosen}
			onChange={onChange}
			describe={(memoryStore) => memoryStore.name}
		/>
	)
}

function ArtifactPicker({
	skill,
	chosen,
	onChange,
}: {
	readonly skill: boolean
	readonly chosen: string
	readonly onChange: (id: string) => void
}): React.JSX.Element {
	return (
		<LazyPicker
			query={useInfiniteQuery(artifactChoices)}
			label={skill ? "Skill" : "Artifact"}
			noun="artifacts"
			placeholder={skill ? "Choose an artifact with a SKILL.md at its root" : "Choose an artifact"}
			empty="There are no artifacts yet. Create one with the CLI or the API."
			chosen={chosen}
			onChange={onChange}
			describe={(artifact) => `${artifact.name} (v${artifact.version})`}
		/>
	)
}

function SessionResources({
	session,
	open,
}: {
	readonly session: JsonSession
	readonly open: boolean
}): React.JSX.Element {
	return (
		<details className="rounded-lg border p-3 text-sm">
			<summary className="cursor-pointer font-medium">
				Resources ({session.resources.length})
			</summary>
			<div className="mt-3">
				<DescriptionList>
					{session.resources.map((resource) => (
						<Description key={resource.id} label={describeResource(resource).label}>
							<ResourceLine session={session} resource={resource} open={open} />
						</Description>
					))}
				</DescriptionList>
			</div>
		</details>
	)
}

function ResourceLine({
	session,
	resource,
	open,
}: {
	readonly session: JsonSession
	readonly resource: SessionResourceItem
	readonly open: boolean
}): React.JSX.Element {
	const { name, detail } = describeResource(resource)
	const [token, setToken] = useState<string | null>(null)
	const rotate = useAction(
		async (next: string) => {
			await checkfu.sessions.rotateToken(session.id, resource.id, next)
		},
		{ then: () => setToken(null) },
	)
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-baseline gap-x-2">
				{resource.type === "memory_store" ? (
					<Link
						to="/memory-stores/$memoryStoreId"
						params={{ memoryStoreId: resource.memory_store_id }}
						className="hover:underline"
					>
						{name}
					</Link>
				) : (
					<span>{name}</span>
				)}
				<span className="text-muted-foreground">{detail}</span>
				<span className="font-mono text-xs text-muted-foreground">{resource.mount_path}</span>
				{resource.type === "github_repository" && open && token === null ? (
					<Button variant="ghost" size="sm" onClick={() => setToken("")}>
						Replace token
					</Button>
				) : null}
			</div>
			{token === null ? null : (
				<form
					className="flex gap-2"
					onSubmit={(event) => {
						event.preventDefault()
						rotate.run(token)
					}}
				>
					<Input
						type="password"
						autoComplete="off"
						aria-label="New token"
						value={token}
						onChange={(event) => setToken(event.target.value)}
					/>
					<Button type="submit" size="sm" disabled={rotate.pending || token === ""}>
						Save
					</Button>
					<Button variant="ghost" size="sm" onClick={() => setToken(null)}>
						Cancel
					</Button>
				</form>
			)}
			{rotate.error === undefined ? null : <Callout tone="error">{rotate.error}</Callout>}
		</div>
	)
}
