import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Field } from "@checkfu/ui/field"
import { shortId, timeAgo } from "@checkfu/ui/format"
import { Input } from "@checkfu/ui/input"
import { Description, DescriptionList, PageHeader } from "@checkfu/ui/page-header"
import { DataTable } from "@checkfu/ui/table"
import type { JsonVault, JsonVaultCredential } from "@checkfu/sdk/client"
import {
	useQuery,
	useQueryClient,
	useSuspenseInfiniteQuery,
	useSuspenseQuery,
} from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { PlusIcon } from "lucide-react"
import { useRef, useState } from "react"
import type * as React from "react"
import { ApiError, checkfu, errorMessage } from "../api.ts"
import { Pager } from "../pager.tsx"
import {
	ERASING_POLL_MS,
	credentialPages,
	present,
	vaultErasing,
	vaultQuery,
	vaultsPage,
} from "../queries.ts"
import { LifecycleStatus, Status } from "../status.tsx"
import { useAction, useSubmissionKey } from "../use-action.ts"
import { canonicalServerUrl } from "../mcp-url.ts"

const list = getRouteApi("/_app/vaults/")
const detail = getRouteApi("/_app/vaults/$vaultId")

export function VaultsPage(): React.JSX.Element {
	const search = list.useSearch()
	const page = useSuspenseQuery(vaultsPage(search.page)).data
	return (
		<>
			<PageHeader
				title="Vaults"
				description="Credentials sessions can use to reach MCP servers. A secret is never shown again once saved."
				actions={
					<Button size="sm" asChild>
						<Link to="/vaults/new">
							<PlusIcon /> New vault
						</Link>
					</Button>
				}
			/>
			<DataTable
				rows={page.data}
				rowKey={(vault) => vault.id}
				empty="No vaults yet."
				columns={[
					{
						key: "name",
						header: "Name",
						cell: (vault) => (
							<Link
								to="/vaults/$vaultId"
								params={{ vaultId: vault.id }}
								className="hover:underline"
							>
								{vault.display_name}
							</Link>
						),
					},
					{
						key: "id",
						header: "ID",
						cell: (vault) => shortId(vault.id),
						className: "font-mono text-xs text-muted-foreground",
					},
					{
						key: "status",
						header: "Status",
						cell: (vault) => <LifecycleStatus resource={vault} />,
					},
					{
						key: "updated",
						header: "Updated",
						cell: (vault) => timeAgo(vault.updated_at),
						className: "text-muted-foreground",
					},
				]}
			/>
			<Pager next={page.next_page} paged={search.page !== undefined} />
		</>
	)
}

export function NewVaultPage(): React.JSX.Element {
	const navigate = useNavigate()
	const createKey = useSubmissionKey()
	const [name, setName] = useState("")
	const create = useAction(
		async () => {
			const body = { display_name: name.trim() }
			const vault = await checkfu.vaults.create(body, createKey.keyFor(body))
			createKey.settle()
			return vault
		},
		{
			invalidates: [["vaults"]],
			then: (vault) => void navigate({ to: "/vaults/$vaultId", params: { vaultId: vault.id } }),
		},
	)
	return (
		<>
			<PageHeader title="New vault" breadcrumb={<Link to="/vaults">Vaults</Link>} />
			<form
				className="max-w-2xl"
				onSubmit={(event) => {
					event.preventDefault()
					create.run()
				}}
			>
				<fieldset disabled={create.pending} className="min-w-0 space-y-4">
					<Field label="Name" description="For example the person or team whose accounts it holds.">
						<Input required value={name} onChange={(event) => setName(event.target.value)} />
					</Field>
					{create.error === undefined ? null : <Callout tone="error">{create.error}</Callout>}
					<Button type="submit" disabled={create.pending || name.trim() === ""}>
						Create vault
					</Button>
				</fieldset>
			</form>
		</>
	)
}

export function VaultPage(): React.JSX.Element {
	const { vaultId } = detail.useParams()
	const vault = present(useSuspenseQuery(vaultQuery(vaultId)))
	return <VaultView key={vault.id} vault={vault} />
}

const owedBy = (vault: JsonVault): number =>
	vault.custody.erasing +
	(vault.archived_at === null ? 0 : vault.custody.held + vault.custody.storing)

const later = (a: string, b: string): string => (Date.parse(a) >= Date.parse(b) ? a : b)

