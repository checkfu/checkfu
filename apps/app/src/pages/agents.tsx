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
import { agentQuery, agentsPage, present } from "../queries.ts"
import { LifecycleStatus } from "../status.tsx"
import { useAction, useSubmissionKey } from "../use-action.ts"
import { bodyOf, changesFrom, draftOf, emptyDraft, FIELD_LABELS, rebase } from "../agent-draft.ts"
import type { AgentDraft } from "../agent-draft.ts"

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

function AgentForm<Saved>({
	draft,
	onChange,
	submitLabel,
	notice,
	onSubmit,
	onSaved,
	onCancel,
}: {
	readonly draft: AgentDraft
	readonly onChange: (draft: AgentDraft) => void
	readonly submitLabel: string
	readonly notice?: React.ReactNode
	readonly onSubmit: (draft: AgentDraft) => Promise<Saved>
	readonly onSaved: (saved: Saved) => void
	readonly onCancel?: () => void
}): React.JSX.Element {
	const action = useAction(onSubmit, { invalidates: ["agents"], then: onSaved })
	const set =
		(field: keyof AgentDraft) =>
		(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
			onChange({ ...draft, [field]: event.target.value })
	return (
		<form
			className="max-w-2xl"
			onSubmit={(event) => {
				event.preventDefault()
				action.run(draft)
			}}
		>
			<fieldset disabled={action.pending} className="min-w-0 space-y-4">
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
				{notice}
				<div className="flex gap-2">
					<Button type="submit" disabled={action.pending || notice !== undefined}>
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
				submitLabel="Create agent"
				onSubmit={async (draft) => {
					const body = bodyOf(draft)
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

function AgentView({ agent }: { readonly agent: JsonAgent }): React.JSX.Element {
	const [edit, setEdit] = useState<{ readonly base: JsonAgent; readonly draft: AgentDraft } | null>(
		null,
	)
	const behind = edit !== null && agent.version > edit.base.version
	const update = edit === null ? null : rebase(edit.base, edit.draft, agent)
	const archive = useAction(
		async () => {
			await checkfu.agents.archive(agent.id)
		},
		{ invalidates: ["agents"] },
	)
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
			{edit === null ? (
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
					draft={edit.draft}
					onChange={(draft) => setEdit({ ...edit, draft })}
					submitLabel="Save new version"
					notice={
						behind && update !== null ? (
							<Callout>
								<p>
									This agent was saved as v{agent.version} while you were editing v
									{edit.base.version}. Your edits are kept.
									{update.overlapping.length === 0
										? " None of them touch the fields that changed."
										: ` Yours will replace the newer ${update.overlapping.map((field) => FIELD_LABELS[field]).join(", ")}.`}
								</p>
								<Button
									size="sm"
									variant="outline"
									className="mt-2"
									onClick={() => setEdit({ base: agent, draft: update.draft })}
								>
									Apply my edits to v{agent.version}
								</Button>
							</Callout>
						) : undefined
					}
					onCancel={() => setEdit(null)}
					onSubmit={async (draft) => {
						const changes = changesFrom(edit.base, draft)
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
