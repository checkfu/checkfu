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
import { grantAt } from "@checkfu/sdk/ArtifactAccess"

import type { ArtifactAccessLevel, ArtifactDataGrant } from "@checkfu/sdk/Schemas"
import type { JsonArtifact } from "@checkfu/sdk/client"
import { useIsMutating, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { ExternalLinkIcon } from "lucide-react"
import { useRef, useState } from "react"
import { Confirm } from "../confirm.tsx"
import type * as React from "react"
import {
	byteSize,
	downloadUrl,
	expiry,
	fileView,
	previewable,
	publicationLabel,
	webUrl,
} from "../artifact-view.ts"
import { ApiError, checkfu, errorMessage, isSignedOut } from "../api.ts"
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
	const page = useSuspenseQuery(artifactsPage(search.page)).data
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
			<Pager next={page.next_page} paged={search.page !== undefined} />
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
	const [deleting, setDeleting] = useState(false)
	const remove = useAction(
		async () => {
			await checkfu.artifacts.delete(artifact.id)
		},
		{ refreshes: [["artifacts", "page"]], then: () => void navigate({ to: "/artifacts" }) },
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
					Delete {artifact.name}, every version of its files, and all documents in its database? Its
					public address and every viewing link stop working at once. This cannot be undone.
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
			<PublicationSection artifact={artifact} version={version} />
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
	const preview = previewable(file)
	const content = useQuery({
		...artifactFileQuery(artifactId, version, file.path),
		enabled: preview,
	})
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="min-w-0 truncate font-mono text-xs font-medium">{file.path}</h3>
				<span className="flex items-baseline gap-3 text-xs text-muted-foreground">
					{file.content_type} · {byteSize(file.size)}
					<a
						href={downloadUrl(artifactId, version, file.path)}
						download={file.path.slice(file.path.lastIndexOf("/") + 1)}
						className="font-medium text-foreground hover:underline"
					>
						Download
					</a>
				</span>
			</div>
			{!preview ? (
				<Callout>Too large to preview here, {byteSize(file.size)}. Download it instead.</Callout>
			) : content.data === undefined ? (
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

const ACCESS_LEVELS = [
	{ value: "view", label: "Files only" },
	{ value: "read", label: "Allow data reads" },
	{ value: "write", label: "Allow data writes" },
] as const

const GRANT_LABELS = {
	read: "Read",
	add: "Add only",
	write: "Read and write",
} as const

function AccessSelect({
	label,
	value,
	set,
	disabled,
}: {
	readonly label: string
	readonly value: ArtifactAccessLevel
	readonly set: (access: ArtifactAccessLevel) => void
	readonly disabled: boolean
}): React.JSX.Element {
	return (
		<Field label={label} className="w-48">
			<Select
				value={value}
				disabled={disabled}
				onChange={(event) => {
					const selected = ACCESS_LEVELS.find((level) => level.value === event.currentTarget.value)
					if (selected !== undefined) {
						set(selected.value)
					}
				}}
			>
				{ACCESS_LEVELS.map((level) => (
					<option value={level.value} key={level.value}>
						{level.label}
					</option>
				))}
			</Select>
		</Field>
	)
}

function LinkSection({
	artifactId,
	version,
}: {
	readonly artifactId: string
	readonly version: number
}): React.JSX.Element {
	const [seconds, setSeconds] = useState(DEFAULT_LINK_SECONDS)
	const [access, setAccess] = useState<ArtifactAccessLevel>("view")
	const [link, setLink] = useState<JsonArtifactLink | null>(null)
	const create = useAction(
		(target: number, expiresIn: number, level: ArtifactAccessLevel) =>
			checkfu.artifacts.link(artifactId, target, { expires_in: expiresIn, access: level }),
		{ then: setLink },
	)
	return (
		<section className="space-y-3">
			<div className="space-y-1">
				<h2 className="text-sm font-medium">Viewing link</h2>
				<p className="text-control text-muted-foreground">
					Anyone with the link can open v{version} until it expires. Each collection applies its
					visitor permissions.
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
				<AccessSelect
					label="Link data access"
					value={access}
					set={setAccess}
					disabled={create.pending}
				/>
				<Button
					variant="outline"
					disabled={create.pending}
					onClick={() => create.run(version, seconds, access)}
				>
					Create link
				</Button>
			</div>
			{create.error === undefined ? null : <Callout tone="error">{create.error}</Callout>}
			{link === null ? null : <Address url={link.url} />}
			<p role="status" className="text-xs text-muted-foreground">
				{link === null ? null : (
					<>
						Link ready for v{link.version} · {expiry(link.expires_at)} ·{" "}
						{ACCESS_LEVELS.find((level) => level.value === link.access)?.label}
					</>
				)}
			</p>
		</section>
	)
}

function GrantedCollections({ grants }: { readonly grants: ArtifactDataGrant }): React.JSX.Element {
	const entries = Object.entries(grants)
	return entries.length === 0 ? (
		<>Files only</>
	) : (
		<>
			{entries.map(([collection, grant]) => (
				<span key={collection} className="mr-3 inline-block">
					{collection} · {GRANT_LABELS[grant]}
				</span>
			))}
		</>
	)
}

const publicationCondition = (artifact: JsonArtifact) => {
	const publication = artifact.publication
	return {
		version: artifact.version,
		publication:
			publication === null
				? null
				: {
						address: publication.address,
						version: publication.version,
						access: publication.access,
						grants: publication.grants,
					},
	}
}

const sameGrants = (previous: ArtifactDataGrant, proposed: ArtifactDataGrant): boolean => {
	const saved = Object.entries(previous)
	return (
		saved.length === Object.keys(proposed).length &&
		saved.every(([collection, grant]) => proposed[collection] === grant)
	)
}

function GrantPreview({
	version,
	grants,
	error,
}: {
	readonly version: number
	readonly grants: ArtifactDataGrant | undefined
	readonly error: Error | null
}): React.JSX.Element {
	const preview =
		grants !== undefined ? (
			<p className="text-control text-muted-foreground">
				Proposed grants for v{version}. <GrantedCollections grants={grants} />
			</p>
		) : error === null ? (
			<p className="text-control text-muted-foreground">Loading v{version} grants…</p>
		) : null
	return (
		<>
			<div role="status">{preview}</div>
			{grants === undefined && error !== null ? (
				<Callout tone="error">{errorMessage(error)}</Callout>
			) : null}
		</>
	)
}

const publicationGrantAction = (
	saved: JsonArtifact["publication"],
	access: ArtifactAccessLevel,
	proposal: ArtifactDataGrant | undefined,
) => {
	if (saved === null) {
		return { label: "Publish", enabled: proposal !== undefined, variant: "default" as const }
	}
	const changed =
		proposal !== undefined && (access !== saved.access || !sameGrants(saved.grants, proposal))
	return {
		label: changed && access === saved.access ? "Approve updated grants" : "Apply access",
		enabled: changed,
		variant: "outline" as const,
	}
}

function PublicationGrantEditor({
	artifact,
	target,
	pending,
	apply,
	children,
}: {
	readonly artifact: JsonArtifact
	readonly target: number | "latest"
	readonly pending: boolean
	readonly apply: (level: ArtifactAccessLevel) => void
	readonly children?: React.ReactNode
}): React.JSX.Element {
	const served = target === "latest" ? artifact.version : target
	const saved = artifact.publication
	const savedLevel = saved?.access ?? "view"
	const [access, setAccess] = useState<ArtifactAccessLevel>(savedLevel)
	const historical = useQuery({
		...artifactVersionQuery(artifact.id, served),
		enabled: served !== artifact.version && access !== "view",
	})
	const capabilities =
		served === artifact.version ? artifact.capabilities : historical.data?.capabilities
	const proposal =
		access === "view" || capabilities !== undefined
			? grantAt(access, capabilities ?? {})
			: undefined
	const action = publicationGrantAction(saved, access, proposal)
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-end gap-2">
				{children}
				<AccessSelect
					label="Public data access"
					value={access}
					set={setAccess}
					disabled={pending}
				/>
				<Button
					variant={action.variant}
					disabled={pending || !action.enabled}
					onClick={() => apply(access)}
				>
					{action.label}
				</Button>
			</div>
			<GrantPreview version={served} grants={proposal} error={historical.error} />
		</div>
	)
}

function PublicationDetails({
	publication,
	latestVersion,
}: {
	readonly publication: NonNullable<JsonArtifact["publication"]>
	readonly latestVersion: number
}): React.JSX.Element {
	return (
		<>
			<Address url={publication.url} />
			<DescriptionList>
				<Description label="Serves">
					{publication.version === null
						? `The latest version, now v${latestVersion}`
						: `v${publication.version}, pinned`}
				</Description>
				<Description label="Published">{timeAgo(publication.published_at)}</Description>
				<Description label="Saved data access">
					{ACCESS_LEVELS.find((level) => level.value === publication.access)?.label}
				</Description>
				<Description label="Saved collection grants">
					<GrantedCollections grants={publication.grants} />
				</Description>
			</DescriptionList>
		</>
	)
}

type PublicationChange = number | "latest" | { readonly address: string }

function PublicationSection({
	artifact,
	version,
}: {
	readonly artifact: JsonArtifact
	readonly version: number
}): React.JSX.Element {
	const { publication } = artifact
	const condition = publicationCondition(artifact)
	const editorKey = JSON.stringify(condition)
	const queryClient = useQueryClient()
	const [serve, setServe] = useState<"latest" | "pinned">("latest")
	const [notice, setNotice] = useState("")
	const [confirmAddress, setConfirmAddress] = useState<string | null>(null)
	const confirmation = useRef<string | null>(null)
	const setConfirmation = (address: string | null) => {
		confirmation.current = address
		setConfirmAddress(address)
	}
	const mutationKey = ["artifact-publication", artifact.id]
	const filter = { mutationKey, exact: true }
	const pending = useIsMutating(filter) > 0
	const publishKey = useSubmissionKey()
	const unpublishKey = useSubmissionKey()
	const change = useAction(
		async (target: PublicationChange, level?: ArtifactAccessLevel) => {
			const { queryKey } = artifactQuery(artifact.id)
			let updated: JsonArtifact
			if (typeof target === "object") {
				updated = await checkfu.artifacts
					.unpublish(artifact.id, target.address, unpublishKey.keyFor(target))
					.catch(async (error: unknown) => {
						if (error instanceof ApiError && error.status === 409) {
							setConfirmation(null)
							unpublishKey.settle()
							await queryClient.invalidateQueries({ queryKey, exact: true })
						}
						throw error
					})
				unpublishKey.settle()
				setConfirmation(null)
				setServe("latest")
			} else {
				const body = {
					version: target,
					...(level === undefined ? {} : { access: level }),
					if_current: condition,
				}
				updated = await checkfu.artifacts
					.publish(artifact.id, body, publishKey.keyFor({ body, publication }))
					.catch(async (error: unknown) => {
						if (error instanceof ApiError && error.status === 409) {
							await queryClient.invalidateQueries({ queryKey, exact: true })
						}
						throw error
					})
				publishKey.settle()
				if (
					level !== undefined &&
					updated.publication !== null &&
					(publication === null || updated.publication.address === publication.address)
				) {
					setNotice(publication === null ? "Artifact published." : "Public data access updated.")
				}
			}
			await queryClient.cancelQueries({ queryKey, exact: true })
			queryClient.setQueryData(queryKey, updated)
		},
		{ mutationKey, invalidates: [["artifacts"]] },
	)
	const run = (target: PublicationChange, level?: ArtifactAccessLevel) => {
		if (queryClient.isMutating(filter) === 0) {
			setNotice("")
			change.run(target, level)
		}
	}
	return (
		<section className="space-y-3">
			<div className="space-y-1">
				<h2 className="text-sm font-medium">Public address</h2>
				<p className="text-control text-muted-foreground">
					{publication === null
						? "Not published. Publishing gives the artifact a lasting address."
						: "Anyone with this address can open the artifact. Public data access is limited by the saved grants and the version served."}
				</p>
			</div>
			{publication === null ? (
				<PublicationGrantEditor
					key={editorKey}
					artifact={artifact}
					target={serve === "pinned" ? version : "latest"}
					pending={pending}
					apply={(level) => run(serve === "pinned" ? version : "latest", level)}
				>
					<Field label="Serve" className="w-48">
						<Select
							value={serve}
							disabled={pending}
							onChange={(event) => setServe(event.target.value === "pinned" ? "pinned" : "latest")}
						>
							<option value="latest">Follow latest</option>
							<option value="pinned">Pin v{version}</option>
						</Select>
					</Field>
				</PublicationGrantEditor>
			) : (
				<>
					<PublicationDetails publication={publication} latestVersion={artifact.version} />
					{confirmAddress === publication.address ? (
						<Confirm
							label="Unpublish"
							pending={pending}
							onConfirm={() => {
								const address = confirmation.current
								if (address === publication.address) {
									run({ address })
								}
							}}
							onCancel={() => {
								if (queryClient.isMutating(filter) === 0) {
									setConfirmation(null)
								}
							}}
						>
							Unpublish {artifact.name}? Its address stops working at once, and publishing again
							gives it a new one.
						</Confirm>
					) : (
						<div className="space-y-3">
							<PublicationGrantEditor
								key={editorKey}
								artifact={artifact}
								target={publication.version ?? "latest"}
								pending={pending}
								apply={(level) => run(publication.version ?? "latest", level)}
							/>
							<div className="flex flex-wrap gap-2">
								{publication.version === version ? null : (
									<Button
										variant="outline"
										size="sm"
										disabled={pending}
										onClick={() => run(version)}
									>
										Pin to v{version}
									</Button>
								)}
								{publication.version === null ? null : (
									<Button
										variant="outline"
										size="sm"
										disabled={pending}
										onClick={() => run("latest")}
									>
										Follow latest
									</Button>
								)}
								<Button
									variant="destructive"
									size="sm"
									disabled={pending}
									onClick={() => {
										if (queryClient.isMutating(filter) === 0) {
											setConfirmation(publication.address)
										}
									}}
								>
									Unpublish
								</Button>
							</div>
						</div>
					)}
				</>
			)}
			<p role="status" className="text-control text-muted-foreground">
				{notice}
			</p>
			{change.error === undefined ? null : <Callout tone="error">{change.error}</Callout>}
		</section>
	)
}
