import { normalizeAgentCreateBody } from "@checkfu/sdk/AgentInput"
import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Field } from "@checkfu/ui/field"
import { shortId, timeAgo } from "@checkfu/ui/format"
import { Input, Textarea } from "@checkfu/ui/input"
import { Description, DescriptionList, PageHeader } from "@checkfu/ui/page-header"
import { DataTable } from "@checkfu/ui/table"
import type { CreateAgentBody } from "@checkfu/sdk/Api"
import type { JsonAgent } from "@checkfu/sdk/client"
import { useSuspenseQuery } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { DownloadIcon, PlusIcon } from "lucide-react"
import { useState } from "react"
import type * as React from "react"
import { Pager } from "../pager.tsx"
import { checkfu, deploymentApiUrl } from "../api.ts"
import { agentQuery, agentsPage, present } from "../queries.ts"
import { LifecycleStatus } from "../status.tsx"
import { useAction, useSubmissionKey } from "../use-action.ts"
import {
	bodyOf,
	changesFrom,
	changesFromSource,
	draftOf,
	emptyDraft,
	FIELD_LABELS,
	rebase,
} from "../agent-draft.ts"
import type { AgentDraft } from "../agent-draft.ts"

import { readAgentSource } from "../agent-source.ts"
import type { AgentSourceCodec, AgentSourceReading } from "../agent-source.ts"
import {
	AgentConfigurationView,
	AgentModeControl,
	AgentSourceFields,
	loadAgentSource,
} from "../agent-yaml.tsx"

const list = getRouteApi("/_app/agents/")
const detail = getRouteApi("/_app/agents/$agentId")

export function AgentsPage(): React.JSX.Element {
	const search = list.useSearch()
	const page = useSuspenseQuery(agentsPage(search.after)).data
	return (
		<>
			<PageHeader
				title="Agents"
				description="A model and its instructions. Every update makes a new version."
				actions={
					<Button size="sm" asChild>
						<Link to="/agents/new">
							<PlusIcon /> New agent
						</Link>
					</Button>
				}
			/>
			<DataTable
				rows={page.data}
				rowKey={(agent) => agent.id}
				empty="No agents yet."
				columns={[
					{
						key: "name",
						header: "Name",
						cell: (agent) => (
							<Link
								to="/agents/$agentId"
								params={{ agentId: agent.id }}
								className="hover:underline"
							>
								{agent.name}
							</Link>
						),
					},
					{
						key: "id",
						header: "ID",
						cell: (agent) => shortId(agent.id),
						className: "font-mono text-xs text-muted-foreground",
					},
					{
						key: "model",
						header: "Model",
						cell: (agent) => agent.model.id,
						className: "font-mono text-xs",
					},
					{
						key: "version",
						header: "Version",
						cell: (agent) => `v${agent.version}`,
						className: "text-muted-foreground",
					},
					{
						key: "status",
						header: "Status",
						cell: (agent) => <LifecycleStatus resource={agent} />,
					},
					{
						key: "updated",
						header: "Updated",
						cell: (agent) => timeAgo(agent.updated_at),
						className: "text-muted-foreground",
					},
				]}
			/>
			<Pager next={page.next_cursor} paged={search.after !== undefined} />
		</>
	)
}

type AgentSubmission =
	| { readonly kind: "form"; readonly draft: AgentDraft }
	| { readonly kind: "yaml"; readonly body: CreateAgentBody }

interface SourceEdit {
	readonly codec: AgentSourceCodec
	readonly text: string
	readonly reading: AgentSourceReading
	readonly touched: boolean
}

