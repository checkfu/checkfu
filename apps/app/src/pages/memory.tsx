import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Field } from "@checkfu/ui/field"
import { shortId, timeAgo } from "@checkfu/ui/format"
import { Input, Textarea } from "@checkfu/ui/input"
import { Description, DescriptionList, PageHeader } from "@checkfu/ui/page-header"
import { DataTable } from "@checkfu/ui/table"
import type { JsonMemory, JsonMemoryStore } from "@checkfu/sdk/client"
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { PlusIcon } from "lucide-react"
import { useRef, useState } from "react"
import type * as React from "react"
import { checkfu, errorMessage, isSignedOut } from "../api.ts"
import { Confirm } from "../confirm.tsx"
import { editorOf, rebaseOnto } from "../memory-edit.ts"
import type { MemoryEdit } from "../memory-edit.ts"
import { Pager } from "../pager.tsx"
import {
	memoriesQuery,
	memoryQuery,
	memoryStoreQuery,
	memoryStoresPage,
	present,
} from "../queries.ts"
import { LifecycleStatus } from "../status.tsx"
import { ActionReceipt } from "../action-receipt.tsx"
import { useAction, useSubmissionKey } from "../use-action.ts"

const list = getRouteApi("/_app/memory-stores/")
const store = getRouteApi("/_app/memory-stores/$memoryStoreId/")
const one = getRouteApi("/_app/memory-stores/$memoryStoreId/memories/$memoryId")

const sizeOf = (bytes: number): string =>
	bytes < 1000 ? `${bytes} B` : `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} kB`

export function MemoryStoresPage(): React.JSX.Element {
	const search = list.useSearch()
	const page = useSuspenseQuery(memoryStoresPage(search.page)).data
	return (
		<>
			<PageHeader
				title="Memory"
				description="Files an agent keeps between sessions. A session mounts a store at /mnt/memory."
				actions={
					<Button size="sm" asChild>
						<Link to="/memory-stores/new">
							<PlusIcon /> New store
						</Link>
					</Button>
				}
			/>
			<DataTable
				rows={page.data}
				rowKey={(memoryStore) => memoryStore.id}
				empty="No memory stores yet."
				columns={[
					{
						key: "name",
						header: "Name",
						cell: (memoryStore) => (
							<Link
								to="/memory-stores/$memoryStoreId"
								params={{ memoryStoreId: memoryStore.id }}
								className="hover:underline"
							>
								{memoryStore.name}
							</Link>
						),
					},
					{
						key: "id",
						header: "ID",
						cell: (memoryStore) => shortId(memoryStore.id),
						className: "font-mono text-xs text-muted-foreground",
					},
					{
						key: "status",
						header: "Status",
						cell: (memoryStore) => <LifecycleStatus resource={memoryStore} />,
					},
					{
						key: "updated",
						header: "Updated",
						cell: (memoryStore) => timeAgo(memoryStore.updated_at),
						className: "text-muted-foreground",
					},
				]}
			/>
			<Pager next={page.next_page} paged={search.page !== undefined} />
		</>
	)
}

export function NewMemoryStorePage(): React.JSX.Element {
	const navigate = useNavigate()
	const [name, setName] = useState("")
	const [description, setDescription] = useState("")
	const createKey = useSubmissionKey()
	const create = useAction(
		async () => {
			const body = { name: name.trim(), description }
			const created = await checkfu.memoryStores.create(body, createKey.keyFor(body))
			createKey.settle()
			return created
		},
		{
			invalidates: [["memory-stores"]],
			then: (created) =>
				void navigate({
					to: "/memory-stores/$memoryStoreId",
					params: { memoryStoreId: created.id },
				}),
		},
	)
	return (
		<>
			<ActionReceipt
				receipt={create.receipt}
				href={(id) => `/memory-stores/${encodeURIComponent(id)}`}
			/>
			<PageHeader title="New memory store" breadcrumb={<Link to="/memory-stores">Memory</Link>} />
			<form
				className="max-w-2xl"
				onSubmit={(event) => {
					event.preventDefault()
					create.run()
				}}
			>
				<fieldset disabled={create.blocked} className="min-w-0 space-y-4">
					<Field label="Name" description="The agent sees this name.">
						<Input required value={name} onChange={(event) => setName(event.target.value)} />
					</Field>
					<Field label="Description" description="What the store holds. The agent sees this too.">
						<Input value={description} onChange={(event) => setDescription(event.target.value)} />
					</Field>
					{create.receipt !== undefined || create.error === undefined ? null : (
						<Callout tone="error">{create.error}</Callout>
					)}
					<Button type="submit" disabled={create.blocked}>
						Create store
					</Button>
				</fieldset>
			</form>
		</>
	)
}

