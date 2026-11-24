import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query"
import type { InfiniteData } from "@tanstack/react-query"
import type { JsonSessionEvent } from "@checkfu/sdk/client"
import { checkfu } from "./api.ts"
import type { EventPage } from "./api.ts"

export const agentsPage = (after?: string) =>
	queryOptions({
		queryKey: ["agents", "page", after ?? null],
		queryFn: () => checkfu.agents.list(after),
	})

export const agentQuery = (id: string) =>
	queryOptions({ queryKey: ["agents", "one", id], queryFn: () => checkfu.agents.retrieve(id) })

export const agentChoices = infiniteQueryOptions({
	queryKey: ["agents", "choices"],
	queryFn: ({ pageParam }) => checkfu.agents.list(pageParam),
	initialPageParam: undefined as string | undefined,
	getNextPageParam: (page) => page.next_cursor ?? undefined,
})

export const environmentsPage = (after?: string) =>
	queryOptions({
		queryKey: ["environments", "page", after ?? null],
		queryFn: () => checkfu.environments.list(after),
	})

export const environmentQuery = (id: string) =>
	queryOptions({
		queryKey: ["environments", "one", id],
		queryFn: () => checkfu.environments.retrieve(id),
	})

export const environmentChoices = infiniteQueryOptions({
	queryKey: ["environments", "choices"],
	queryFn: ({ pageParam }) => checkfu.environments.list(pageParam),
	initialPageParam: undefined as string | undefined,
	getNextPageParam: (page) => page.next_cursor ?? undefined,
})

export const sessionsPage = (after?: string) =>
	queryOptions({
		queryKey: ["sessions", "page", after ?? null],
		queryFn: () => checkfu.sessions.list(after),
	})

export const sessionQuery = (id: string) =>
	queryOptions({ queryKey: ["sessions", "one", id], queryFn: () => checkfu.sessions.retrieve(id) })

export const transcriptQuery = (id: string) =>
	infiniteQueryOptions({
		queryKey: ["transcripts", id],
		queryFn: ({ pageParam }) => checkfu.sessions.events(id, pageParam),
		initialPageParam: undefined as number | undefined,
		getNextPageParam: (page) => (page.has_more ? (page.next_cursor ?? undefined) : undefined),
		staleTime: Number.POSITIVE_INFINITY,
	})

export type Transcript = InfiniteData<EventPage, unknown>

export const eventsOf = (transcript: Transcript): ReadonlyArray<JsonSessionEvent> =>
	transcript.pages.toReversed().flatMap((page) => page.data.toReversed())

export const withStreamed = (transcript: Transcript, event: JsonSessionEvent): Transcript => {
	const [newest, ...older] = transcript.pages
	if (newest === undefined || (newest.data[0]?.seq ?? 0) >= event.seq) {
		return transcript
	}
	return { ...transcript, pages: [{ ...newest, data: [event, ...newest.data] }, ...older] }
}

export const isFinal = (
	session: { readonly archived_at: string | null },
	events: ReadonlyArray<JsonSessionEvent>,
): boolean =>
	session.archived_at !== null || events.some((event) => event.type === "session.archived")
