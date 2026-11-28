import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Field } from "@checkfu/ui/field"
import { Input, Select } from "@checkfu/ui/input"
import { PageHeader } from "@checkfu/ui/page-header"
import { useInfiniteQuery, useQueries, useSuspenseInfiniteQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { PlusIcon, XIcon } from "lucide-react"
import { useState } from "react"
import type * as React from "react"
import { checkfu, errorMessage } from "../api.ts"
import { choicesOf, OptionPicker } from "../option-picker.tsx"
import {
	agentChoices,
	artifactChoices,
	artifactQuery,
	environmentChoices,
	lookup,
	memoryStoreChoices,
	memoryStoreQuery,
	vaultChoices,
} from "../queries.ts"
import type { Lookup } from "../queries.ts"
import { selection } from "../selection.ts"
import {
	RESOURCE_LABELS,
	checkoutError,
	emptyDraft,
	namesResource,
	resourceBody,
	resourceIdentity,
} from "../session-resources.ts"
import type { ResourceDraft, ResourceType } from "../session-resources.ts"
import { useAction, useSubmissionKey } from "../use-action.ts"
import {
	bindingsOf,
	hasFailedLookup,
	hasGoneSelection,
	placeError,
	SessionCredentialFields,
	useSessionChoices,
} from "./session-bindings.tsx"
import type { ExplicitCredentials } from "./session-bindings.tsx"

const NO_VAULTS: ReadonlyArray<string> = []
const NO_CREDENTIALS: ExplicitCredentials = {}

type ResourceDraftRow = ResourceDraft & { readonly key: string }

type MountCheck = Lookup<string> & { readonly retry: () => void }

const mountCheck = <T,>(
	query: {
		readonly data: T | undefined
		readonly error: unknown
		readonly isFetching: boolean
		readonly refetch: () => void
	},
	describe: (item: T) => string,
	active?: (item: T) => boolean,
): MountCheck => {
	const retry = () => void query.refetch()
	const status = lookup(query, active)
	if (query.isFetching) {
		return { state: "pending", retry }
	}
	return status.state === "active"
		? { state: "active", found: describe(status.found), retry }
		: { ...status, retry }
}

const useMountChecks = (drafts: ReadonlyArray<ResourceDraftRow>) => {
	const storeIds = [
		...new Set(
			drafts.flatMap((draft) =>
				draft.type === "memory_store" && draft.memoryStoreId !== "" ? [draft.memoryStoreId] : [],
			),
		),
	]
	const artifactIds = [
		...new Set(
			drafts.flatMap((draft) =>
				(draft.type === "artifact" || draft.type === "skill") && draft.artifactId !== ""
					? [draft.artifactId]
					: [],
			),
		),
	]
	const stores = useQueries({
		queries: storeIds.map((id) => ({ ...memoryStoreQuery(id), retry: false })),
		combine: (results) =>
			results.map((query) =>
				mountCheck(
					query,
					(store) => store.name,
					(store) => store.archived_at === null,
				),
			),
	})
	const artifacts = useQueries({
		queries: artifactIds.map((id) => ({ ...artifactQuery(id), retry: false })),
		combine: (results) =>
			results.map((query) =>
				mountCheck(query, (artifact) => `${artifact.name} (v${artifact.version})`),
			),
	})
	const checks = new Map<string, MountCheck>()
	for (const draft of drafts) {
		const result =
			draft.type === "memory_store"
				? stores[storeIds.indexOf(draft.memoryStoreId)]
				: draft.type === "github_repository"
					? undefined
					: artifacts[artifactIds.indexOf(draft.artifactId)]
		if (result !== undefined) {
			checks.set(draft.key, result)
		}
	}
	return checks
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
	const [title, setTitle] = useState("")
	const [resources, setResources] = useState<ReadonlyArray<ResourceDraftRow>>([])
	const mountChecks = useMountChecks(resources)
	const ready =
		agentId !== "" &&
		environmentId !== "" &&
		resources.every(
			(resource) =>
				namesResource(resource) &&
				checkoutError(resource) === undefined &&
				(resource.type === "github_repository" ||
					mountChecks.get(resource.key)?.state === "active"),
		)
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
	const startError = placeError(start.error, start.errorCode, servers)
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
						<ResourcesEditor drafts={resources} checks={mountChecks} onChange={setResources} />
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

function ResourcesEditor({
	drafts,
	checks,
	onChange,
}: {
	readonly drafts: ReadonlyArray<ResourceDraftRow>
	readonly checks: ReadonlyMap<string, MountCheck>
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
						check={checks.get(draft.key)}
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
	check,
	onChange,
}: {
	readonly draft: ResourceDraft
	readonly check: MountCheck | undefined
	readonly onChange: (draft: ResourceDraft) => void
}): React.JSX.Element {
	switch (draft.type) {
		case "github_repository": {
			const error = checkoutError(draft)
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
					<Field
						label="Token"
						description="Authenticates clone and fetch, and push on writable mounts. Never shown again."
					>
						<Input
							type="password"
							autoComplete="off"
							value={draft.token}
							onChange={(event) => onChange({ ...draft, token: event.target.value })}
						/>
					</Field>
					<Field
						label="Checkout"
						description="Use the default branch, a named branch, or a full commit ID. Tags are unsupported."
					>
						<Select
							value={draft.checkoutKind}
							onChange={(event) => {
								const kind = event.target.value
								if (kind === "default" || kind === "branch" || kind === "commit") {
									onChange({ ...draft, checkoutKind: kind, checkout: "" })
								}
							}}
						>
							<option value="default">Default branch</option>
							<option value="branch">Branch</option>
							<option value="commit">Commit</option>
						</Select>
					</Field>
					{draft.checkoutKind === "default" ? null : (
						<Field
							label={draft.checkoutKind === "branch" ? "Branch name" : "Commit ID"}
							error={error}
						>
							<Input
								required
								aria-invalid={error !== undefined}
								value={draft.checkout}
								onChange={(event) => onChange({ ...draft, checkout: event.target.value })}
							/>
						</Field>
					)}
					<label className="flex items-center gap-2 text-control">
						<input
							type="checkbox"
							checked={draft.access === "read_only"}
							onChange={(event) =>
								onChange({ ...draft, access: event.target.checked ? "read_only" : "read_write" })
							}
						/>
						Read-only
					</label>
					<Field label="Mount path" description="Defaults to /workspace/<repository>.">
						<Input
							className="font-mono"
							value={draft.mountPath}
							onChange={(event) => onChange({ ...draft, mountPath: event.target.value })}
						/>
					</Field>
				</>
			)
		}
		case "memory_store":
			return (
				<>
					<MemoryStorePicker
						chosen={draft.memoryStoreId}
						check={check}
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
						check={check}
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
	check,
	onChange,
	describe,
}: {
	readonly query: LazyChoices<T>
	readonly label: string
	readonly noun: string
	readonly placeholder: string
	readonly empty: React.ReactNode
	readonly chosen: string
	readonly check: MountCheck | undefined
	readonly onChange: (id: string) => void
	readonly describe: (option: T) => string
}): React.JSX.Element {
	const { data, error, isFetchingNextPage, hasNextPage, fetchNextPage } = query
	const options = choicesOf({
		data: data ?? { pages: [] },
		error,
		isFetchingNextPage,
		hasNextPage,
		fetchNextPage,
	})
	if (chosen === "" && options.items.length === 0 && options.more === null) {
		if (options.error !== undefined) {
			return <Callout tone="error">{options.error}</Callout>
		}
		return data === undefined ? (
			<p className="text-control text-muted-foreground">Loading {noun}…</p>
		) : (
			<Callout>{empty}</Callout>
		)
	}
	const items = options.items.map((item) => ({
		id: item.id,
		label: item.id === chosen && check?.state === "active" ? check.found : describe(item),
	}))
	if (chosen !== "" && !items.some((item) => item.id === chosen)) {
		items.unshift({ id: chosen, label: check?.state === "active" ? check.found : chosen })
	}
	return (
		<div className="space-y-2">
			<OptionPicker
				label={label}
				noun={noun}
				placeholder={placeholder}
				options={{ ...options, items }}
				value={{ id: chosen, gone: check?.state === "gone" }}
				onChange={onChange}
				describe={(item) => item.label}
			/>
			{check?.state === "pending" ? (
				<p className="text-control text-muted-foreground">
					Checking selected {label.toLowerCase()}…
				</p>
			) : null}
			{check?.state === "failed" ? (
				<Callout tone="error">
					Could not check the selected {label.toLowerCase()}.{" "}
					<Button variant="ghost" size="sm" onClick={check.retry}>
						Retry
					</Button>
				</Callout>
			) : null}
		</div>
	)
}

function MemoryStorePicker({
	chosen,
	check,
	onChange,
}: {
	readonly chosen: string
	readonly check: MountCheck | undefined
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
			check={check}
			onChange={onChange}
			describe={(memoryStore) => memoryStore.name}
		/>
	)
}

function ArtifactPicker({
	skill,
	chosen,
	check,
	onChange,
}: {
	readonly skill: boolean
	readonly chosen: string
	readonly check: MountCheck | undefined
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
			check={check}
			onChange={onChange}
			describe={(artifact) => `${artifact.name} (v${artifact.version})`}
		/>
	)
}