export function MemoryStorePage(): React.JSX.Element {
	const { memoryStoreId } = store.useParams()
	const memoryStore = present(useSuspenseQuery(memoryStoreQuery(memoryStoreId)))
	const memories = useSuspenseInfiniteQuery(memoriesQuery(memoryStoreId))
	const cursor = memories.data.pages.at(-1)?.next_page
	const repeated = !memories.hasNextPage && typeof cursor === "string" && cursor !== ""
	const archive = useAction(
		async () => {
			await checkfu.memoryStores.archive(memoryStore.id)
		},
		{ invalidates: [["memory-stores"]] },
	)
	const active = memoryStore.archived_at === null
	return (
		<>
			<PageHeader
				title={memoryStore.name}
				id={memoryStore.id}
				breadcrumb={<Link to="/memory-stores">Memory</Link>}
				accessory={<LifecycleStatus resource={memoryStore} />}
				description={memoryStore.description === "" ? undefined : memoryStore.description}
				actions={
					active ? (
						<Button
							variant="destructive"
							size="sm"
							disabled={archive.blocked}
							onClick={() => archive.run()}
						>
							Archive
						</Button>
					) : undefined
				}
			/>
			<ActionReceipt receipt={archive.receipt} onVisible={archive.confirmReceipt} />
			{archive.error === undefined ? null : <Callout tone="error">{archive.error}</Callout>}
			{active ? null : (
				<Callout>An archived store is read-only, here and in every session that mounts it.</Callout>
			)}
			<DataTable
				rows={memories.data.pages.flatMap((page) => page.data)}
				rowKey={(memory) => memory.id}
				empty="No memories yet. An agent writes them under /mnt/memory, or add one below."
				columns={[
					{
						key: "path",
						header: "Path",
						cell: (memory) => (
							<Link
								to="/memory-stores/$memoryStoreId/memories/$memoryId"
								params={{ memoryStoreId: memoryStore.id, memoryId: memory.id }}
								className="font-mono text-xs hover:underline"
							>
								{memory.path}
							</Link>
						),
					},
					{
						key: "size",
						header: "Size",
						cell: (memory) => sizeOf(memory.content_size_bytes),
						className: "text-muted-foreground",
					},
					{
						key: "updated",
						header: "Updated",
						cell: (memory) => timeAgo(memory.updated_at),
						className: "text-muted-foreground",
					},
				]}
			/>
			{memories.hasNextPage ? (
				<Button
					variant="outline"
					size="sm"
					disabled={memories.isFetching}
					onClick={() => void memories.fetchNextPage({ cancelRefetch: false })}
				>
					{memories.isFetchingNextPage ? "Loading…" : "Load more"}
				</Button>
			) : null}
			{repeated ? (
				<Callout tone="error">Listing stopped because the next page repeated.</Callout>
			) : null}
			{memories.isFetchNextPageError && !isSignedOut(memories.error) ? (
				<Callout tone="error">{errorMessage(memories.error)}</Callout>
			) : null}
			{active ? <NewMemory memoryStore={memoryStore} /> : null}
		</>
	)
}

function NewMemory({ memoryStore }: { readonly memoryStore: JsonMemoryStore }): React.JSX.Element {
	const [path, setPath] = useState("")
	const [content, setContent] = useState("")
	const add = useAction(
		async () => {
			await checkfu.memoryStores.createMemory(memoryStore.id, { path: path.trim(), content })
		},
		{
			invalidates: [["memories", memoryStore.id]],
			then: () => {
				setPath("")
				setContent("")
			},
		},
	)
	return (
		<form
			className="max-w-2xl space-y-4"
			onSubmit={(event) => {
				event.preventDefault()
				add.run()
			}}
		>
			<h2 className="text-sm font-medium">Add a memory</h2>
			<ActionReceipt
				receipt={add.receipt}
				onVisible={async () => {
					setPath("")
					setContent("")
					await add.confirmReceipt()
				}}
			/>
			<fieldset disabled={add.blocked} className="min-w-0 space-y-4">
				<Field label="Path" description="Inside the store, such as /notes/style.md.">
					<Input
						required
						className="font-mono"
						value={path}
						onChange={(event) => setPath(event.target.value)}
					/>
				</Field>
				<Field label="Content">
					<Textarea value={content} onChange={(event) => setContent(event.target.value)} />
				</Field>
				{add.error === undefined ? null : <Callout tone="error">{add.error}</Callout>}
				<Button type="submit" variant="outline" disabled={add.blocked || path.trim() === ""}>
					Add memory
				</Button>
			</fieldset>
		</form>
	)
}

