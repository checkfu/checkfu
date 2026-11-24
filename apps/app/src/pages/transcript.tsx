import { cn } from "@checkfu/ui/cn"
import type { JsonSessionEvent } from "@checkfu/sdk/client"
import type { SessionEventType } from "@checkfu/sdk/Schemas"
import * as React from "react"
import { checkfu } from "../api.ts"

type Status = "idle" | "running" | "terminated"

const EVENT_TYPES: Record<SessionEventType, true> = {
	"user.message": true,
	"user.interrupt": true,
	"session.status_running": true,
	"span.model_request_start": true,
	"agent.thinking": true,
	"agent.message": true,
	"span.model_request_end": true,
	"session.status_idle": true,
	"session.error": true,
	"session.status_terminated": true,
	"session.archived": true,
}

const statusAfter = (status: Status, event: JsonSessionEvent): Status => {
	switch (event.type) {
		case "session.status_running":
			return "running"
		case "session.status_idle":
			return "idle"
		case "session.status_terminated":
			return "terminated"
		default:
			return status
	}
}

export function useSessionEvents(sessionId: string, initialStatus: Status) {
	const [events, setEvents] = React.useState<ReadonlyArray<JsonSessionEvent>>([])
	const [status, setStatus] = React.useState(initialStatus)
	const [error, setError] = React.useState<string>()
	React.useEffect(() => {
		const source = new EventSource(checkfu.sessions.streamUrl(sessionId))
		let archived = false
		const receive = (message: MessageEvent<string>) => {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary: the API's own event JSON, typed by @checkfu/sdk
			const event = JSON.parse(message.data) as JsonSessionEvent
			archived ||= event.type === "session.archived"
			setEvents((seen) => (seen.some((known) => known.seq === event.seq) ? seen : [...seen, event]))
			setStatus((current) => statusAfter(current, event))
		}
		for (const type of Object.keys(EVENT_TYPES)) {
			source.addEventListener(type, receive)
		}
		source.addEventListener("open", () => setError(undefined))
		source.addEventListener("error", () => {
			if (source.readyState === EventSource.CONNECTING) {
				setError("Live updates were interrupted. Reconnecting…")
			} else if (!archived) {
				setError("Live updates stopped. Reload the page to try again.")
			}
		})
		return () => source.close()
	}, [sessionId])
	return { events, status, error }
}

const text = (content: ReadonlyArray<{ readonly text: string }>): string =>
	content.map((block) => block.text).join("")

function Bubble({
	from,
	children,
	className,
}: {
	readonly from: string
	readonly children: React.ReactNode
	readonly className?: string
}): React.JSX.Element {
	return (
		<div className={cn("space-y-1", className)}>
			<p className="text-meta font-medium tracking-wide text-muted-foreground uppercase">{from}</p>
			<div className="text-sm leading-relaxed whitespace-pre-wrap">{children}</div>
		</div>
	)
}

function Entry({ event }: { readonly event: JsonSessionEvent }): React.JSX.Element | null {
	switch (event.type) {
		case "user.message":
			return (
				<Bubble from="You" className="rounded-lg bg-muted/60 px-4 py-3">
					{text(event.content)}
				</Bubble>
			)
		case "agent.message":
			return <Bubble from="Agent">{text(event.content)}</Bubble>
		case "agent.thinking":
			return event.thinking === "" ? null : (
				<details className="text-control text-muted-foreground">
					<summary className="cursor-pointer">Thinking</summary>
					<p className="mt-1 whitespace-pre-wrap">{event.thinking}</p>
				</details>
			)
		case "user.interrupt":
			return <p className="text-control text-muted-foreground">You interrupted the turn.</p>
		case "session.error":
			return (
				<p className="text-control text-destructive">
					{event.error.type}: {event.error.message}
				</p>
			)
		case "session.status_idle":
			return event.stop_reason.type === "end_turn" ? null : (
				<p className="text-control text-muted-foreground">
					Turn ended: {event.stop_reason.type.replaceAll("_", " ")}
				</p>
			)
		case "session.status_terminated":
			return <p className="text-control text-muted-foreground">Session terminated.</p>
		default:
			return null
	}
}

export function Transcript({
	events,
}: {
	readonly events: ReadonlyArray<JsonSessionEvent>
}): React.JSX.Element {
	return (
		<ol className="space-y-5">
			{events.map((event) => (
				<li key={event.seq}>
					<Entry event={event} />
				</li>
			))}
			{events.length === 0 ? (
				<li className="text-sm text-muted-foreground">No messages yet.</li>
			) : null}
		</ol>
	)
}
