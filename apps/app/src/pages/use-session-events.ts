import { accumulateSessionEvent } from "@checkfu/sdk/client"
import type { JsonSession, JsonSessionEvent, SessionMessagePreview } from "@checkfu/sdk/client"
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
	sessionOutputsQuery,
	transcriptQuery,
} from "../queries.ts"
import { loadUntilWaitingCallsSeen, sessionCallsOf } from "../tool-calls.ts"

const REFRESH_MS = 250

const NO_EVENTS: ReadonlyArray<JsonSessionEvent> = []

const CHANGES_SNAPSHOT: ReadonlySet<SessionEventType> = new Set([
	"session.status_running",
	"span.model_request_end",
	"session.status_idle",
	"session.status_terminated",
	"session.archived",
])

const captureTurnOf = (event: JsonSessionEvent) =>
	event.type === "session.status_idle" &&
	["end_turn", "budget_reached", "refusal"].includes(event.stop_reason.type)
		? event.turn
		: undefined

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
	const tail = useQuery(live).data ?? NO_EVENTS
	const [preview, setPreview] = useState<SessionMessagePreview>()
	const [connection, setConnection] = useState<Connection>("live")
	const [outputRecovery, setOutputRecovery] = useState(0)
	const [batch] = useState(
		() =>
			new EventBatch((events) =>
				queryClient.setQueryData(live.queryKey, (seen = []) => mergeBySeq(seen, events)),
			),
	)
	const refresh = useRef<ReturnType<typeof setTimeout>>(undefined)
	const events = transcriptEvents(eventsOf(history.data), tail)
	const captured = events.findLast((event) => captureTurnOf(event) !== undefined)
	const calls = sessionCallsOf(events)
	const { unseen } = calls
	const findingCalls = useQuery({
		queryKey: ["waiting-calls", session.id, unseen],
		enabled: unseen.length > 0 && history.hasNextPage,
		queryFn: () =>
			loadUntilWaitingCallsSeen(async () => {
				const older = await history.fetchNextPage()
				return {
					events: transcriptEvents(older.data === undefined ? [] : eventsOf(older.data), tail),
					more: older.hasNextPage,
					failure: older.isFetchNextPageError ? older.error : undefined,
				}
			}),
		staleTime: Number.POSITIVE_INFINITY,
	})
	useMountEffect(() => {
		const invalidateOutputs = () =>
			void queryClient.invalidateQueries({ queryKey: sessionOutputsQuery(session.id).queryKey })
		const resync = () => {
			if (refresh.current === undefined) {
				refresh.current = setTimeout(() => {
					refresh.current = undefined
					onSnapshotChange()
				}, REFRESH_MS)
			}
		}
		const receive = (event: JsonSessionEvent) => {
			batch.add([event])
			if (event.type === "agent.message" || event.type === "span.model_request_end") {
				batch.flush()
				setPreview(undefined)
			}
			if (CHANGES_SNAPSHOT.has(event.type)) {
				resync()
			}
			if (captureTurnOf(event) !== undefined) {
				invalidateOutputs()
			}
		}
		const stop = isFinal(events)
			? () => undefined
			: follow({
					open: (after) => new EventSource(checkfu.sessions.streamUrl(session.id, after)),
					preview: (event) => setPreview((current) => accumulateSessionEvent(current, event)),
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
					recovered: () => {
						invalidateOutputs()
						setOutputRecovery((count) => count + 1)
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
		outputTurn: captured === undefined ? 0 : (captureTurnOf(captured) ?? 0),
		outputRecovery,
		preview,
		calls,
		reconnecting: connection === "reconnecting",
		findingCalls:
			unseen.length === 0
				? null
				: {
						pending: history.hasNextPage && !findingCalls.isError,
						error:
							findingCalls.error === null || isSignedOut(findingCalls.error)
								? undefined
								: errorMessage(findingCalls.error),
						retry: () => void findingCalls.refetch(),
					},
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