function useErasureWatch(vault: JsonVault) {
	const queryClient = useQueryClient()
	const [watch, setWatch] = useState<{ readonly receipts: number; readonly before: string }>()
	const watched = useQuery({
		...vaultQuery(vault.id),
		enabled: watch !== undefined,
		refetchInterval: watch === undefined ? false : ERASING_POLL_MS,
	})
	const latest = watched.data ?? vault
	const fresh = watch !== undefined && Date.parse(latest.updated_at) > Date.parse(watch.before)
	if (watch !== undefined && fresh && !vaultErasing(latest)) {
		setWatch(undefined)
	}
	return {
		latest,
		owed: watch === undefined || fresh ? owedBy(latest) : Math.max(owedBy(latest), watch.receipts),
		record: (receipts: number, before: string) => {
			setWatch((current) => ({
				receipts: (current?.receipts ?? 0) + receipts,
				before: current === undefined ? before : later(current.before, before),
			}))
			void queryClient.invalidateQueries({ queryKey: vaultQuery(vault.id).queryKey })
		},
	}
}

export function VaultView({ vault: given }: { readonly vault: JsonVault }): React.JSX.Element {
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const erasure = useErasureWatch(given)
	const vault = erasure.latest
	const listed = useSuspenseInfiniteQuery(credentialPages(vault.id, vault.archived_at !== null))
	const credentials = listed.data.pages.flatMap((page) => page.data)
	const archive = useAction(
		async () => {
			const before = vault.updated_at
			const result = await checkfu.vaults.archive(vault.id)
			if (vaultErasing(result)) {
				erasure.record(0, before)
			}
			return result
		},
		{ invalidates: [["vaults"]] },
	)
	const leave = () => {
		void navigate({ to: "/vaults" }).then(() => {
			queryClient.removeQueries({ queryKey: vaultQuery(vault.id).queryKey })
			queryClient.removeQueries({ queryKey: ["vaults", "credentials", vault.id] })
			return queryClient.invalidateQueries({ queryKey: ["vaults"] })
		})
	}
	const [deletedErasing, setDeletedErasing] = useState(false)
	const remove = useAction(async () => checkfu.vaults.delete(vault.id), {
		then: (result) => {
			if (result.secrets === "erasing") {
				setDeletedErasing(true)
			} else {
				leave()
			}
		},
	})
	const archived = vault.archived_at !== null
	const busy = archive.pending || remove.pending
	if (deletedErasing) {
		return (
			<>
				<PageHeader
					title={vault.display_name}
					id={vault.id}
					breadcrumb={<Link to="/vaults">Vaults</Link>}
				/>
				<Callout>
					This vault is deleted. Its secrets are still being erased; this finishes on its own, and
					until it does a session already using one of them may keep using it.{" "}
					<Button variant="ghost" size="sm" onClick={leave}>
						Back to vaults
					</Button>
				</Callout>
			</>
		)
	}
	return (
		<>
			<PageHeader
				title={vault.display_name}
				id={vault.id}
				breadcrumb={<Link to="/vaults">Vaults</Link>}
				accessory={<LifecycleStatus resource={vault} />}
				actions={
					<>
						{archived ? null : (
							<Button variant="outline" size="sm" disabled={busy} onClick={() => archive.run()}>
								Archive
							</Button>
						)}
						<Button variant="destructive" size="sm" disabled={busy} onClick={() => remove.run()}>
							Delete
						</Button>
					</>
				}
			/>
			{[archive.error, remove.error].map((message) =>
				message === undefined ? null : (
					<Callout key={message} tone="error">
						{message}
					</Callout>
				),
			)}
			{erasure.owed === 0 ? null : (
				<Callout>
					{erasure.owed === 1
						? "1 secret is still being erased."
						: `${erasure.owed} secrets are still being erased.`}{" "}
					This finishes on its own; until it does, a session already holding one can still use it.
				</Callout>
			)}
			<DescriptionList>
				<Description label="Secrets being stored">{vault.custody.storing}</Description>
				<Description label="Secrets held">{vault.custody.held}</Description>
				<Description label="Secrets being erased">{vault.custody.erasing}</Description>
				<Description label="Created">{timeAgo(vault.created_at)}</Description>
				<Description label="Updated">{timeAgo(vault.updated_at)}</Description>
			</DescriptionList>
			<section className="space-y-3">
				<h2 className="text-sm font-medium">Credentials</h2>
				<DataTable
					rows={credentials}
					rowKey={(credential) => credential.id}
					empty="No credentials in this vault."
					columns={[
						{
							key: "name",
							header: "Name",
							cell: (credential) => credential.display_name ?? shortId(credential.id),
						},
						{
							key: "server",
							header: "MCP server",
							cell: (credential) => credential.auth.mcp_server_url,
							className: "font-mono text-xs",
						},
						{
							key: "status",
							header: "Status",
							cell: (credential) => <LifecycleStatus resource={credential} />,
						},
						{
							key: "secret",
							header: "Secret",
							cell: (credential) => <Status status={credential.custody} />,
						},
						{
							key: "updated",
							header: "Updated",
							cell: (credential) => timeAgo(credential.updated_at),
							className: "text-muted-foreground",
						},
						{
							key: "actions",
							header: "",
							cell: (credential) => (
								<CredentialActions
									credential={credential}
									vaultEnded={archived}
									vaultUpdatedAt={vault.updated_at}
									onErasing={(before) => erasure.record(1, before)}
								/>
							),
							className: "text-right",
						},
					]}
				/>
				{listed.hasNextPage ? (
					<Button
						variant="ghost"
						size="sm"
						disabled={listed.isFetchingNextPage}
						onClick={() => void listed.fetchNextPage()}
					>
						Load older credentials
					</Button>
				) : null}
				{listed.error === null ? null : (
					<Callout tone="error">{errorMessage(listed.error)}</Callout>
				)}
				{archived ? null : <NewCredentialForm vaultId={vault.id} />}
			</section>
		</>
	)
}

