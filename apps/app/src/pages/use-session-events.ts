import type { JsonSession, JsonSessionEvent, JsonSessionEventPreview } from "@checkfu/sdk/client"
import type { SessionEventType } from "@checkfu/sdk/Schemas"
import { useMountEffect } from "@checkfu/ui/use-mount-effect"
import { useQuery, useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { checkfu, errorMessage, isSignedOut } from "../api.ts"
import { EventBatch, mergeBySeq, transcriptEvents } from "../event-tail.ts"
import { follow } from "../event-stream.ts"
import type { Connection } from "../event-stream.ts"
import {
	eventsOf,
	isFinal,
	liveQuery,
	newestSeqOf,
	sessionQuery,
	transcriptQuery,
} from "../queries.ts"

const REFRESH_MS = 250

const CHANGES_SNAPSHOT: ReadonlySet<SessionEventType> = new Set([
	"session.status_running",
	"span.model_request_end",
	"session.status_idle",
	"session.status_terminated",
	"session.archived",
])

export function useSessionEvents({
	session,
	onSnapshotChange,
}: {
	readonly session: JsonSession
	readonly onSnapshotChange: () => void
}) {
	const queryClient = useQueryClient()
	const transcript = transcriptQuery(session.id)
	const live = liveQuery(session.id)
	const history = useSuspenseInfiniteQuery(transcript)
	const tail = useQuery(live).data ?? []
	const [preview, setPreview] = useState<{ readonly id: string; readonly text: string }>()
	const [connection, setConnection] = useState<Connection>("live")
	const [batch] = useState(
		() =>
			new EventBatch((events) =>
				queryClient.setQueryData(live.queryKey, (seen = []) => mergeBySeq(seen, events)),
			),
	)
	const refresh = useRef<ReturnType<typeof setTimeout>>(undefined)
	const events = transcriptEvents(eventsOf(history.data), tail)
	useMountEffect(() => {
		const resync = () => {
			if (refresh.current === undefined) {
				refresh.current = setTimeout(() => {
					refresh.current = undefined
					onSnapshotChange()
				}, REFRESH_MS)
			}
		}
		const receive = (event: JsonSessionEvent) => {
			if (event.type === "agent.message" || event.type === "span.model_request_end") {
				setPreview(undefined)
			}
			batch.add([event])
			if (CHANGES_SNAPSHOT.has(event.type)) {
				resync()
			}
		}
		const stop = isFinal(events)
			? () => undefined
			: follow({
					open: (after) =>
						new EventSource(
							checkfu.sessions.streamUrl(session.id, after) + "&event_deltas%5B%5D=agent.message",
						),
					preview: (event: JsonSessionEventPreview) => {
						if (event.type === "event_start") {
							if (event.event.type === "agent.message") {
								setPreview({ id: event.event.id, text: "" })
							}
						} else {
							setPreview((current) =>
								current?.id === event.event_id
									? { ...current, text: current.text + event.delta.content.text }
									: current,
							)
						}
					},
					cursor: () =>
						Math.max(
							newestSeqOf(queryClient.getQueryData(transcript.queryKey)),
							queryClient.getQueryData(live.queryKey)?.at(-1)?.seq ?? 0,
							batch.newestSeq(),
						),
					receive,
					mayRetry: () =>
						queryClient.fetchQuery({ ...sessionQuery(session.id), staleTime: 0 }).then(
							() => true,
							(error: unknown) => (isSignedOut(error) ? false : Promise.reject(error)),
						),
					connection: (state) => {
						setConnection(state)
						setPreview(undefined)
						if (state === "live") {
							resync()
						}
					},
				})
		return () => {
			stop()
			clearTimeout(refresh.current)
			refresh.current = undefined
			batch.dispose()
		}
	})
	return {
		events,
		preview,
		reconnecting: connection === "reconnecting",
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
