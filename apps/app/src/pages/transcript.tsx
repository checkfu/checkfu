import { cn } from "@checkfu/ui/cn"
import type { JsonSessionEvent } from "@checkfu/sdk/client"
import type * as React from "react"
import { toolCallsOf } from "../tool-calls.ts"
import type { ToolCalls } from "../tool-calls.ts"
import { ToolCallRow } from "./tool-call.tsx"
import type { SendAnswer } from "./tool-call.tsx"

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

const entryOf = (
	event: JsonSessionEvent,
	calls: ToolCalls,
	send: SendAnswer | undefined,
): React.JSX.Element | null => {
	switch (event.type) {
		case "user.message":
			return (
				<Bubble from="You" className="rounded-lg bg-muted/60 px-4 py-3">
					{text(event.content)}
				</Bubble>
			)
		case "agent.message":
			return (
				<Bubble from="Agent">
					{text(event.content)}
					{event.truncated === true ? (
						<span className="mt-2 block text-control text-muted-foreground">
							Checkfu shortened this reply: the rest was too long to store.
						</span>
					) : null}
				</Bubble>
			)
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
			return event.stop_reason.type === "end_turn" ||
				event.stop_reason.type === "requires_action" ? null : (
				<p className="text-control text-muted-foreground">
					Turn ended: {event.stop_reason.type.replaceAll("_", " ")}
				</p>
			)
		case "session.status_terminated":
			return <p className="text-control text-muted-foreground">Session terminated.</p>
		case "agent.tool_use":
		case "agent.mcp_tool_use":
		case "agent.custom_tool_use": {
			const call = calls.calls.get(event.tool_use_id)
			return call === undefined ? null : <ToolCallRow call={call} send={send} />
		}
		default:
			return null
	}
}

export function Transcript({
	events,
	calls = toolCallsOf(events),
	send,
}: {
	readonly events: ReadonlyArray<JsonSessionEvent>
	readonly calls?: ToolCalls | undefined
	readonly send?: SendAnswer | undefined
}): React.JSX.Element {
	const rows = events.flatMap((event) => {
		const entry = entryOf(event, calls, send)
		return entry === null ? [] : [<li key={event.seq}>{entry}</li>]
	})
	return (
		<ol className="space-y-5">
			{rows.length === 0 ? (
				<li className="text-sm text-muted-foreground">No messages yet.</li>
			) : (
				rows
			)}
		</ol>
	)
}
