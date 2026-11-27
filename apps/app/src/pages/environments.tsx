import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Field } from "@checkfu/ui/field"
import { shortId, timeAgo } from "@checkfu/ui/format"
import { Input, Select, Textarea } from "@checkfu/ui/input"
import { DEFAULT_ENVIRONMENT_CONFIG } from "@checkfu/sdk/EnvironmentDefaults"
import type { EnvironmentNetworking } from "@checkfu/sdk/Schemas"
import type { JsonEnvironment } from "@checkfu/sdk/client"
import type { UpdateEnvironmentBody } from "@checkfu/sdk/Api"
import { Description, DescriptionList, PageHeader } from "@checkfu/ui/page-header"
import { DataTable } from "@checkfu/ui/table"
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { PlusIcon } from "lucide-react"
import { useState } from "react"
import type * as React from "react"
import { Pager } from "../pager.tsx"
import { ApiError, checkfu } from "../api.ts"
import { environmentQuery, environmentsPage, present } from "../queries.ts"
import { LifecycleStatus } from "../status.tsx"
import { useAction, useSubmissionKey } from "../use-action.ts"

const list = getRouteApi("/_app/environments/")
const detail = getRouteApi("/_app/environments/$environmentId")
const invalidates = [["environments"]] as const

interface NetworkingDraft {
	readonly type: EnvironmentNetworking["type"]
	readonly hosts: ReadonlyArray<{ readonly key: number; readonly value: string }>
	readonly mcp: boolean
	readonly packageManagers: boolean
}

interface EnvironmentDraft {
	readonly name: string
	readonly description: string
	readonly network: NetworkingDraft
}

const networkDraft = (network: EnvironmentNetworking): NetworkingDraft => ({
	type: network.type,
	hosts:
		network.type === "limited" ? network.allowed_hosts.map((value, key) => ({ key, value })) : [],
	mcp: network.type === "limited" && network.allow_mcp_servers,
	packageManagers: network.type === "limited" && network.allow_package_managers,
})

const hostValues = (hosts: NetworkingDraft["hosts"]): ReadonlyArray<string> =>
	hosts.map(({ value }) => value).filter((value) => value !== "")

const sameHosts = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
	left.length === right.length && left.every((host, index) => host === right[index])

const networkInput = (draft: NetworkingDraft): EnvironmentNetworking =>
	draft.type === "unrestricted"
		? { type: "unrestricted" }
		: {
				type: "limited",
				allow_mcp_servers: draft.mcp,
				allow_package_managers: draft.packageManagers,
				allowed_hosts: hostValues(draft.hosts),
			}

const draftOf = (environment: JsonEnvironment): EnvironmentDraft => ({
	name: environment.name,
	description: environment.description ?? "",
	network: networkDraft(environment.config.networking),
})

const reviewedField = <A,>(draft: A, base: A, current: A): A => (draft === base ? current : draft)

const rebaseNetwork = (
	draft: NetworkingDraft,
	base: NetworkingDraft,
	current: NetworkingDraft,
): NetworkingDraft => {
	const hostsChanged = !sameHosts(hostValues(draft.hosts), hostValues(base.hosts))
	if (draft.type !== current.type) {
		const changed =
			draft.type !== base.type ||
			(draft.type === "limited" &&
				(hostsChanged || draft.mcp !== base.mcp || draft.packageManagers !== base.packageManagers))
		return changed ? draft : current
	}
	if (draft.type === "unrestricted") {
		return current
	}
	return {
		type: current.type,
		hosts: hostsChanged ? draft.hosts : current.hosts,
		mcp: reviewedField(draft.mcp, base.mcp, current.mcp),
		packageManagers: reviewedField(
			draft.packageManagers,
			base.packageManagers,
			current.packageManagers,
		),
	}
}

const rebaseDraft = (
	draft: EnvironmentDraft,
	base: EnvironmentDraft,
	current: EnvironmentDraft,
): EnvironmentDraft => ({
	name: reviewedField(draft.name, base.name, current.name),
	description: reviewedField(draft.description, base.description, current.description),
	network: rebaseNetwork(draft.network, base.network, current.network),
})

