import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Chip } from "@checkfu/ui/chip"
import { CopyButton } from "@checkfu/ui/copy-button"
import { Field } from "@checkfu/ui/field"
import { shortId, timeAgo } from "@checkfu/ui/format"
import { Select } from "@checkfu/ui/input"
import { Description, DescriptionList, PageHeader } from "@checkfu/ui/page-header"
import { DataTable } from "@checkfu/ui/table"
import type { ArtifactFileContent } from "@checkfu/sdk/Api"
import type { JsonArtifact } from "@checkfu/sdk/client"
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { ExternalLinkIcon } from "lucide-react"
import { useState } from "react"
import type * as React from "react"
import { byteSize, expiry, fileView, publicationLabel, webUrl } from "../artifact-view.ts"
import { checkfu, errorMessage, isSignedOut } from "../api.ts"
import type { JsonArtifactLink } from "../api.ts"
import { Pager } from "../pager.tsx"
import {
	artifactFileQuery,
	artifactQuery,
	artifactsPage,
	artifactVersionQuery,
	present,
} from "../queries.ts"
import { useAction, useSubmissionKey } from "../use-action.ts"

const list = getRouteApi("/_app/artifacts/")
const detail = getRouteApi("/_app/artifacts/$artifactId")

type ArtifactFile = JsonArtifact["files"][number]

const LINK_LIFETIMES = [
	{ seconds: 600, label: "10 minutes" },
	{ seconds: 3600, label: "1 hour" },
	{ seconds: 86_400, label: "1 day" },
	{ seconds: 604_800, label: "7 days" },
]
const DEFAULT_LINK_SECONDS = 3600

function PublicationStatus({
	publication,
}: {
	readonly publication: JsonArtifact["publication"]
}): React.JSX.Element | null {
	const label = publicationLabel(publication)
	return label === undefined ? null : <Chip tone="green">{label}</Chip>
}

export function ArtifactsPage(): React.JSX.Element {
	const search = list.useSearch()
	const page = useSuspenseQuery(artifactsPage(search.after)).data
	return (
		<>
			<PageHeader
				title="Artifacts"
				description="Versioned sets of files that agents make. Open one with a viewing link or publish it."
			/>
			<DataTable
				rows={page.data}
				rowKey={(artifact) => artifact.id}
				empty="No artifacts yet. Agents create them as they work, and so can the API and CLI."
				columns={[
					{
						key: "name",
						header: "Name",
						cell: (artifact) => (
							<Link
								to="/artifacts/$artifactId"
								params={{ artifactId: artifact.id }}
								className="hover:underline"
							>
								{artifact.name}
							</Link>
						),
					},
					{
						key: "id",
						header: "ID",
						cell: (artifact) => shortId(artifact.id),
						className: "font-mono text-xs text-muted-foreground",
					},
					{
						key: "version",
						header: "Version",
						cell: (artifact) => `v${artifact.version}`,
						className: "text-muted-foreground",
					},
					{
						key: "files",
						header: "Files",
						cell: (artifact) => artifact.file_count,
						className: "text-muted-foreground",
					},
					{
						key: "size",
						header: "Size",
						cell: (artifact) => byteSize(artifact.total_bytes),
						className: "text-muted-foreground",
					},
					{
						key: "published",
						header: "Published",
						cell: (artifact) => <PublicationStatus publication={artifact.publication} />,
					},
					{
						key: "updated",
						header: "Updated",
						cell: (artifact) => timeAgo(artifact.updated_at),
						className: "text-muted-foreground",
					},
				]}
			/>
			<Pager next={page.next_cursor} paged={search.after !== undefined} />
		</>
	)
}

export function ArtifactPage(): React.JSX.Element {
	const { artifactId } = detail.useParams()
	const search = detail.useSearch()
	const artifact = present(useSuspenseQuery(artifactQuery(artifactId)))
	return (
		<ArtifactView
			key={artifact.id}
			artifact={artifact}
			version={search.version ?? artifact.version}
			path={search.path}
		/>
	)
}

