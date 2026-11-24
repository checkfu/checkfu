import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Field } from "@checkfu/ui/field"
import { shortId, timeAgo } from "@checkfu/ui/format"
import { Input, Textarea } from "@checkfu/ui/input"
import { Description, DescriptionList, PageHeader } from "@checkfu/ui/page-header"
import { DataTable } from "@checkfu/ui/table"
import type { JsonAgent } from "@checkfu/sdk/client"
import { getRouteApi, Link, useNavigate, useRouter } from "@tanstack/react-router"
import { PlusIcon } from "lucide-react"
import * as React from "react"
import { checkfu } from "../api.ts"
import { lifecycle, Status } from "../status.tsx"
import { useAction } from "../use-action.ts"

const list = getRouteApi("/app/agents")
const detail = getRouteApi("/app/agents/$agentId")

export function AgentsPage(): React.JSX.Element {
	const page = list.useLoaderData()
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
						cell: (agent) => <Status status={lifecycle(agent)} />,
					},
					{
						key: "updated",
						header: "Updated",
						cell: (agent) => timeAgo(agent.updated_at),
						className: "text-muted-foreground",
					},
				]}
			/>
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
	const [draft, setDraft] = React.useState(initial)
	const action = useAction(onSubmit)
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
	return (
		<>
			<PageHeader title="New agent" breadcrumb={<Link to="/agents">Agents</Link>} />
			<AgentForm
				initial={{ name: "", model: "", system: "", description: "" }}
				submitLabel="Create agent"
				onSubmit={async (draft) => {
					const agent = await checkfu.waitForPending(await checkfu.agents.create(bodyOf(draft)))
					await navigate({ to: "/agents/$agentId", params: { agentId: agent.id } })
				}}
			/>
		</>
	)
}

export function AgentPage(): React.JSX.Element {
	const agent = detail.useLoaderData()
	const router = useRouter()
	const [editing, setEditing] = React.useState(false)
	const archive = useAction(async () => {
		await checkfu.agents.archive(agent.id)
		await router.invalidate()
	})
	const archived = agent.archived_at !== null
	return (
		<>
			<PageHeader
				title={agent.name}
				id={agent.id}
				breadcrumb={<Link to="/agents">Agents</Link>}
				accessory={<Status status={lifecycle(agent)} />}
				description={agent.description ?? undefined}
				actions={
					archived || editing ? undefined : (
						<>
							<Button variant="outline" size="sm" onClick={() => setEditing(true)}>
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
			{editing ? (
				<AgentForm
					initial={draftOf(agent)}
					submitLabel="Save new version"
					onCancel={() => setEditing(false)}
					onSubmit={async (draft) => {
						await checkfu.waitForPending(
							await checkfu.agents.update(agent.id, { version: agent.version, ...bodyOf(draft) }),
						)
						setEditing(false)
						await router.invalidate()
					}}
				/>
			) : (
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
			)}
		</>
	)
}
