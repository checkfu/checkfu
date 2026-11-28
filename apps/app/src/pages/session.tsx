import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Input, Textarea } from "@checkfu/ui/input"
import { Description, DescriptionList, PageHeader } from "@checkfu/ui/page-header"
import type { JsonSession } from "@checkfu/sdk/client"
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { Suspense, lazy, useState } from "react"
import type * as React from "react"
import { ActionReceipt } from "../action-receipt.tsx"
import { checkfu } from "../api.ts"
import { present, sessionQuery } from "../queries.ts"
import { describeResource } from "../session-resources.ts"
import type { SessionResourceItem } from "../session-resources.ts"
import { sessionTitle } from "../session-title.ts"
import { Status } from "../status.tsx"
import { useAction, useSubmissionKey } from "../use-action.ts"
import { sendFailure } from "./tool-call.tsx"
import type { SendAnswer } from "./tool-call.tsx"
import { Transcript } from "./transcript.tsx"
import { useSessionEvents } from "./use-session-events.ts"

const SessionBindings = lazy(async () => ({
	default: (await import("./session-bindings.tsx")).SessionBindings,
}))

const SessionFiles = lazy(async () => ({
	default: (await import("./session-files.tsx")).SessionFiles,
}))

const detail = getRouteApi("/_app/sessions/$sessionId")

export function SessionPage(): React.JSX.Element {
	const { sessionId } = detail.useParams()
	const session = present(useSuspenseQuery(sessionQuery(sessionId)))
	return <SessionView key={session.id} session={session} />
}

