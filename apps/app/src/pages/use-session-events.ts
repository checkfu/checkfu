import type { JsonSession, JsonSessionEvent } from "@checkfu/sdk/client"
import type { SessionEventType } from "@checkfu/sdk/Schemas"
import { useMountEffect } from "@checkfu/ui/use-mount-effect"
import { useRef, useState } from "react"
import { useQuery, useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query"
import { checkfu, errorMessage, isSignedOut } from "../api.ts"
import { EventBatch, mergeBySeq, progressOf, transcriptEvents } from "../event-tail.ts"
import {
	eventsOf,
	isFinal,
	liveQuery,
	newestSeqOf,
	sessionQuery,
	transcriptQuery,
} from "../queries.ts"

const QUIET_RECONNECT_MS = 5000
const REFRESH_MS = 250

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

const CHANGES_SNAPSHOT: ReadonlySet<SessionEventType> = new Set([
	"span.model_request_end",
	"session.status_idle",
	"session.status_terminated",
	"session.archived",
])

const changesSnapshot = (event: JsonSessionEvent): boolean => CHANGES_SNAPSHOT.has(event.type)

const readAfter = async (
	sessionId: string,
	from: number,
	intake: (events: ReadonlyArray<JsonSessionEvent>) => void,
	signal: AbortSignal | undefined,
): Promise<void> => {
	let after = from
	let more = true
	while (more) {
		const page = await checkfu.sessions.eventsAfter(sessionId, after, signal)
		intake(page.data)
		after = page.data.at(-1)?.seq ?? after
		more = page.has_more
	}
}

export function useSessionEvents({
	session,
	onTransition,
}: {
	readonly session: JsonSession
	readonly onTransition: () => void
}) {
	const queryClient = useQueryClient()
	const transcript = transcriptQuery(session.id)
	const live = liveQuery(session.id)
	const history = useSuspenseInfiniteQuery(transcript)
	const tail = useQuery(live).data ?? []
	const [error, setError] = useState<string>()
	const [batch] = useState(
		() =>
			new EventBatch((events) =>
				queryClient.setQueryData(live.queryKey, (seen = []) => mergeBySeq(seen, events)),
			),
	)
	const refresh = useRef<ReturnType<typeof setTimeout>>(undefined)
	const lifetime = useRef<AbortController>(undefined)
	const events = transcriptEvents(eventsOf(history.data), tail)
	const newestSeq = () =>
		Math.max(
			newestSeqOf(queryClient.getQueryData(transcript.queryKey)),
			queryClient.getQueryData(live.queryKey)?.at(-1)?.seq ?? 0,
			batch.newestSeq(),
		)
	const intake = (incoming: ReadonlyArray<JsonSessionEvent>) => {
		batch.add(incoming)
		if (incoming.some(changesSnapshot) && refresh.current === undefined) {
			refresh.current = setTimeout(() => {
				refresh.current = undefined
				onTransition()
			}, REFRESH_MS)
		}
	}
	const readNewer = async () => {
		await readAfter(session.id, newestSeq(), intake, lifetime.current?.signal)
		batch.flush()
	}
	const report = (error_: unknown) => {
		if (!isSignedOut(error_) && !lifetime.current?.signal.aborted) {
			setError(errorMessage(error_))
		}
	}
	const catchUp = (): void => {
		readNewer().catch(report)
	}
	useMountEffect(() => {
		const controller = new AbortController()
		lifetime.current = controller
		const stop = () => {
			controller.abort()
			clearTimeout(refresh.current)
			refresh.current = undefined
			batch.dispose()
		}
		if (isFinal(events)) {
			return stop
		}
		let source: EventSource | undefined
		let slowReconnect: ReturnType<typeof setTimeout> | undefined
		const settle = () => {
			clearTimeout(slowReconnect)
			slowReconnect = undefined
		}
		const receive = (message: MessageEvent<string>) => {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary: the API's own event JSON, typed by @checkfu/sdk
			const event = JSON.parse(message.data) as JsonSessionEvent
			intake([event])
			if (event.type === "session.archived") {
				settle()
				source?.close()
			}
		}
		const ended = async () => {
			const current = await queryClient.fetchQuery({ ...sessionQuery(session.id), staleTime: 0 })
			if (current.archived_at === null) {
				setError("Live updates stopped. Reload the page to try again.")
			} else {
				await readNewer()
			}
		}
		const listen = () => {
			const seen = queryClient.getQueryData(live.queryKey) ?? []
			if (controller.signal.aborted || isFinal(seen)) {
				return
			}
			const stream = new EventSource(checkfu.sessions.streamUrl(session.id, newestSeq()))
			source = stream
			for (const type of Object.keys(EVENT_TYPES)) {
				stream.addEventListener(type, receive)
			}
			stream.addEventListener("open", () => {
				settle()
				setError(undefined)
			})
			stream.addEventListener("error", () => {
				if (stream.readyState === EventSource.CLOSED) {
					settle()
					ended().catch(report)
				} else if (slowReconnect === undefined) {
					slowReconnect = setTimeout(
						() => setError("Live updates were interrupted. Reconnecting…"),
						QUIET_RECONNECT_MS,
					)
				}
			})
		}
		readNewer().then(listen, (error_: unknown) => {
			report(error_)
			listen()
		})
		return () => {
			settle()
			source?.close()
			stop()
		}
	})
	return {
		events,
		...progressOf(events, session),
		final: isFinal(events),
		error,
		catchUp,
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
