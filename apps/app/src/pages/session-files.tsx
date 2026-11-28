import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { useMountEffect } from "@checkfu/ui/use-mount-effect"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { DownloadIcon } from "lucide-react"
import { useRef } from "react"
import type * as React from "react"
import { isSignedOut } from "../api.ts"
import type { JsonSessionOutputs } from "../api.ts"
import { sessionOutputsQuery } from "../queries.ts"
import { useAction } from "../use-action.ts"

const RECHECK_MS = 400
const RECHECK_LIMIT = 5

function CaptureRecheck({
	sessionId,
	turn,
}: {
	readonly sessionId: string
	readonly turn: number
}) {
	const client = useQueryClient()
	useMountEffect(() => {
		const query = sessionOutputsQuery(sessionId)
		let active = true
		let attempts = 0
		let timer: ReturnType<typeof setTimeout> | undefined
		const recheck = async () => {
			const current = client.getQueryData(query.queryKey)
			if (!active || attempts >= RECHECK_LIMIT || current === undefined || current.turn >= turn) {
				return
			}
			attempts += 1
			const next = await client.fetchQuery({ ...query, staleTime: 0 }).catch(() => undefined)
			if (active && next !== undefined && next.turn < turn) {
				timer = setTimeout(() => void recheck(), RECHECK_MS)
			}
		}
		timer = setTimeout(() => void recheck(), RECHECK_MS)
		return () => {
			active = false
			clearTimeout(timer)
		}
	})
	return null
}

type SavedFile = JsonSessionOutputs["files"][number]

function startDownload(href: string): void {
	const link = document.createElement("a")
	link.href = href
	link.download = ""
	document.body.append(link)
	link.click()
	link.remove()
}

function CaptureSummary({ outputs }: { readonly outputs: JsonSessionOutputs }): React.JSX.Element {
	if (outputs.status === "none") {
		return <p className="text-sm text-muted-foreground">No files saved yet.</p>
	}
	return (
		<>
			<p className="text-sm text-muted-foreground">
				{outputs.status === "saved" ? "Saved" : "Capture skipped"} in turn {outputs.turn}
				{outputs.recorded_at === null ? null : (
					<>
						{" · "}
						<time dateTime={outputs.recorded_at}>
							{new Date(outputs.recorded_at).toLocaleString()}
						</time>
					</>
				)}
			</p>
			{outputs.status === "skipped" && outputs.reason !== null ? (
				<p className="text-sm">{outputs.reason}</p>
			) : null}
			{outputs.files.length === 0 ? (
				<p className="text-sm text-muted-foreground">No saved files are available.</p>
			) : null}
			{outputs.skipped.length === 0 ? null : (
				<ul className="space-y-1 text-sm text-muted-foreground" aria-label="Skipped files">
					{outputs.skipped.map(({ path, reason }) => (
						<li key={path}>
							<span className="break-all font-mono text-xs">{path}</span>
							{" · "}
							{reason}
						</li>
					))}
				</ul>
			)}
		</>
	)
}

export function SessionFiles({
	sessionId,
	turn,
	recovery,
}: {
	readonly sessionId: string
	readonly turn: number
	readonly recovery: number
}): React.JSX.Element {
	const query = sessionOutputsQuery(sessionId)
	const output = useQuery(query)
	const client = useQueryClient()
	const activeDownload = useRef<AbortController>(null)
	useMountEffect(() => () => activeDownload.current?.abort())
	const download = useAction(async (file: SavedFile, signal: AbortSignal) => {
		if (signal.aborted) {
			return
		}
		const url = `/v1/files/${encodeURIComponent(file.id)}/content`
		const response = await fetch(url, { method: "HEAD", signal }).catch(() => null)
		if (signal.aborted) {
			return
		}
		if (response?.status === 401) {
			throw new Error("Sign in again to download saved files.")
		}
		if (response?.status === 404) {
			void client.invalidateQueries({ queryKey: query.queryKey })
			throw new Error(`${file.filename} is no longer available.`)
		}
		if (response?.ok !== true) {
			throw new Error(`Could not check ${file.filename}. Try downloading it again.`)
		}
		startDownload(url)
	})
	const chooseDownload = (file: SavedFile) => {
		const controller = new AbortController()
		activeDownload.current?.abort()
		activeDownload.current = controller
		download.run(file, controller.signal)
	}
	const outputs = output.data
	const lagging = outputs !== undefined && outputs.turn < turn
	return (
		<section aria-label="Files" className="space-y-2">
			<div className="flex items-center justify-between gap-2">
				<h2 className="text-sm font-medium">Files</h2>
				{lagging || output.isError ? (
					<Button
						variant="ghost"
						size="sm"
						disabled={output.isFetching}
						onClick={() => void output.refetch()}
					>
						{output.isError ? "Retry files" : "Refresh files"}
					</Button>
				) : null}
			</div>
			{output.isPending ? (
				<p role="status" className="text-sm text-muted-foreground">
					Loading saved files…
				</p>
			) : null}
			{output.isError ? (
				<Callout tone="error">
					{isSignedOut(output.error)
						? "Sign in again to see saved files."
						: "Could not load saved files."}
				</Callout>
			) : null}
			{lagging ? (
				<CaptureRecheck key={`${turn}:${recovery}`} sessionId={sessionId} turn={turn} />
			) : null}
			{outputs === undefined ? null : <CaptureSummary outputs={outputs} />}
			{outputs !== undefined && outputs.files.length > 0 ? (
				<>
					{outputs.status === "skipped" ? (
						<p className="text-sm font-medium">Previously saved files</p>
					) : null}
					<ul className="divide-y rounded-md border">
						{outputs.files.map((file) => (
							<li key={file.id} className="flex items-center justify-between gap-3 px-3 py-2">
								<div className="min-w-0">
									<p className="break-all text-sm font-medium">{file.filename}</p>
									<p className="break-all text-xs text-muted-foreground">
										{file.size.toLocaleString()} B
										{file.origin.type === "session"
											? ` · Turn ${file.origin.turn} · ${file.origin.path}`
											: ""}
									</p>
								</div>
								<Button
									aria-label={`Download ${file.filename}`}
									variant="outline"
									size="icon-sm"
									disabled={download.pending}
									onClick={() => chooseDownload(file)}
								>
									<DownloadIcon />
								</Button>
							</li>
						))}
					</ul>
				</>
			) : null}
			{download.error === undefined ? null : <Callout tone="error">{download.error}</Callout>}
		</section>
	)
}
