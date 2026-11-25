import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query"
import type { InfiniteData } from "@tanstack/react-query"
import type { JsonSessionEvent } from "@checkfu/sdk/client"
import { ApiError, checkfu } from "./api.ts"
import type { EventPage } from "./api.ts"

export const agentsPage = (after?: string) =>
	queryOptions({
		queryKey: ["agents", "page", after ?? null],
		queryFn: ({ signal }) => checkfu.agents.list(after, signal),
	})

export const agentQuery = (id: string) =>
	queryOptions({
		queryKey: ["agents", "one", id],
		queryFn: ({ signal }) => checkfu.agents.retrieve(id, signal),
	})

export const agentChoices = infiniteQueryOptions({
	queryKey: ["agents", "choices"],
	queryFn: ({ pageParam, signal }) => checkfu.agents.list(pageParam, signal),
	initialPageParam: undefined as string | undefined,
	getNextPageParam: (page) => page.next_cursor ?? undefined,
})

export const environmentsPage = (after?: string) =>
	queryOptions({
		queryKey: ["environments", "page", after ?? null],
		queryFn: ({ signal }) => checkfu.environments.list(after, signal),
	})

export const environmentQuery = (id: string) =>
	queryOptions({
		queryKey: ["environments", "one", id],
		queryFn: ({ signal }) => checkfu.environments.retrieve(id, signal),
	})

export const environmentChoices = infiniteQueryOptions({
	queryKey: ["environments", "choices"],
	queryFn: ({ pageParam, signal }) => checkfu.environments.list(pageParam, signal),
	initialPageParam: undefined as string | undefined,
	getNextPageParam: (page) => page.next_cursor ?? undefined,
})

export const sessionsPage = (after?: string) =>
	queryOptions({
		queryKey: ["sessions", "page", after ?? null],
		queryFn: ({ signal }) => checkfu.sessions.list(after, signal),
	})

export const sessionQuery = (id: string) =>
	queryOptions({
		queryKey: ["sessions", "one", id],
		queryFn: ({ signal }) => checkfu.sessions.retrieve(id, signal),
	})

export const transcriptQuery = (id: string) =>
	infiniteQueryOptions({
		queryKey: ["transcripts", id],
		queryFn: ({ pageParam, signal }) => checkfu.sessions.events(id, pageParam, signal),
		initialPageParam: undefined as number | undefined,
		getNextPageParam: (page) => (page.has_more ? (page.next_cursor ?? undefined) : undefined),
		staleTime: Number.POSITIVE_INFINITY,
	})

export type Transcript = InfiniteData<EventPage, unknown>

export const eventsOf = (transcript: Transcript): ReadonlyArray<JsonSessionEvent> =>
	transcript.pages.toReversed().flatMap((page) => page.data.toReversed())

export const isFinal = (events: ReadonlyArray<JsonSessionEvent>): boolean =>
	events.some((event) => event.type === "session.archived")

export const present = <T>(query: { readonly data: T; readonly error: unknown }): T => {
	if (query.error instanceof ApiError && query.error.status === 404) {
		throw query.error
	}
	return query.data
}
