import type { JsonSession, JsonSessionEvent } from "@checkfu/sdk/client"
import type { SessionEventType } from "@checkfu/sdk/Schemas"
import { useMountEffect } from "@checkfu/ui/use-mount-effect"
import { useState, useSyncExternalStore } from "react"
import { useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query"
import { checkfu, errorMessage, isSignedOut } from "../api.ts"
import { EventTail, progressOf, transcriptEvents } from "../event-tail.ts"
import { eventsOf, isFinal, sessionQuery, transcriptQuery } from "../queries.ts"

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

const readAfter = async (sessionId: string, from: number, tail: EventTail): Promise<void> => {
	let after = from
	let more = true
	while (more) {
		const page = await checkfu.sessions.eventsAfter(sessionId, after)
		tail.add(page.data)
		after = page.data.at(-1)?.seq ?? after
		more = page.has_more
	}
	tail.flush()
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
	const history = useSuspenseInfiniteQuery(transcript)
	const [tail] = useState(() => new EventTail())
	const live = useSyncExternalStore(tail.subscribe, tail.snapshot)
	const [error, setError] = useState<string>()
	const events = transcriptEvents(eventsOf(history.data), live)
	const newestSeq = () => Math.max(events.at(-1)?.seq ?? 0, tail.newestSeq())
	const readNewer = () => readAfter(session.id, newestSeq(), tail)
	const catchUp = (): void => {
		readNewer().catch((error_: unknown) => {
			if (!isSignedOut(error_)) {
				setError(errorMessage(error_))
			}
		})
	}
	useMountEffect(() => {
		if (isFinal(events)) {
			return () => tail.dispose()
		}
		let disposed = false
		let source: EventSource | undefined
		let slowReconnect: ReturnType<typeof setTimeout> | undefined
		let refresh: ReturnType<typeof setTimeout> | undefined
		const settle = () => {
			clearTimeout(slowReconnect)
			slowReconnect = undefined
		}
		const transitioned = () => {
			if (refresh === undefined) {
				refresh = setTimeout(() => {
					refresh = undefined
					onTransition()
				}, REFRESH_MS)
			}
		}
		const receive = (message: MessageEvent<string>) => {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary: the API's own event JSON, typed by @checkfu/sdk
			const event = JSON.parse(message.data) as JsonSessionEvent
			tail.add([event])
			if (event.type === "session.status_idle" || event.type === "session.archived") {
				transitioned()
			}
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
			if (disposed || isFinal(tail.snapshot())) {
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
					ended().catch((error_: unknown) => setError(errorMessage(error_)))
				} else if (slowReconnect === undefined) {
					slowReconnect = setTimeout(
						() => setError("Live updates were interrupted. Reconnecting…"),
						QUIET_RECONNECT_MS,
					)
				}
			})
		}
		readNewer().then(listen, (error_: unknown) => {
			if (!isSignedOut(error_)) {
				setError(errorMessage(error_))
			}
			listen()
		})
		return () => {
			disposed = true
			settle()
			clearTimeout(refresh)
			source?.close()
			tail.dispose()
		}
	})
	return {
		events,
		...progressOf(events, session),
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