function Confirm({
	label,
	pending,
	onConfirm,
	onCancel,
	children,
}: {
	readonly label: string
	readonly pending: boolean
	readonly onConfirm: () => void
	readonly onCancel: () => void
	readonly children: React.ReactNode
}): React.JSX.Element {
	return (
		<Callout className="max-w-2xl space-y-2">
			<p>{children}</p>
			<div className="flex gap-2">
				<Button variant="destructive" size="sm" disabled={pending} onClick={onConfirm}>
					{label}
				</Button>
				<Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</Callout>
	)
}

function Address({ url }: { readonly url: string }): React.JSX.Element {
	const href = webUrl(url)
	return (
		<div className="flex max-w-2xl items-center gap-2">
			<div className="flex h-8 min-w-0 flex-1 items-center gap-1 rounded-lg border bg-muted/40 pr-1 pl-2.5">
				<span className="min-w-0 flex-1 truncate font-mono text-xs" title={url}>
					{url}
				</span>
				<CopyButton value={url} label="Copy link" />
			</div>
			{href === undefined ? null : (
				<Button variant="outline" asChild>
					<a href={href} target="_blank" rel="noopener noreferrer">
						<ExternalLinkIcon /> Open
					</a>
				</Button>
			)}
		</div>
	)
}

function ArtifactView({
	artifact,
	version,
	path,
}: {
	readonly artifact: JsonArtifact
	readonly version: number
	readonly path: string | undefined
}): React.JSX.Element {
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const [deleting, setDeleting] = useState(false)
	const remove = useAction(
		async () => {
			await checkfu.artifacts.delete(artifact.id)
		},
		{
			then: () => {
				queryClient.removeQueries({ queryKey: ["artifacts", "page"] })
				void navigate({ to: "/artifacts" })
			},
		},
	)
	return (
		<>
			<PageHeader
				title={artifact.name}
				id={artifact.id}
				breadcrumb={<Link to="/artifacts">Artifacts</Link>}
				accessory={<PublicationStatus publication={artifact.publication} />}
				actions={
					deleting ? undefined : (
						<Button variant="destructive" size="sm" onClick={() => setDeleting(true)}>
							Delete
						</Button>
					)
				}
			/>
			{deleting ? (
				<Confirm
					label="Delete artifact"
					pending={remove.pending}
					onConfirm={() => remove.run()}
					onCancel={() => setDeleting(false)}
				>
					Delete {artifact.name} and every version of its files? Its public address and every
					viewing link stop working at once. This cannot be undone.
				</Confirm>
			) : null}
			{remove.error === undefined ? null : <Callout tone="error">{remove.error}</Callout>}
			<DescriptionList>
				<Description label="Version">v{artifact.version}</Description>
				<Description label="Files">{artifact.file_count}</Description>
				<Description label="Size">{byteSize(artifact.total_bytes)}</Description>
				<Description label="Created">{timeAgo(artifact.created_at)}</Description>
				<Description label="Updated">{timeAgo(artifact.updated_at)}</Description>
			</DescriptionList>
			<FilesSection artifact={artifact} version={version} path={path} />
			<LinkSection key={`${artifact.id}@${version}`} artifactId={artifact.id} version={version} />
			<PublicationSection
				key={artifact.publication?.address ?? "unpublished"}
				artifact={artifact}
				version={version}
			/>
		</>
	)
}

function FilesSection({
	artifact,
	version,
	path,
}: {
	readonly artifact: JsonArtifact
	readonly version: number
	readonly path: string | undefined
}): React.JSX.Element {
	const navigate = useNavigate()
	return (
		<section className="space-y-3">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<h2 className="text-sm font-medium">Files</h2>
				<Field label="Version" className="w-40">
					<Select
						value={version}
						onChange={(event) =>
							void navigate({
								to: "/artifacts/$artifactId",
								params: { artifactId: artifact.id },
								search: (previous) => ({ ...previous, version: Number(event.target.value) }),
								resetScroll: false,
							})
						}
					>
						{Array.from({ length: artifact.version }, (_, index) => artifact.version - index).map(
							(option) => (
								<option key={option} value={option}>
									v{option}
									{option === artifact.version ? " (latest)" : ""}
								</option>
							),
						)}
					</Select>
				</Field>
			</div>
			{version === artifact.version ? (
				<FileList artifact={artifact} version={version} files={artifact.files} path={path} />
			) : (
				<OlderVersion artifact={artifact} version={version} path={path} />
			)}
		</section>
	)
}

