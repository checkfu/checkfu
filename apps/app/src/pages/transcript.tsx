import { cn } from "@checkfu/ui/cn"
import type { JsonSessionEvent } from "@checkfu/sdk/client"
import type * as React from "react"

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