function useSecretField() {
	const ref = useRef<HTMLInputElement>(null)
	const [filled, setFilled] = useState(false)
	const [edits, setEdits] = useState(0)
	return {
		ref,
		filled,
		edits,
		onInput: (event: React.FormEvent<HTMLInputElement>) => {
			setFilled(event.currentTarget.value !== "")
			setEdits((count) => count + 1)
		},
		read: () => ref.current?.value ?? "",
		clear: () => {
			if (ref.current !== null) {
				ref.current.value = ""
			}
			setFilled(false)
		},
	}
}

const URL_TAKEN = "The vault already holds an active credential for this MCP server URL."

const MAYBE_CREATED =
	"An earlier attempt may already have created this credential with the token sent then. Find it in the list and use Replace token to set this one."

const isUrlTaken = (error: unknown): error is ApiError =>
	error instanceof ApiError && error.status === 409 && error.message === URL_TAKEN

const isAmbiguous = (error: unknown): boolean => !(error instanceof ApiError) || error.status >= 500

const canonicalUrl = (url: string): string => canonicalServerUrl(url) ?? url

function SecretInput({
	ref,
	onInput,
	label,
}: {
	readonly ref: React.Ref<HTMLInputElement>
	readonly onInput: (event: React.FormEvent<HTMLInputElement>) => void
	readonly label: string
}): React.JSX.Element {
	return (
		<Field label={label} description="Sent to the MCP server as a bearer token. Never shown again.">
			<Input
				ref={ref}
				type="password"
				autoComplete="off"
				spellCheck={false}
				required
				onInput={onInput}
				className="font-mono"
			/>
		</Field>
	)
}