function EnvironmentFields({
	draft,
	onChange,
}: {
	readonly draft: EnvironmentDraft
	readonly onChange: (draft: EnvironmentDraft) => void
}): React.JSX.Element {
	const network = draft.network
	return (
		<>
			<Field label="Name">
				<Input
					required
					value={draft.name}
					onChange={(event) => onChange({ ...draft, name: event.target.value })}
				/>
			</Field>
			<Field label="Description">
				<Input
					value={draft.description}
					onChange={(event) => onChange({ ...draft, description: event.target.value })}
				/>
			</Field>
			<div className="space-y-4 border-t pt-4">
				<Field label="Network access">
					<Select
						value={network.type}
						onChange={(event) =>
							onChange({
								...draft,
								network: {
									...network,
									type: event.target.value === "limited" ? "limited" : "unrestricted",
								},
							})
						}
					>
						<option value="unrestricted">Unrestricted (default)</option>
						<option value="limited">Limited</option>
					</Select>
				</Field>
				{network.type === "limited" ? (
					<>
						<fieldset className="min-w-0 space-y-2">
							<legend className="text-sm font-medium">Allowed hosts</legend>
							{network.hosts.map((host, index) => (
								<div key={host.key} className="flex items-start gap-2">
									<Textarea
										aria-label={`Allowed host ${index + 1}`}
										className="font-mono"
										rows={1}
										value={host.value}
										onChange={(event) => {
											const value = event.target.value
											onChange({
												...draft,
												network: {
													...network,
													hosts: network.hosts.map((entry) =>
														entry.key === host.key ? { ...entry, value } : entry,
													),
												},
											})
										}}
									/>
									<Button
										type="button"
										size="sm"
										variant="outline"
										aria-label={`Remove allowed host ${index + 1}`}
										onClick={() =>
											onChange({
												...draft,
												network: {
													...network,
													hosts: network.hosts.filter((entry) => entry.key !== host.key),
												},
											})
										}
									>
										Remove
									</Button>
								</div>
							))}
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() =>
									onChange({
										...draft,
										network: {
											...network,
											hosts: [
												...network.hosts,
												{ key: (network.hosts.at(-1)?.key ?? -1) + 1, value: "" },
											],
										},
									})
								}
							>
								Add host
							</Button>
						</fieldset>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={network.mcp}
								onChange={(event) =>
									onChange({ ...draft, network: { ...network, mcp: event.target.checked } })
								}
							/>
							Allow MCP servers
						</label>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={network.packageManagers}
								onChange={(event) =>
									onChange({
										...draft,
										network: { ...network, packageManagers: event.target.checked },
									})
								}
							/>
							Allow package managers
						</label>
					</>
				) : null}
			</div>
		</>
	)
}

export function EnvironmentsPage(): React.JSX.Element {
	const search = list.useSearch()
	const page = useSuspenseQuery(environmentsPage(search.page)).data
	return (
		<>
			<PageHeader
				title="Environments"
				description="Where a session runs, and what its network may reach."
				actions={
					<Button size="sm" asChild>
						<Link to="/environments/new">
							<PlusIcon /> New environment
						</Link>
					</Button>
				}
			/>
			<DataTable
				rows={page.data}
				rowKey={(environment) => environment.id}
				empty="No environments yet."
				columns={[
					{
						key: "name",
						header: "Name",
						cell: (environment) => (
							<Link
								to="/environments/$environmentId"
								params={{ environmentId: environment.id }}
								className="hover:underline"
							>
								{environment.name}
							</Link>
						),
					},
					{
						key: "id",
						header: "ID",
						cell: (environment) => shortId(environment.id),
						className: "font-mono text-xs text-muted-foreground",
					},
					{
						key: "network",
						header: "Network",
						cell: (environment) => environment.config.networking.type,
					},
					{
						key: "status",
						header: "Status",
						cell: (environment) => <LifecycleStatus resource={environment} />,
					},
					{
						key: "updated",
						header: "Updated",
						cell: (environment) => timeAgo(environment.updated_at),
						className: "text-muted-foreground",
					},
				]}
			/>
			<Pager next={page.next_page} paged={search.page !== undefined} />
		</>
	)
}