function OlderVersion({
	artifact,
	version,
	path,
}: {
	readonly artifact: JsonArtifact
	readonly version: number
	readonly path: string | undefined
}): React.JSX.Element {
	const found = useQuery(artifactVersionQuery(artifact.id, version))
	if (found.data !== undefined) {
		return <FileList artifact={artifact} version={version} files={found.data.files} path={path} />
	}
	return found.error === null || isSignedOut(found.error) ? (
		<p className="text-control text-muted-foreground">Loading…</p>
	) : (
		<Callout tone="error">{errorMessage(found.error)}</Callout>
	)
}

function FileList({
	artifact,
	version,
	files,
	path,
}: {
	readonly artifact: JsonArtifact
	readonly version: number
	readonly files: ReadonlyArray<ArtifactFile>
	readonly path: string | undefined
}): React.JSX.Element {
	const selected = files.find((file) => file.path === path)
	return (
		<>
			<DataTable
				rows={files}
				rowKey={(file) => file.path}
				empty="This version has no files."
				columns={[
					{
						key: "path",
						header: "Path",
						cell: (file) => (
							<Link
								to="/artifacts/$artifactId"
								params={{ artifactId: artifact.id }}
								search={(previous) => ({ ...previous, path: file.path })}
								resetScroll={false}
								aria-current={file.path === path ? "true" : undefined}
								className="font-mono text-xs hover:underline aria-[current=true]:font-semibold"
							>
								{file.path}
							</Link>
						),
					},
					{
						key: "type",
						header: "Type",
						cell: (file) => file.content_type,
						className: "font-mono text-xs text-muted-foreground",
					},
					{
						key: "size",
						header: "Size",
						cell: (file) => byteSize(file.size),
						className: "text-muted-foreground",
					},
				]}
			/>
			{path === undefined ? null : selected === undefined ? (
				<Callout>
					v{version} has no file at <span className="font-mono">{path}</span>.
				</Callout>
			) : (
				<FileContent artifactId={artifact.id} version={version} file={selected} />
			)}
		</>
	)
}

function FileContent({
	artifactId,
	version,
	file,
}: {
	readonly artifactId: string
	readonly version: number
	readonly file: ArtifactFile
}): React.JSX.Element {
	const content = useQuery(artifactFileQuery(artifactId, version, file.path))
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="min-w-0 truncate font-mono text-xs font-medium">{file.path}</h3>
				<span className="text-xs text-muted-foreground">
					{file.content_type} · {byteSize(file.size)}
				</span>
			</div>
			{content.data === undefined ? (
				content.error === null || isSignedOut(content.error) ? (
					<p className="text-control text-muted-foreground">Loading…</p>
				) : (
					<Callout tone="error">{errorMessage(content.error)}</Callout>
				)
			) : (
				<FileBody file={content.data} />
			)}
		</div>
	)
}

export function FileBody({ file }: { readonly file: ArtifactFileContent }): React.JSX.Element {
	const view = fileView(file)
	switch (view.kind) {
		case "text":
			return (
				<pre className="max-h-128 overflow-auto rounded-lg border bg-muted/40 p-4 font-mono text-control">
					{view.text}
				</pre>
			)
		case "image":
			return (
				<img
					src={view.src}
					alt={file.path}
					className="max-h-128 max-w-full rounded-lg border bg-muted/40 object-contain"
				/>
			)
		case "binary":
			return (
				<Callout>
					Binary file, {byteSize(file.size)}. Create a viewing link to open it in a browser.
				</Callout>
			)
	}
}

