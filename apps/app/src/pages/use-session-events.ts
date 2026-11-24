import type { JsonSessionEvent } from "@checkfu/sdk/client"
import type { SessionEventType } from "@checkfu/sdk/Schemas"
import { useMountEffect } from "@checkfu/ui/use-mount-effect"
import { useState } from "react"
import { checkfu } from "../api.ts"
import type { EventPage } from "../api.ts"
import { useAction } from "../use-action.ts"

type Status = "idle" | "running" | "terminated"

const QUIET_RECONNECT_MS = 5000

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

const BATCH_MS = 50

const ascending = (page: EventPage) => page.data.toReversed()
const olderThan = (page: EventPage) => (page.has_more ? page.next_cursor : null)

const turnAfter = (turn: number, event: JsonSessionEvent): number =>
	event.type === "session.status_running" && "turn" in event && typeof event.turn === "number"
		? event.turn
		: turn

export function useSessionEvents({
	sessionId,
	snapshot,
	history,
	onTransition,
}: {
	readonly sessionId: string
	readonly snapshot: { readonly status: Status; readonly turn: number }
	readonly history: EventPage
	readonly onTransition: () => void
}) {
	const [events, setEvents] = useState(() => ascending(history))
	const [older, setOlder] = useState(() => olderThan(history))
	const [status, setStatus] = useState(() =>
		ascending(history).reduce(statusAfter, snapshot.status),
	)
	const [turn, setTurn] = useState(() => ascending(history).reduce(turnAfter, snapshot.turn))
	const [error, setError] = useState<string>()
	const earlier = useAction(async () => {
		if (older === null) {
			return
		}
		const page = await checkfu.sessions.events(sessionId, older)
		setEvents((loaded) => ascending(page).concat(loaded))
		setOlder(olderThan(page))
	})
	useMountEffect(() => {
		let lastSeq = history.data[0]?.seq ?? 0
		const source = new EventSource(checkfu.sessions.streamUrl(sessionId, lastSeq))
		let slowReconnect: ReturnType<typeof setTimeout> | undefined
		let pending: Array<JsonSessionEvent> = []
		let flushTimer: ReturnType<typeof setTimeout> | undefined
		const settle = () => {
			clearTimeout(slowReconnect)
			slowReconnect = undefined
		}
		const flush = () => {
			const batch = pending
			pending = []
			flushTimer = undefined
			setEvents((seen) => seen.concat(batch))
			setStatus((current) => batch.reduce(statusAfter, current))
			setTurn((current) => batch.reduce(turnAfter, current))
		}
		const receive = (message: MessageEvent<string>) => {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary: the API's own event JSON, typed by @checkfu/sdk
			const event = JSON.parse(message.data) as JsonSessionEvent
			if (event.seq <= lastSeq) {
				return
			}
			lastSeq = event.seq
			pending.push(event)
			if (flushTimer === undefined) {
				flushTimer = setTimeout(flush, BATCH_MS)
			}
			if (event.type === "session.status_idle" || event.type === "session.archived") {
				onTransition()
			}
			if (event.type === "session.archived") {
				settle()
				source.close()
			}
		}
		for (const type of Object.keys(EVENT_TYPES)) {
			source.addEventListener(type, receive)
		}
		source.addEventListener("open", () => {
			settle()
			setError(undefined)
		})
		source.addEventListener("error", () => {
			if (source.readyState === EventSource.CLOSED) {
				settle()
				setError("Live updates stopped. Reload the page to try again.")
			} else if (slowReconnect === undefined) {
				slowReconnect = setTimeout(
					() => setError("Live updates were interrupted. Reconnecting…"),
					QUIET_RECONNECT_MS,
				)
			}
		})
		return () => {
			clearTimeout(flushTimer)
			settle()
			source.close()
		}
	})
	return { events, status, turn, error, earlier: older === null ? null : earlier }
}
