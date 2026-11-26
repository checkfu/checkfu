import type { JsonSessionEvent } from "@checkfu/sdk/client"
import type { SessionEventType } from "@checkfu/sdk/Schemas"
import { parseEventJson } from "./json-boundary.ts"

export interface Source {
	readonly readyState: number
	readonly addEventListener: (
		type: string,
		listener: (message: MessageEvent<string>) => void,
	) => void
	readonly close: () => void
}

export type Connection = "live" | "reconnecting"

const CLOSED = 2
const QUIET_MS = 5000
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000] as const

const EVENT_TYPES: Record<SessionEventType, true> = {
	"user.message": true,
	"user.interrupt": true,
	"session.status_running": true,
	"span.model_request_start": true,
	"agent.thinking": true,
	"agent.message": true,
	"agent.tool_use": true,
	"agent.tool_result": true,
	"agent.mcp_tool_use": true,
	"agent.mcp_tool_result": true,
	"span.model_request_end": true,
	"session.status_idle": true,
	"session.error": true,
	"session.status_terminated": true,
	"session.archived": true,
}

export const follow = ({
	open,
	cursor,
	receive,
	mayRetry,
	connection,
}: {
	readonly open: (after: number) => Source
	readonly cursor: () => number
	readonly receive: (event: JsonSessionEvent) => void
	readonly mayRetry: () => Promise<boolean>
	readonly connection: (state: Connection) => void
}): (() => void) => {
	let source: Source | undefined
	let stopped = false
	let attempt = 0
	let retry: ReturnType<typeof setTimeout> | undefined
	let quiet: ReturnType<typeof setTimeout> | undefined
	const interrupted = () => {
		if (quiet === undefined) {
			quiet = setTimeout(() => connection("reconnecting"), QUIET_MS)
		}
	}
	const stop = () => {
		stopped = true
		clearTimeout(retry)
		clearTimeout(quiet)
		source?.close()
	}
	const reconnect = () => {
		const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
		attempt += 1
		retry = setTimeout(connect, delay)
	}
	const closed = () => {
		source?.close()
		interrupted()
		mayRetry().then(
			(allowed) => (allowed && !stopped ? reconnect() : stop()),
			() => (stopped ? undefined : reconnect()),
		)
	}
	function connect() {
		if (stopped) {
			return
		}
		const current = open(cursor())
		source = current
		for (const type of Object.keys(EVENT_TYPES)) {
			current.addEventListener(type, (message) => {
				const event = parseEventJson(message.data)
				receive(event)
				if (event.type === "session.archived") {
					stop()
				}
			})
		}
		current.addEventListener("open", () => {
			attempt = 0
			clearTimeout(quiet)
			quiet = undefined
			connection("live")
		})
		current.addEventListener("error", () => {
			if (current.readyState === CLOSED) {
				closed()
			} else {
				interrupted()
			}
		})
	}
	connect()
	return stop
}
