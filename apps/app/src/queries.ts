import { infiniteQueryOptions, queryOptions, skipToken } from "@tanstack/react-query"
import type { InfiniteData } from "@tanstack/react-query"
import type { JsonSessionEvent } from "@checkfu/sdk/client"
import { ApiError, checkfu } from "./api.ts"
import type { EventPage } from "./api.ts"

export const agentsPage = (token?: string) =>
	queryOptions({
		queryKey: ["agents", "page", token ?? null],
		queryFn: ({ signal }) => checkfu.agents.list(token, signal),
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
	getNextPageParam: (page) => page.next_page ?? undefined,
})

export const environmentsPage = (token?: string) =>
	queryOptions({
		queryKey: ["environments", "page", token ?? null],
		queryFn: ({ signal }) => checkfu.environments.list(token, signal),
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
	getNextPageParam: (page) => page.next_page ?? undefined,
})

export const automationsPage = (token?: string) =>
	queryOptions({
		queryKey: ["automations", "page", token ?? null],
		queryFn: ({ signal }) => checkfu.automations.list(token, signal),
	})

export const automationQuery = (id: string) =>
	queryOptions({
		queryKey: ["automations", "one", id],
		queryFn: ({ signal }) => checkfu.automations.retrieve(id, signal),
	})

export const automationRunsQuery = (id: string) =>
	infiniteQueryOptions({
		queryKey: ["automations", "runs", id],
		queryFn: ({ pageParam, signal }) => checkfu.automations.runs(id, pageParam, signal),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.next_page ?? undefined,
	})

export const sessionsPage = (token?: string) =>
	queryOptions({
		queryKey: ["sessions", "page", token ?? null],
		queryFn: ({ signal }) => checkfu.sessions.list(token, signal),
	})

export const sessionQuery = (id: string) =>
	queryOptions({
		queryKey: ["sessions", "one", id],
		queryFn: ({ signal }) => checkfu.sessions.retrieve(id, signal),
	})

export const artifactsPage = (token?: string) =>
	queryOptions({
		queryKey: ["artifacts", "page", token ?? null],
		queryFn: ({ signal }) => checkfu.artifacts.list(token, signal),
	})

export const artifactQuery = (id: string) =>
	queryOptions({
		queryKey: ["artifacts", "one", id],
		queryFn: ({ signal }) => checkfu.artifacts.retrieve(id, signal),
	})

export const artifactVersionQuery = (id: string, version: number) =>
	queryOptions({
		queryKey: ["artifact-versions", id, version],
		queryFn: ({ signal }) => checkfu.artifacts.version(id, version, signal),
		staleTime: Number.POSITIVE_INFINITY,
	})

export const artifactFileQuery = (id: string, version: number, path: string) =>
	queryOptions({
		queryKey: ["artifact-files", id, version, path],
		queryFn: ({ signal }) => checkfu.artifacts.file(id, version, path, signal),
		staleTime: Number.POSITIVE_INFINITY,
	})

export const transcriptQuery = (id: string) =>
	infiniteQueryOptions({
		queryKey: ["transcripts", id],
		queryFn: ({ pageParam, signal }) => checkfu.sessions.events(id, pageParam, signal),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.next_page ?? undefined,
		staleTime: Number.POSITIVE_INFINITY,
	})

export type Transcript = InfiniteData<EventPage, unknown>

export const liveQuery = (id: string) =>
	queryOptions<ReadonlyArray<JsonSessionEvent>>({
		queryKey: ["live-events", id],
		queryFn: skipToken,
		staleTime: Number.POSITIVE_INFINITY,
		structuralSharing: false,
	})

export const newestSeqOf = (transcript: Transcript | undefined): number =>
	transcript?.pages[0]?.data[0]?.seq ?? 0

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
