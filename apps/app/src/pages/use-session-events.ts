import type { JsonSessionEvent } from "@checkfu/sdk/client"
import type { SessionEventType } from "@checkfu/sdk/Schemas"
import { useMountEffect } from "@checkfu/ui/use-mount-effect"
import { useState } from "react"
import { useQuery, useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query"
import { checkfu, errorMessage, isSignedOut } from "../api.ts"
import { sessionHistory, sessionLive } from "../queries.ts"

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

const turnAfter = (turn: number, event: JsonSessionEvent): number =>
	event.type === "session.status_running" && "turn" in event && typeof event.turn === "number"
		? event.turn
		: turn

export function useSessionEvents({
	sessionId,
	snapshot,
	onTransition,
}: {
	readonly sessionId: string
	readonly snapshot: { readonly status: Status; readonly turn: number }
	readonly onTransition: () => void
}) {
	const queryClient = useQueryClient()
	const history = useSuspenseInfiniteQuery(sessionHistory(sessionId))
	const live = useQuery(sessionLive(sessionId)).data ?? []
	const [error, setError] = useState<string>()
	const loaded = history.data.pages.toReversed().flatMap((page) => page.data.toReversed())
	const newest = loaded.at(-1)?.seq ?? 0
	const events = loaded.concat(live.filter((event) => event.seq > newest))
	useMountEffect(() => {
		let lastSeq = Math.max(newest, live.at(-1)?.seq ?? 0)
		const source = new EventSource(checkfu.sessions.streamUrl(sessionId, lastSeq))
		let slowReconnect: ReturnType<typeof setTimeout> | undefined
		const settle = () => {
			clearTimeout(slowReconnect)
			slowReconnect = undefined
		}
		const receive = (message: MessageEvent<string>) => {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary: the API's own event JSON, typed by @checkfu/sdk
			const event = JSON.parse(message.data) as JsonSessionEvent
			if (event.seq <= lastSeq) {
				return
			}
			lastSeq = event.seq
			queryClient.setQueryData(sessionLive(sessionId).queryKey, (seen = []) => [...seen, event])
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
			settle()
			source.close()
		}
	})
	return {
		events,
		status: events.reduce(statusAfter, snapshot.status),
		turn: events.reduce(turnAfter, snapshot.turn),
		error,
		earlier: history.hasNextPage
			? {
					run: () => void history.fetchNextPage(),
					pending: history.isFetchingNextPage,
					error:
						history.error === null || isSignedOut(history.error)
							? undefined
							: errorMessage(history.error),
				}
			: null,
	}
}