function AgentForm<Saved>({
	draft,
	onChange,
	sourceBody,
	submitLabel,
	notice,
	onSubmit,
	onSaved,
	onCancel,
}: {
	readonly draft: AgentDraft
	readonly onChange: (draft: AgentDraft) => void
	readonly sourceBody?: (draft: AgentDraft) => AgentDraft
	readonly submitLabel: string
	readonly notice?: (canRebase: boolean) => React.ReactNode
	readonly onSubmit: (submission: AgentSubmission) => Promise<Saved>
	readonly onSaved: (saved: Saved) => void
	readonly onCancel?: () => void
}): React.JSX.Element {
	const action = useAction(onSubmit, { invalidates: [["agents"]], then: onSaved })
	const [showYaml, setShowYaml] = useState(false)
	const [source, setSource] = useState<SourceEdit>()
	const load = useAction(loadAgentSource, {
		then: (codec) => {
			const text = codec.agentDefinitionYaml(sourceBody?.(draft) ?? draft)
			setSource({ codec, text, reading: readAgentSource(codec, text), touched: false })
		},
	})
	const set =
		(field: "name" | "model" | "system" | "description") =>
		(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
			setSource(undefined)
			const text = event.target.value
			const value = text === "" && (field === "system" || field === "description") ? null : text
			onChange({ ...draft, [field]: value })
		}
	const invalidSource = source?.touched === true && source.reading.body === undefined
	const editNotice = notice?.(!invalidSource)
	const changeSource = (text: string) => {
		if (source === undefined) {
			return
		}
		const reading = readAgentSource(source.codec, text)
		setSource({ ...source, text, reading, touched: true })
		if (reading.body !== undefined) {
			onChange(draftOf(reading.body))
		}
	}
	return (
		<form
			className="max-w-2xl"
			onSubmit={(event) => {
				event.preventDefault()
				if (editNotice !== undefined || invalidSource) {
					return
				}
				if (!showYaml && source?.touched !== true) {
					action.run({ kind: "form", draft })
				} else if (source?.reading.body !== undefined) {
					action.run({ kind: "yaml", body: source.reading.body })
				}
			}}
		>
			<fieldset disabled={action.pending} className="min-w-0 space-y-4">
				<AgentModeControl
					formLabel="Form"
					disabled={load.pending}
					disableForm={invalidSource}
					showYaml={showYaml}
					setShowYaml={(show) => {
						setShowYaml(show)
						if (show && source === undefined && !load.pending) {
							load.run()
						}
					}}
				/>
				{showYaml ? (
					source === undefined ? (
						load.error === undefined ? (
							<p role="status" className="text-sm text-muted-foreground">
								Loading YAML…
							</p>
						) : (
							<Callout tone="error">{load.error}</Callout>
						)
					) : (
						<AgentSourceFields
							text={source.text}
							reading={source.reading}
							touched={source.touched}
							onChange={changeSource}
						/>
					)
				) : (
					<div className="min-w-0 space-y-4">
						<Field label="Name">
							<Input required value={draft.name} onChange={set("name")} />
						</Field>
						<Field label="Model" description="Enter a model ID configured for this deployment.">
							<Input required value={draft.model} onChange={set("model")} className="font-mono" />
						</Field>
						<Field label="System prompt">
							<Textarea rows={8} value={draft.system ?? ""} onChange={set("system")} />
						</Field>
						<Field label="Description">
							<Input value={draft.description ?? ""} onChange={set("description")} />
						</Field>
					</div>
				)}
				{action.error === undefined ? null : <Callout tone="error">{action.error}</Callout>}
				{editNotice}
				<div className="flex gap-2">
					<Button
						type="submit"
						disabled={
							action.pending ||
							editNotice !== undefined ||
							invalidSource ||
							(showYaml && source?.reading.body === undefined)
						}
					>
						{submitLabel}
					</Button>
					{onCancel === undefined ? null : (
						<Button variant="ghost" onClick={onCancel}>
							Cancel
						</Button>
					)}
				</div>
			</fieldset>
		</form>
	)
}

export function NewAgentPage(): React.JSX.Element {
	const navigate = useNavigate()
	const createKey = useSubmissionKey()
	const [draft, setDraft] = useState(emptyDraft)
	return (
		<>
			<PageHeader title="New agent" breadcrumb={<Link to="/agents">Agents</Link>} />
			<AgentForm
				draft={draft}
				onChange={setDraft}
				sourceBody={bodyOf}
				submitLabel="Create agent"
				onSubmit={async (submission) => {
					const body = normalizeAgentCreateBody(
						submission.kind === "form" ? bodyOf(submission.draft) : submission.body,
					)
					const agent = await checkfu.agents.create(body, createKey.keyFor(body))
					createKey.settle()
					return agent
				}}
				onSaved={(agent) =>
					void navigate({ to: "/agents/$agentId", params: { agentId: agent.id } })
				}
			/>
		</>
	)
}

export function AgentPage(): React.JSX.Element {
	const { agentId } = detail.useParams()
	const agent = present(useSuspenseQuery(agentQuery(agentId)))
	return <AgentView key={agent.id} agent={agent} />
}

