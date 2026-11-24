import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Field } from "@checkfu/ui/field"
import { shortId, timeAgo } from "@checkfu/ui/format"
import { Input, Textarea } from "@checkfu/ui/input"
import { Description, DescriptionList, PageHeader } from "@checkfu/ui/page-header"
import { DataTable } from "@checkfu/ui/table"
import type { JsonAgent } from "@checkfu/sdk/client"
import { useSuspenseQuery } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { PlusIcon } from "lucide-react"
import { useState } from "react"
import type * as React from "react"
import { Pager } from "../pager.tsx"
import { checkfu } from "../api.ts"
import { agentQuery, agentsPage } from "../queries.ts"
import { LifecycleStatus } from "../status.tsx"
import { useAction, useSubmissionKey } from "../use-action.ts"

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

interface AgentDraft {
	readonly name: string
	readonly model: string
	readonly system: string
	readonly description: string
}

const draftOf = (agent: JsonAgent): AgentDraft => ({
	name: agent.name,
	model: agent.model.id,
	system: agent.system ?? "",
	description: agent.description ?? "",
})

const bodyOf = (draft: AgentDraft) => ({
	name: draft.name.trim(),
	model: draft.model.trim(),
	system: draft.system === "" ? null : draft.system,
	description: draft.description === "" ? null : draft.description,
})

const changesFrom = (from: JsonAgent, draft: AgentDraft) => {
	const before = draftOf(from)
	const after = bodyOf(draft)
	return {
		...(after.name === before.name ? {} : { name: after.name }),
		...(after.model === before.model ? {} : { model: after.model }),
		...(draft.system === before.system ? {} : { system: after.system }),
		...(draft.description === before.description ? {} : { description: after.description }),
	}
}

function AgentForm({
	initial,
	submitLabel,
	onSubmit,
	onCancel,
}: {
	readonly initial: AgentDraft
	readonly submitLabel: string
	readonly onSubmit: (draft: AgentDraft) => Promise<void>
	readonly onCancel?: () => void
}): React.JSX.Element {
	const [draft, setDraft] = useState(initial)
	const action = useAction(onSubmit, ["agents"])
	const set =
		(field: keyof AgentDraft) =>
		(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
			setDraft({ ...draft, [field]: event.target.value })
	return (
		<form
			className="max-w-2xl space-y-4"
			onSubmit={(event) => {
				event.preventDefault()
				action.run(draft)
			}}
		>
			<Field label="Name">
				<Input required value={draft.name} onChange={set("name")} />
			</Field>
			<Field label="Model" description="For example claude-sonnet-5-5 or gpt-6.2-sol.">
				<Input required value={draft.model} onChange={set("model")} className="font-mono" />
			</Field>
			<Field label="System prompt">
				<Textarea rows={8} value={draft.system} onChange={set("system")} />
			</Field>
			<Field label="Description">
				<Input value={draft.description} onChange={set("description")} />
			</Field>
			{action.error === undefined ? null : <Callout tone="error">{action.error}</Callout>}
			<div className="flex gap-2">
				<Button type="submit" disabled={action.pending}>
					{submitLabel}
				</Button>
				{onCancel === undefined ? null : (
					<Button variant="ghost" onClick={onCancel}>
						Cancel
					</Button>
				)}
			</div>
		</form>
	)
}

export function NewAgentPage(): React.JSX.Element {
	const navigate = useNavigate()
	const createKey = useSubmissionKey()
	return (
		<>
			<PageHeader title="New agent" breadcrumb={<Link to="/agents">Agents</Link>} />
			<AgentForm
				initial={{ name: "", model: "", system: "", description: "" }}
				submitLabel="Create agent"
				onSubmit={async (draft) => {
					const body = bodyOf(draft)
					const agent = await checkfu.agents.create(body, createKey.keyFor(body))
					createKey.settle()
					await navigate({ to: "/agents/$agentId", params: { agentId: agent.id } })
				}}
			/>
		</>
	)
}

export function AgentPage(): React.JSX.Element {
	const { agentId } = detail.useParams()
	const agent = useSuspenseQuery(agentQuery(agentId)).data
	return <AgentView key={agent.id} agent={agent} />
}

function AgentView({ agent }: { readonly agent: JsonAgent }): React.JSX.Element {
	const [editingFrom, setEditingFrom] = useState<JsonAgent | null>(null)
	const archive = useAction(async () => {
		await checkfu.agents.archive(agent.id)
	}, ["agents"])
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
					archived || editingFrom !== null ? undefined : (
						<>
							<Button variant="outline" size="sm" onClick={() => setEditingFrom(agent)}>
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
			{editingFrom === null ? (
				<>
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
				</>
			) : (
				<AgentForm
					initial={draftOf(editingFrom)}
					submitLabel="Save new version"
					onCancel={() => setEditingFrom(null)}
					onSubmit={async (draft) => {
						const changes = changesFrom(editingFrom, draft)
						if (Object.keys(changes).length > 0) {
							await checkfu.agents.update(editingFrom.id, {
								version: editingFrom.version,
								...changes,
							})
						}
						setEditingFrom(null)
					}}
				/>
			)}
		</>
	)
}