function SessionView({ session }: { readonly session: JsonSession }): React.JSX.Element {
	const queryClient = useQueryClient()
	const {
		events,
		preview,
		calls,
		reconnecting,
		earlier,
		findingCalls,
		outputTurn,
		outputRecovery,
	} = useSessionEvents({
		session,
		onSnapshotChange: () => void queryClient.invalidateQueries({ queryKey: ["sessions"] }),
	})
	const { status, turn } = session
	const waiting = calls.waiting.size
	const [text, setText] = useState("")
	const sendKey = useSubmissionKey()
	const send = useAction(
		async (message: string) => {
			const body = {
				events: [
					{ type: "user.message" as const, content: [{ type: "text" as const, text: message }] },
				],
			}
			await checkfu.sessions
				.send(session.id, body, sendKey.keyFor(body))
				.catch((error: unknown) => {
					throw sendFailure(error)
				})
			sendKey.settle()
		},
		{
			invalidates: [["sessions", "one", session.id]],
			then: (_, message) => {
				setText((current) => (current === message ? "" : current))
			},
		},
	)
	const interruptKey = useSubmissionKey()
	const interrupt = useAction(
		async () => {
			const body = { events: [{ type: "user.interrupt" as const }] }
			await checkfu.sessions.send(session.id, body, interruptKey.keyFor({ ...body, turn }))
			interruptKey.settle()
		},
		{ invalidates: [["sessions", "one", session.id]] },
	)
	const archive = useAction(
		async () => {
			await checkfu.sessions.archive(session.id)
		},
		{ invalidates: [["sessions"]] },
	)
	const archived = session.archived_at !== null
	const open = !archived && status !== "terminated"
	const canSend = !send.pending && waiting === 0 && text.trim() !== ""
	const sendAnswer: SendAnswer = async (event, idempotencyKey) => {
		await checkfu.sessions.send(session.id, { events: [event] }, idempotencyKey)
	}
	return (
		<>
			<PageHeader
				title={sessionTitle(session) ?? "Untitled session"}
				id={session.id}
				breadcrumb={<Link to="/sessions">Sessions</Link>}
				accessory={<Status status={archived ? "archived" : waiting > 0 ? "waiting" : status} />}
				description={
					<>
						<Link
							to="/agents/$agentId"
							params={{ agentId: session.agent.id }}
							search={{ version: session.agent.version }}
							className="hover:underline"
						>
							Agent v{session.agent.version}
						</Link>
						{" · "}
						<Link
							to="/environments/$environmentId"
							params={{ environmentId: session.environment_id }}
							className="hover:underline"
						>
							Environment
						</Link>
						{` · ${session.usage.input_tokens + (session.usage.cache_read_input_tokens ?? 0) + (session.usage.cache_creation_input_tokens ?? 0) + session.usage.output_tokens} tokens`}
					</>
				}
				actions={
					!archived ? (
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
			{[
				reconnecting ? "Live updates were interrupted. Reconnecting…" : undefined,
				send.error,
				interrupt.error,
				archive.error,
			].map((message) =>
				message === undefined ? null : (
					<Callout key={message} tone="error">
						{message}
					</Callout>
				),
			)}
			<ActionReceipt receipt={archive.receipt} onVisible={archive.confirmReceipt} />
			<Suspense fallback={null}>
				<SessionBindings session={session} />
			</Suspense>
			{earlier === null ? null : (
				<div className="space-y-2">
					<Button
						variant="ghost"
						size="sm"
						disabled={earlier.pending}
						onClick={() => earlier.run()}
					>
						Load earlier messages
					</Button>
					{earlier.error === undefined ? null : <Callout tone="error">{earlier.error}</Callout>}
				</div>
			)}
			{session.resources.length === 0 ? null : <SessionResources session={session} open={open} />}
			<Suspense fallback={<p role="status">Loading saved files…</p>}>
				<SessionFiles sessionId={session.id} turn={outputTurn} recovery={outputRecovery} />
			</Suspense>
			<Transcript
				events={events}
				preview={preview}
				calls={calls.fold}
				send={open ? sendAnswer : undefined}
			/>
			{open && findingCalls !== null ? (
				findingCalls.error !== undefined ? (
					<div className="space-y-2">
						<Callout tone="error">
							The tool call waiting on you could not be loaded: {findingCalls.error}
						</Callout>
						<Button variant="outline" size="sm" onClick={findingCalls.retry}>
							Retry
						</Button>
					</div>
				) : (
					<Callout>
						{findingCalls.pending
							? "Loading the tool call waiting on you…"
							: "A tool call is waiting on you, but it is not in this session's history. Interrupt to end the turn."}
					</Callout>
				)
			) : null}
			{open && waiting > 0 && findingCalls === null ? (
				<Callout>
					The agent is waiting on you to answer{" "}
					{waiting === 1 ? "a tool call" : `${waiting} tool calls`} above. It takes no new message
					until then; interrupt to end the turn without answering.
				</Callout>
			) : null}
			{open ? (
				<form
					className="sticky bottom-0 space-y-2 bg-background pt-2 pb-4"
					onSubmit={(event) => {
						event.preventDefault()
						if (canSend) {
							send.run(text)
						}
					}}
				>
					<Textarea
						aria-label="Message"
						placeholder="Message the agent"
						value={text}
						onChange={(event) => setText(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
								event.currentTarget.form?.requestSubmit()
							}
						}}
					/>
					<div className="flex justify-end gap-2">
						{status === "running" || waiting > 0 ? (
							<Button
								variant="outline"
								disabled={interrupt.pending}
								onClick={() => interrupt.run()}
							>
								Interrupt
							</Button>
						) : null}
						<Button type="submit" disabled={!canSend}>
							Send
						</Button>
					</div>
				</form>
			) : null}
		</>
	)
}

function SessionResources({
	session,
	open,
}: {
	readonly session: JsonSession
	readonly open: boolean
}): React.JSX.Element {
	return (
		<details className="rounded-lg border p-3 text-sm">
			<summary className="cursor-pointer font-medium">
				Resources ({session.resources.length})
			</summary>
			<div className="mt-3">
				<DescriptionList>
					{session.resources.map((resource) => (
						<Description key={resource.id} label={describeResource(resource).label}>
							<ResourceLine session={session} resource={resource} open={open} />
						</Description>
					))}
				</DescriptionList>
			</div>
		</details>
	)
}

function ResourceLine({
	session,
	resource,
	open,
}: {
	readonly session: JsonSession
	readonly resource: SessionResourceItem
	readonly open: boolean
}): React.JSX.Element {
	const { name, detail } = describeResource(resource)
	const [token, setToken] = useState<string | null>(null)
	const rotate = useAction(
		async (next: string) => {
			await checkfu.sessions.rotateToken(session.id, resource.id, next)
		},
		{ then: () => setToken(null) },
	)
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-baseline gap-x-2">
				{resource.type === "memory_store" ? (
					<Link
						to="/memory-stores/$memoryStoreId"
						params={{ memoryStoreId: resource.memory_store_id }}
						className="hover:underline"
					>
						{name}
					</Link>
				) : (
					<span>{name}</span>
				)}
				<span className="text-muted-foreground">{detail}</span>
				<span className="font-mono text-xs text-muted-foreground">{resource.mount_path}</span>
				{resource.type === "github_repository" && open && token === null ? (
					<Button variant="ghost" size="sm" onClick={() => setToken("")}>
						Replace token
					</Button>
				) : null}
			</div>
			{token === null ? null : (
				<form
					className="flex gap-2"
					onSubmit={(event) => {
						event.preventDefault()
						rotate.run(token)
					}}
				>
					<Input
						type="password"
						autoComplete="off"
						aria-label="New token"
						value={token}
						onChange={(event) => setToken(event.target.value)}
					/>
					<Button type="submit" size="sm" disabled={rotate.pending || token === ""}>
						Save
					</Button>
					<Button variant="ghost" size="sm" onClick={() => setToken(null)}>
						Cancel
					</Button>
				</form>
			)}
			{rotate.error === undefined ? null : <Callout tone="error">{rotate.error}</Callout>}
		</div>
	)
}