function NewCredentialForm({ vaultId }: { readonly vaultId: string }): React.JSX.Element {
	const [name, setName] = useState("")
	const [url, setUrl] = useState("")
	const { ref: tokenRef, ...secret } = useSecretField()
	const createKey = useSubmissionKey()
	const unsure = useRef(new Set<string>())
	const create = useAction(
		async () => {
			const token = secret.read()
			const described = {
				mcp_server_url: url.trim(),
				display_name: name.trim() === "" ? null : name.trim(),
			}
			const pair = `${vaultId} ${canonicalUrl(described.mcp_server_url)}`
			const credential = await checkfu.vaults.credentials
				.create(
					vaultId,
					{
						auth: { type: "static_bearer", token, mcp_server_url: described.mcp_server_url },
						display_name: described.display_name,
					},
					createKey.keyFor({ vaultId, ...described, token: secret.edits }),
				)
				.catch((error: unknown) => {
					const earlierUnsure = unsure.current.has(pair)
					if (isAmbiguous(error)) {
						unsure.current.add(pair)
					}
					throw isUrlTaken(error) && earlierUnsure
						? new Error(`${error.message} ${MAYBE_CREATED}`)
						: error
				})
			createKey.settle()
			unsure.current.delete(pair)
			return credential
		},
		{
			invalidates: [["vaults"]],
			then: () => {
				secret.clear()
				setName("")
				setUrl("")
			},
		},
	)
	return (
		<form
			className="max-w-2xl rounded-lg border p-4"
			onSubmit={(event) => {
				event.preventDefault()
				create.run()
			}}
		>
			<fieldset disabled={create.pending} className="min-w-0 space-y-4">
				<h3 className="text-sm font-medium">Add a credential</h3>
				<Field label="Name">
					<Input value={name} onChange={(event) => setName(event.target.value)} />
				</Field>
				<Field
					label="MCP server URL"
					description="The token is only ever sent to this URL. A vault holds one credential per server."
				>
					<Input
						required
						type="url"
						placeholder="https://mcp.example.com/mcp"
						value={url}
						onChange={(event) => setUrl(event.target.value)}
						className="font-mono"
					/>
				</Field>
				<SecretInput label="Token" ref={tokenRef} onInput={secret.onInput} />
				{create.error === undefined ? null : <Callout tone="error">{create.error}</Callout>}
				<Button type="submit" disabled={create.pending || url.trim() === "" || !secret.filled}>
					Save credential
				</Button>
			</fieldset>
		</form>
	)
}

function CredentialActions({
	credential,
	vaultEnded,
	vaultUpdatedAt,
	onErasing,
}: {
	readonly credential: JsonVaultCredential
	readonly vaultEnded: boolean
	readonly vaultUpdatedAt: string
	readonly onErasing: (before: string) => void
}): React.JSX.Element {
	const vaultId = credential.vault_id
	const [rotating, setRotating] = useState(false)
	const { ref: tokenRef, ...secret } = useSecretField()
	const [last, setLast] = useState<"rotate" | "archive" | "remove">()
	const rotate = useAction(
		async () =>
			checkfu.vaults.credentials.update(
				vaultId,
				credential.id,
				{ auth: { type: "static_bearer", token: secret.read() } },
				credential,
			),
		{
			invalidates: [["vaults"]],
			then: () => {
				secret.clear()
				setRotating(false)
			},
		},
	)
	const ending = async <R extends { readonly custody: string }>(end: () => Promise<R>) => {
		const before = vaultUpdatedAt
		const result = await end()
		if (result.custody === "erasing") {
			onErasing(before)
		}
		return result
	}
	const archive = useAction(
		async () => ending(() => checkfu.vaults.credentials.archive(vaultId, credential.id)),
		{ invalidates: [["vaults"]] },
	)
	const remove = useAction(
		async () => ending(() => checkfu.vaults.credentials.delete(vaultId, credential.id)),
		{ invalidates: [["vaults"]] },
	)
	const busy = rotate.pending || archive.pending || remove.pending
	const error = last === undefined ? undefined : { rotate, archive, remove }[last].error
	const active = credential.archived_at === null && !vaultEnded
	const replacing = rotating && active
	return (
		<div className="space-y-2 text-left">
			<div className="flex justify-end gap-2">
				{active ? (
					<>
						<Button
							variant="ghost"
							size="sm"
							disabled={busy}
							onClick={() => {
								secret.clear()
								setRotating(!replacing)
							}}
						>
							{replacing ? "Cancel" : "Replace token"}
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => {
								setLast("archive")
								archive.run()
							}}
						>
							Archive
						</Button>
					</>
				) : null}
				<Button
					variant="destructive"
					size="sm"
					disabled={busy}
					onClick={() => {
						setLast("remove")
						remove.run()
					}}
				>
					Delete
				</Button>
			</div>
			{replacing ? (
				<form
					className="space-y-2"
					onSubmit={(event) => {
						event.preventDefault()
						setLast("rotate")
						rotate.run()
					}}
				>
					<fieldset disabled={rotate.pending} className="min-w-0 space-y-2">
						<SecretInput label="New token" ref={tokenRef} onInput={secret.onInput} />
						<Button type="submit" size="sm" disabled={busy || !secret.filled}>
							Save new token
						</Button>
					</fieldset>
				</form>
			) : null}
			{error === undefined ? null : <Callout tone="error">{error}</Callout>}
		</div>
	)
}