export function MemoryPage(): React.JSX.Element {
	const { memoryStoreId, memoryId } = one.useParams()
	const memoryStore = present(useSuspenseQuery(memoryStoreQuery(memoryStoreId)))
	const memory = present(useSuspenseQuery(memoryQuery(memoryStoreId, memoryId)))
	return <MemoryEditor key={memory.id} memoryStore={memoryStore} memory={memory} />
}

function MemoryEditor({
	memoryStore,
	memory,
}: {
	readonly memoryStore: JsonMemoryStore
	readonly memory: JsonMemory
}): React.JSX.Element {
	const navigate = useNavigate()
	const [edit, setEdit] = useState<MemoryEdit>()
	const [deleting, setDeleting] = useState<JsonMemory>()
	const deleteButton = useRef<HTMLButtonElement>(null)
	const deletingInFlight = useRef(false)
	const { text, base, overtaken, canSave } = editorOf(memory, edit)
	const save = useAction(
		async (draft: MemoryEdit) =>
			checkfu.memoryStores.updateMemory(memoryStore.id, draft.base, draft.text),
		{
			invalidates: [["memories", memoryStore.id]],
			then: () => setEdit(undefined),
		},
	)
	const remove = useAction(
		async (reviewed: JsonMemory) => {
			try {
				await checkfu.memoryStores.deleteMemory(memoryStore.id, reviewed)
			} finally {
				deletingInFlight.current = false
			}
		},
		{
			invalidates: [memoriesQuery(memoryStore.id).queryKey],
			then: () =>
				void navigate({
					to: "/memory-stores/$memoryStoreId",
					params: { memoryStoreId: memoryStore.id },
				}),
		},
	)
	const writable = memoryStore.archived_at === null
	return (
		<>
			<PageHeader
				title={<span className="font-mono">{memory.path}</span>}
				id={memory.id}
				breadcrumb={
					<Link to="/memory-stores/$memoryStoreId" params={{ memoryStoreId: memoryStore.id }}>
						{memoryStore.name}
					</Link>
				}
				actions={
					writable ? (
						<Button
							variant="destructive"
							size="sm"
							ref={deleteButton}
							disabled={remove.pending}
							aria-expanded={deleting !== undefined}
							onClick={() => {
								if (deleting === undefined) {
									setDeleting(base)
								}
							}}
						>
							Delete
						</Button>
					) : undefined
				}
			/>
			{writable && deleting !== undefined ? (
				<Confirm
					label="Delete memory"
					pending={remove.pending}
					onConfirm={() => {
						if (!deletingInFlight.current) {
							deletingInFlight.current = true
							remove.run(deleting)
						}
					}}
					onCancel={() => {
						setDeleting(undefined)
						deleteButton.current?.focus()
					}}
				>
					Permanently delete <span className="font-mono">{deleting.path}</span>? You reviewed v
					{deleting.version}.
				</Confirm>
			) : null}
			<ActionReceipt
				receipt={save.receipt}
				onVisible={async () => {
					await save.confirmReceipt()
					setEdit(undefined)
				}}
			/>
			<DescriptionList>
				<Description label="Size">{sizeOf(memory.content_size_bytes)}</Description>
				<Description label="Version">v{memory.version}</Description>
				<Description label="Updated">{timeAgo(memory.updated_at)}</Description>
			</DescriptionList>
			<form
				className="space-y-2"
				onSubmit={(event) => {
					event.preventDefault()
					if (edit !== undefined && writable && canSave && !save.blocked) {
						save.run(edit)
					}
				}}
			>
				<Textarea
					aria-label="Content"
					className="font-mono"
					readOnly={!writable || save.blocked}
					value={text}
					onChange={(event) => setEdit({ base, text: event.target.value })}
				/>
				{overtaken && edit !== undefined ? (
					<Callout>
						<p>
							This memory was saved as v{memory.version} while you were editing v{base.version}.
							{writable ? " Saving your text would replace the newer version." : null}
						</p>
						<div className="mt-2 flex flex-wrap gap-2">
							{writable ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={save.blocked}
									onClick={() => setEdit(rebaseOnto(memory, edit))}
								>
									Keep my text and replace v{memory.version}
								</Button>
							) : null}
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={save.blocked}
								onClick={() => setEdit(undefined)}
							>
								Discard my edit and load the latest
							</Button>
						</div>
					</Callout>
				) : null}
				{[save.error, remove.error].map((message) =>
					message === undefined ? null : (
						<Callout key={message} tone="error">
							{message}
						</Callout>
					),
				)}
				{writable ? (
					<div className="flex justify-end">
						<Button type="submit" disabled={save.blocked || !canSave}>
							Save
						</Button>
					</div>
				) : null}
			</form>
		</>
	)
}