export function NewEnvironmentPage(): React.JSX.Element {
	const navigate = useNavigate()
	const [draft, setDraft] = useState<EnvironmentDraft>(() => ({
		name: "",
		description: "",
		network: networkDraft(DEFAULT_ENVIRONMENT_CONFIG.networking),
	}))
	const createKey = useSubmissionKey()
	const create = useAction(
		async () => {
			const body = {
				name: draft.name.trim(),
				description: draft.description === "" ? null : draft.description,
				config: { type: "cloud" as const, networking: networkInput(draft.network) },
			}
			const environment = await checkfu.environments.create(body, createKey.keyFor(body))
			createKey.settle()
			return environment
		},
		{
			invalidates,
			then: (environment) =>
				void navigate({
					to: "/environments/$environmentId",
					params: { environmentId: environment.id },
				}),
		},
	)
	return (
		<>
			<PageHeader
				title="New environment"
				breadcrumb={<Link to="/environments">Environments</Link>}
			/>
			<form
				className="max-w-2xl"
				onSubmit={(event) => {
					event.preventDefault()
					create.run()
				}}
			>
				<fieldset disabled={create.pending} className="min-w-0 space-y-4">
					<EnvironmentFields draft={draft} onChange={setDraft} />
					{create.error === undefined ? null : <Callout tone="error">{create.error}</Callout>}
					<Button type="submit" disabled={create.pending}>
						Create environment
					</Button>
				</fieldset>
			</form>
		</>
	)
}

export function EnvironmentPage(): React.JSX.Element {
	const { environmentId } = detail.useParams()
	const environment = present(useSuspenseQuery(environmentQuery(environmentId)))
	return <EnvironmentView key={environment.id} environment={environment} />
}

export function EnvironmentView({
	environment,
}: {
	readonly environment: JsonEnvironment
}): React.JSX.Element {
	const [editing, setEditing] = useState(false)
	const archive = useAction(
		async () => {
			await checkfu.environments.archive(environment.id)
		},
		{ invalidates },
	)
	return (
		<>
			<PageHeader
				title={environment.name}
				id={environment.id}
				breadcrumb={<Link to="/environments">Environments</Link>}
				accessory={<LifecycleStatus resource={environment} />}
				description={environment.description ?? undefined}
				actions={
					environment.archived_at === null && !editing ? (
						<>
							<Button
								variant="outline"
								size="sm"
								disabled={archive.pending}
								onClick={() => setEditing(true)}
							>
								Edit
							</Button>
							<Button
								variant="destructive"
								size="sm"
								disabled={archive.pending}
								onClick={() => archive.run()}
							>
								Archive
							</Button>
						</>
					) : undefined
				}
			/>
			{archive.error === undefined ? null : <Callout tone="error">{archive.error}</Callout>}
			{editing ? (
				<EnvironmentEditor current={environment} onClose={() => setEditing(false)} />
			) : (
				<DescriptionList>
					<NetworkDetails network={environment.config.networking} />
					<Description label="Version">v{environment.version}</Description>
					<Description label="Created">{timeAgo(environment.created_at)}</Description>
				</DescriptionList>
			)}
		</>
	)
}

function NetworkDetails({
	network,
}: {
	readonly network: EnvironmentNetworking
}): React.JSX.Element {
	return (
		<>
			<Description label="Network">{network.type}</Description>
			{network.type === "limited" ? (
				<>
					<Description label="Allowed hosts">
						{network.allowed_hosts.join(", ") || "None"}
					</Description>
					<Description label="MCP servers">
						{network.allow_mcp_servers ? "Allowed" : "Blocked"}
					</Description>
					<Description label="Package managers">
						{network.allow_package_managers ? "Allowed" : "Blocked"}
					</Description>
				</>
			) : null}
		</>
	)
}

function EnvironmentReview({
	current,
	hasNewVersion,
	conflictingHosts,
	saving,
	onReview,
}: {
	readonly current: JsonEnvironment
	readonly hasNewVersion: boolean
	readonly conflictingHosts: boolean
	readonly saving: boolean
	readonly onReview: (keepDraftHosts: boolean) => void
}): React.JSX.Element {
	const client = useQueryClient()
	const refresh = useAction(() =>
		client.invalidateQueries({ queryKey: environmentQuery(current.id).queryKey }),
	)
	return (
		<Callout>
			<p>Your draft is still here. Review the current environment before saving.</p>
			{hasNewVersion ? (
				<div className="mt-3 space-y-3">
					<DescriptionList>
						<Description label="Name">{current.name}</Description>
						<Description label="Description">{current.description || "None"}</Description>
						<NetworkDetails network={current.config.networking} />
					</DescriptionList>
					{conflictingHosts ? (
						<>
							<p>The saved and draft allowlists both changed. Choose the list to keep.</p>
							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={saving}
									onClick={() => onReview(false)}
								>
									Keep saved allowlist
								</Button>
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={saving}
									onClick={() => onReview(true)}
								>
									Keep draft allowlist
								</Button>
							</div>
						</>
					) : (
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={saving}
							onClick={() => onReview(true)}
						>
							Use v{current.version} as the base
						</Button>
					)}
				</div>
			) : (
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="mt-3"
					disabled={refresh.pending || saving}
					onClick={() => refresh.run()}
				>
					Check latest version
				</Button>
			)}
		</Callout>
	)
}