function LinkSection({
	artifactId,
	version,
}: {
	readonly artifactId: string
	readonly version: number
}): React.JSX.Element {
	const [seconds, setSeconds] = useState(DEFAULT_LINK_SECONDS)
	const [link, setLink] = useState<JsonArtifactLink | null>(null)
	const create = useAction(
		(target: number, expiresIn: number) =>
			checkfu.artifacts.link(artifactId, target, { expires_in: expiresIn }),
		{ then: setLink },
	)
	return (
		<section className="space-y-3">
			<div className="space-y-1">
				<h2 className="text-sm font-medium">Viewing link</h2>
				<p className="text-control text-muted-foreground">
					A link that opens v{version} in a browser until it expires. Anyone who has it can view it.
				</p>
			</div>
			<div className="flex flex-wrap items-end gap-2">
				<Field label="Expires after" className="w-40">
					<Select value={seconds} onChange={(event) => setSeconds(Number(event.target.value))}>
						{LINK_LIFETIMES.map((lifetime) => (
							<option key={lifetime.seconds} value={lifetime.seconds}>
								{lifetime.label}
							</option>
						))}
					</Select>
				</Field>
				<Button
					variant="outline"
					disabled={create.pending}
					onClick={() => create.run(version, seconds)}
				>
					Create link
				</Button>
			</div>
			{create.error === undefined ? null : <Callout tone="error">{create.error}</Callout>}
			{link === null ? null : (
				<div className="space-y-1">
					<Address url={link.url} />
					<p className="text-xs text-muted-foreground">
						v{link.version} · {expiry(link.expires_at)}
					</p>
				</div>
			)}
		</section>
	)
}

function PublicationSection({
	artifact,
	version,
}: {
	readonly artifact: JsonArtifact
	readonly version: number
}): React.JSX.Element {
	const { publication } = artifact
	const [serve, setServe] = useState<"latest" | "pinned">("latest")
	const [unpublishing, setUnpublishing] = useState(false)
	const publishKey = useSubmissionKey()
	const publish = useAction(
		async (target: number | "latest") => {
			const body = { version: target }
			await checkfu.artifacts.publish(artifact.id, body, publishKey.keyFor({ body, publication }))
			publishKey.settle()
		},
		{ invalidates: [["artifacts"]] },
	)
	const unpublishKey = useSubmissionKey()
	const unpublish = useAction(
		async () => {
			await checkfu.artifacts.unpublish(artifact.id, unpublishKey.keyFor({ publication }))
			unpublishKey.settle()
		},
		{ invalidates: [["artifacts"]], then: () => setUnpublishing(false) },
	)
	return (
		<section className="space-y-3">
			<div className="space-y-1">
				<h2 className="text-sm font-medium">Public address</h2>
				<p className="text-control text-muted-foreground">
					{publication === null
						? "Not published. Publishing serves the artifact at a lasting address that anyone who has it can view."
						: "Anyone who has this address can view the artifact."}
				</p>
			</div>
			{publication === null ? (
				<div className="flex flex-wrap items-end gap-2">
					<Field label="Serve" className="w-48">
						<Select
							value={serve}
							onChange={(event) => setServe(event.target.value === "pinned" ? "pinned" : "latest")}
						>
							<option value="latest">Follow latest</option>
							<option value="pinned">Pin v{version}</option>
						</Select>
					</Field>
					<Button
						disabled={publish.pending}
						onClick={() => publish.run(serve === "pinned" ? version : "latest")}
					>
						Publish
					</Button>
				</div>
			) : (
				<>
					<Address url={publication.url} />
					<DescriptionList>
						<Description label="Serves">
							{publication.version === null
								? `The latest version, now v${artifact.version}`
								: `v${publication.version}, pinned`}
						</Description>
						<Description label="Published">{timeAgo(publication.published_at)}</Description>
					</DescriptionList>
					{unpublishing ? (
						<Confirm
							label="Unpublish"
							pending={unpublish.pending}
							onConfirm={() => unpublish.run()}
							onCancel={() => setUnpublishing(false)}
						>
							Unpublish {artifact.name}? Its address stops working at once, and publishing again
							gives it a new one.
						</Confirm>
					) : (
						<div className="flex flex-wrap gap-2">
							{publication.version === version ? null : (
								<Button
									variant="outline"
									size="sm"
									disabled={publish.pending}
									onClick={() => publish.run(version)}
								>
									Pin to v{version}
								</Button>
							)}
							{publication.version === null ? null : (
								<Button
									variant="outline"
									size="sm"
									disabled={publish.pending}
									onClick={() => publish.run("latest")}
								>
									Follow latest
								</Button>
							)}
							<Button variant="destructive" size="sm" onClick={() => setUnpublishing(true)}>
								Unpublish
							</Button>
						</div>
					)}
				</>
			)}
			{[publish.error, unpublish.error].map((message) =>
				message === undefined ? null : (
					<Callout key={message} tone="error">
						{message}
					</Callout>
				),
			)}
		</section>
	)
}
