import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query"
import type { JsonSessionEvent } from "@checkfu/sdk/client"
import { checkfu } from "./api.ts"

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

export const sessionHistory = (id: string) =>
	infiniteQueryOptions({
		queryKey: ["sessions", "history", id],
		queryFn: ({ pageParam }) => checkfu.sessions.events(id, pageParam),
		initialPageParam: undefined as number | undefined,
		getNextPageParam: (page) => (page.has_more ? (page.next_cursor ?? undefined) : undefined),
		staleTime: Number.POSITIVE_INFINITY,
	})

export const sessionLive = (id: string) =>
	queryOptions({
		queryKey: ["sessions", "live", id],
		queryFn: (): ReadonlyArray<JsonSessionEvent> => [],
		staleTime: Number.POSITIVE_INFINITY,
	})