interface Edit {
	readonly base: JsonAgent
	readonly draft: AgentDraft
}

const editNotice = (
	agent: JsonAgent,
	edit: Edit,
	apply: (draft: AgentDraft) => void,
	canRebase: boolean,
): React.ReactNode => {
	if (agent.archived_at !== null) {
		return (
			<Callout>
				This agent was archived while you were editing, so it can no longer be updated. Your draft
				is still here to copy.
			</Callout>
		)
	}
	if (agent.version <= edit.base.version) {
		return undefined
	}
	const { draft, overlapping } = rebase(edit.base, edit.draft, agent)
	return (
		<Callout>
			<p>
				This agent was saved as v{agent.version} while you were editing v{edit.base.version}.
				{canRebase
					? overlapping.length === 0
						? " Your changes can be applied to the newer version."
						: ` Applying your edits will replace the newer ${overlapping.map((field) => FIELD_LABELS[field]).join(", ")}.`
					: " Fix the YAML errors before applying your edits to the newer version."}
			</p>
			<Button
				size="sm"
				variant="outline"
				className="mt-2"
				disabled={!canRebase}
				onClick={() => apply(draft)}
			>
				Apply my edits to v{agent.version}
			</Button>
		</Callout>
	)
}

const exportSavedAgent = async (agent: JsonAgent): Promise<void> => {
	const [{ downloadAgentProject }, baseUrl] = await Promise.all([
		import("../agent-export.ts"),
		deploymentApiUrl(),
	])
	await downloadAgentProject(agent, baseUrl)
}

function AgentView({ agent }: { readonly agent: JsonAgent }): React.JSX.Element {
	const [edit, setEdit] = useState<Edit | null>(null)
	const archive = useAction(
		async () => {
			await checkfu.agents.archive(agent.id)
		},
		{ invalidates: [["agents"]] },
	)
	const exportProject = useAction(exportSavedAgent)
	const archived = agent.archived_at !== null
	return (
		<>
			<PageHeader
				title={agent.name}
				id={agent.id}
				breadcrumb={<Link to="/agents">Agents</Link>}
				accessory={<LifecycleStatus resource={agent} />}
				description={agent.description ?? undefined}
				actions={
					archived || edit !== null ? undefined : (
						<>
							<Button
								variant="outline"
								size="sm"
								disabled={exportProject.pending}
								onClick={() => exportProject.run(agent)}
							>
								<DownloadIcon /> Export as code
							</Button>
							<Button
								variant="outline"
								size="sm"
								onClick={() => setEdit({ base: agent, draft: draftOf(agent) })}
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
					)
				}
			/>
			{archive.error === undefined ? null : <Callout tone="error">{archive.error}</Callout>}
			{exportProject.error === undefined ? null : (
				<Callout tone="error">{exportProject.error}</Callout>
			)}
			{edit === null ? (
				<AgentConfigurationView agent={agent}>
					<DescriptionList>
						<Description label="Model">
							<span className="font-mono">{agent.model.id}</span>
						</Description>
						<Description label="Version">v{agent.version}</Description>
						<Description label="Created">{timeAgo(agent.created_at)}</Description>
						<Description label="Updated">{timeAgo(agent.updated_at)}</Description>
					</DescriptionList>
					<section className="space-y-2">
						<h2 className="text-sm font-medium">System prompt</h2>
						<pre className="rounded-lg border bg-muted/40 p-4 text-control whitespace-pre-wrap">
							{agent.system ?? "None"}
						</pre>
					</section>
				</AgentConfigurationView>
			) : (
				<AgentForm
					key={edit.base.version}
					draft={edit.draft}
					onChange={(draft) => setEdit({ ...edit, draft })}
					submitLabel="Save new version"
					notice={(canRebase) =>
						editNotice(agent, edit, (draft) => setEdit({ base: agent, draft }), canRebase)
					}
					onCancel={() => setEdit(null)}
					onSubmit={async (submission) => {
						const changes =
							submission.kind === "form"
								? changesFrom(edit.base, submission.draft)
								: changesFromSource(edit.base, submission.body)
						if (Object.keys(changes).length > 0) {
							await checkfu.agents.update(edit.base.id, {
								version: edit.base.version,
								...changes,
							})
						}
					}}
					onSaved={() => setEdit(null)}
				/>
			)}
		</>
	)
}
