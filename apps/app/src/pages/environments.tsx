import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Field } from "@checkfu/ui/field"
import { shortId, timeAgo } from "@checkfu/ui/format"
import { Input } from "@checkfu/ui/input"
import { Description, DescriptionList, PageHeader } from "@checkfu/ui/page-header"
import { DataTable } from "@checkfu/ui/table"
import { useSuspenseQuery } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { PlusIcon } from "lucide-react"
import { useState } from "react"
import type * as React from "react"
import { Pager } from "../pager.tsx"
import { checkfu } from "../api.ts"
import { environmentQuery, environmentsPage } from "../queries.ts"
import { LifecycleStatus } from "../status.tsx"
import { useAction, useSubmissionKey } from "../use-action.ts"

const list = getRouteApi("/_app/environments/")
const detail = getRouteApi("/_app/environments/$environmentId")

export function EnvironmentsPage(): React.JSX.Element {
	const search = list.useSearch()
	const page = useSuspenseQuery(environmentsPage(search.after)).data
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
			<Pager next={page.next_cursor} paged={search.after !== undefined} />
		</>
	)
}

export function NewEnvironmentPage(): React.JSX.Element {
	const navigate = useNavigate()
	const [name, setName] = useState("")
	const [description, setDescription] = useState("")
	const createKey = useSubmissionKey()
	const create = useAction(async () => {
		const body = { name: name.trim(), description: description === "" ? null : description }
		const environment = await checkfu.environments.create(body, createKey.keyFor(body))
		createKey.settle()
		await navigate({
			to: "/environments/$environmentId",
			params: { environmentId: environment.id },
		})
	}, ["environments"])
	return (
		<>
			<PageHeader
				title="New environment"
				breadcrumb={<Link to="/environments">Environments</Link>}
			/>
			<form
				className="max-w-2xl space-y-4"
				onSubmit={(event) => {
					event.preventDefault()
					create.run()
				}}
			>
				<Field label="Name">
					<Input required value={name} onChange={(event) => setName(event.target.value)} />
				</Field>
				<Field label="Description">
					<Input value={description} onChange={(event) => setDescription(event.target.value)} />
				</Field>
				{create.error === undefined ? null : <Callout tone="error">{create.error}</Callout>}
				<Button type="submit" disabled={create.pending}>
					Create environment
				</Button>
			</form>
		</>
	)
}

export function EnvironmentPage(): React.JSX.Element {
	const { environmentId } = detail.useParams()
	const environment = useSuspenseQuery(environmentQuery(environmentId)).data
	const archive = useAction(async () => {
		await checkfu.environments.archive(environment.id)
	}, ["environments"])
	const networking = environment.config.networking
	return (
		<>
			<PageHeader
				title={environment.name}
				id={environment.id}
				breadcrumb={<Link to="/environments">Environments</Link>}
				accessory={<LifecycleStatus resource={environment} />}
				description={environment.description ?? undefined}
				actions={
					environment.archived_at === null ? (
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
			{archive.error === undefined ? null : <Callout tone="error">{archive.error}</Callout>}
			<DescriptionList>
				<Description label="Network">{networking.type}</Description>
				{networking.type === "limited" ? (
					<>
						<Description label="Allowed hosts">
							{networking.allowed_hosts.join(", ") || "None"}
						</Description>
						<Description label="MCP servers">
							{networking.allow_mcp_servers ? "Allowed" : "Blocked"}
						</Description>
						<Description label="Package managers">
							{networking.allow_package_managers ? "Allowed" : "Blocked"}
						</Description>
					</>
				) : null}
				<Description label="Version">v{environment.version}</Description>
				<Description label="Created">{timeAgo(environment.created_at)}</Description>
			</DescriptionList>
		</>
	)
}
