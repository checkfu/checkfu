import type { JsonSession, JsonSessionEvent } from "@checkfu/sdk/client"
import type { SessionEventType } from "@checkfu/sdk/Schemas"
import { useMountEffect } from "@checkfu/ui/use-mount-effect"
import { useState } from "react"
import { useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query"
import { checkfu, errorMessage, isSignedOut } from "../api.ts"
import { eventsOf, isFinal, sessionQuery, transcriptQuery, withStreamed } from "../queries.ts"

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

const statusAfter = (
	status: JsonSession["status"],
	event: JsonSessionEvent,
): JsonSession["status"] => {
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
	session,
	onTransition,
}: {
	readonly session: JsonSession
	readonly onTransition: () => void
}) {
	const queryClient = useQueryClient()
	const transcript = transcriptQuery(session.id)
	const history = useSuspenseInfiniteQuery(transcript)
	const [error, setError] = useState<string>()
	const events = eventsOf(history.data)
	useMountEffect(() => {
		if (isFinal(session, events)) {
			return
		}
		let lastSeq = events.at(-1)?.seq ?? 0
		const source = new EventSource(checkfu.sessions.streamUrl(session.id, lastSeq))
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
			queryClient.setQueryData(transcript.queryKey, (current) =>
				current === undefined ? current : withStreamed(current, event),
			)
			if (event.type === "session.status_idle" || event.type === "session.archived") {
				onTransition()
			}
			if (event.type === "session.archived") {
				settle()
				source.close()
			}
		}
		const ended = async () => {
			const latest = await queryClient.fetchQuery({ ...sessionQuery(session.id), staleTime: 0 })
			if (latest.archived_at === null) {
				setError("Live updates stopped. Reload the page to try again.")
			} else {
				await queryClient.invalidateQueries({ queryKey: transcript.queryKey })
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
				ended().catch((error_: unknown) => setError(errorMessage(error_)))
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
		status: events.reduce(statusAfter, session.status),
		turn: events.reduce(turnAfter, session.turn),
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
