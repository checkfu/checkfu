import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Field } from "@checkfu/ui/field"
import { shortId, timeAgo } from "@checkfu/ui/format"
import { Input } from "@checkfu/ui/input"
import { Description, DescriptionList, PageHeader } from "@checkfu/ui/page-header"
import { DataTable } from "@checkfu/ui/table"
import { getRouteApi, Link, useNavigate, useRouter } from "@tanstack/react-router"
import { PlusIcon } from "lucide-react"
import * as React from "react"
import { checkfu } from "../api.ts"
import { lifecycle, Status } from "../status.tsx"
import { useAction } from "../use-action.ts"

const list = getRouteApi("/app/environments")
const detail = getRouteApi("/app/environments/$environmentId")

export function EnvironmentsPage(): React.JSX.Element {
	const page = list.useLoaderData()
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
						cell: (environment) => <Status status={lifecycle(environment)} />,
					},
					{
						key: "updated",
						header: "Updated",
						cell: (environment) => timeAgo(environment.updated_at),
						className: "text-muted-foreground",
					},
				]}
			/>
		</>
	)
}

export function NewEnvironmentPage(): React.JSX.Element {
	const navigate = useNavigate()
	const [name, setName] = React.useState("")
	const [description, setDescription] = React.useState("")
	const create = useAction(async () => {
		const environment = await checkfu.waitForPending(
			await checkfu.environments.create({
				name: name.trim(),
				description: description === "" ? null : description,
			}),
		)
		await navigate({
			to: "/environments/$environmentId",
			params: { environmentId: environment.id },
		})
	})
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
	const environment = detail.useLoaderData()
	const router = useRouter()
	const archive = useAction(async () => {
		await checkfu.environments.archive(environment.id)
		await router.invalidate()
	})
	const networking = environment.config.networking
	return (
		<>
			<PageHeader
				title={environment.name}
				id={environment.id}
				breadcrumb={<Link to="/environments">Environments</Link>}
				accessory={<Status status={lifecycle(environment)} />}
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