const changesOf = (base: JsonEnvironment, draft: EnvironmentDraft): UpdateEnvironmentBody => {
	const name = draft.name === base.name ? base.name : draft.name.trim()
	const description =
		draft.description === (base.description ?? "")
			? base.description
			: draft.description === ""
				? null
				: draft.description
	const previous = base.config.networking
	const policy = networkInput(draft.network)
	const policyChanged =
		policy.type !== previous.type ||
		(policy.type === "limited" &&
			previous.type === "limited" &&
			(policy.allow_mcp_servers !== previous.allow_mcp_servers ||
				policy.allow_package_managers !== previous.allow_package_managers ||
				!sameHosts(policy.allowed_hosts, previous.allowed_hosts)))
	return {
		version: base.version,
		...(name === base.name ? {} : { name }),
		...(description === base.description ? {} : { description }),
		...(policyChanged ? { config: { ...base.config, networking: policy } } : {}),
	}
}

function EnvironmentEditor({
	current,
	onClose,
}: {
	readonly current: JsonEnvironment
	readonly onClose: () => void
}): React.JSX.Element {
	const [base, setBase] = useState(current)
	const [draft, setDraft] = useState(() => draftOf(current))
	const [conflictVersion, setConflictVersion] = useState<number>()
	const conflict = conflictVersion === base.version
	const updated = base.version !== current.version
	const archived = current.archived_at !== null
	const save = useAction(
		async (body: UpdateEnvironmentBody) => {
			try {
				return await checkfu.environments.update(base.id, body)
			} catch (error) {
				if (error instanceof ApiError && error.status === 409) {
					setConflictVersion(body.version)
				} else {
					setConflictVersion(undefined)
				}
				throw error
			}
		},
		{ invalidates, then: onClose },
	)
	const changes = changesOf(base, draft)
	const changed = Object.keys(changes).length > 1
	const review = !archived && (updated || conflict)
	const baseDraft = draftOf(base)
	const currentDraft = draftOf(current)
	const draftHosts = hostValues(draft.network.hosts)
	const baseHosts = hostValues(baseDraft.network.hosts)
	const savedHosts = hostValues(currentDraft.network.hosts)
	const conflictingHosts =
		updated &&
		draft.network.type === "limited" &&
		currentDraft.network.type === "limited" &&
		!sameHosts(draftHosts, baseHosts) &&
		!sameHosts(savedHosts, baseHosts) &&
		!sameHosts(draftHosts, savedHosts)
	const canSave = !archived && !review && changed && changes.name !== "" && !save.pending
	return (
		<form
			className="max-w-2xl space-y-4"
			onSubmit={(event) => {
				event.preventDefault()
				if (canSave) {
					save.run(changes)
				}
			}}
		>
			{archived ? <Callout>This environment was archived while you were editing.</Callout> : null}
			{review ? (
				<EnvironmentReview
					current={current}
					hasNewVersion={updated}
					conflictingHosts={conflictingHosts}
					saving={save.pending}
					onReview={(keepDraftHosts) => {
						const rebased = rebaseDraft(draft, baseDraft, currentDraft)
						setDraft(
							keepDraftHosts
								? rebased
								: {
										...rebased,
										network: { ...rebased.network, hosts: currentDraft.network.hosts },
									},
						)
						setBase(current)
					}}
				/>
			) : null}
			<fieldset disabled={archived || save.pending} className="min-w-0 space-y-4">
				<EnvironmentFields draft={draft} onChange={setDraft} />
			</fieldset>
			<p className="text-control text-muted-foreground">
				Sessions pick up network changes when their next turn starts.
			</p>
			{save.error === undefined || conflictVersion !== undefined || updated ? null : (
				<Callout tone="error">{save.error}</Callout>
			)}
			<div className="flex flex-wrap gap-2">
				<Button type="submit" disabled={!canSave}>
					Save changes
				</Button>
				<Button type="button" variant="outline" disabled={save.pending} onClick={onClose}>
					Cancel
				</Button>
			</div>
		</form>
	)
}
