import { infiniteQueryOptions, queryOptions, skipToken } from "@tanstack/react-query"
import type { InfiniteData } from "@tanstack/react-query"
import type { JsonSessionEvent, JsonVault, JsonVaultCredential } from "@checkfu/sdk/client"
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

export const automationsPage = (after?: string) =>
	queryOptions({
		queryKey: ["automations", "page", after ?? null],
		queryFn: ({ signal }) => checkfu.automations.list(after, signal),
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
		initialPageParam: undefined as number | undefined,
		getNextPageParam: (page) => (page.has_more ? (page.next_cursor ?? undefined) : undefined),
	})

export const vaultsPage = (after?: string) =>
	queryOptions({
		queryKey: ["vaults", "page", after ?? null],
		queryFn: ({ signal }) => checkfu.vaults.list(after, signal, true),
	})

export const ERASING_POLL_MS = 2000

export const vaultErasing = (vault: JsonVault): boolean =>
	vault.custody.erasing > 0 ||
	(vault.archived_at !== null && vault.custody.held + vault.custody.storing > 0)

const credentialErasing = (credential: JsonVaultCredential, vaultEnded: boolean): boolean =>
	credential.custody === "erasing" ||
	(vaultEnded && (credential.custody === "held" || credential.custody === "storing"))

export const vaultQuery = (id: string) =>
	queryOptions({
		queryKey: ["vaults", "one", id],
		queryFn: ({ signal }) => checkfu.vaults.retrieve(id, signal),
		refetchInterval: (query) =>
			query.state.data !== undefined && vaultErasing(query.state.data) ? ERASING_POLL_MS : false,
	})

export const credentialsQuery = (vaultId: string, archived = false) =>
	queryOptions({
		queryKey: ["vaults", "credentials", vaultId, archived ? "all" : "active"],
		queryFn: ({ signal }) => checkfu.vaults.credentials.list(vaultId, archived, undefined, signal),
		refetchInterval: (query) =>
			query.state.data?.data.some((credential) => credential.custody === "erasing") === true
				? ERASING_POLL_MS
				: false,
	})

export const credentialQuery = (vaultId: string, id: string) =>
	queryOptions({
		queryKey: ["vaults", "credentials", vaultId, "one", id],
		queryFn: ({ signal }) => checkfu.vaults.credentials.retrieve(vaultId, id, signal),
	})

export const credentialPages = (vaultId: string, vaultEnded = false) =>
	infiniteQueryOptions({
		queryKey: ["vaults", "credentials", vaultId, "pages"],
		queryFn: ({ pageParam, signal }) =>
			checkfu.vaults.credentials.list(vaultId, true, pageParam, signal),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.next_cursor ?? undefined,
		refetchInterval: (query) =>
			query.state.data?.pages.some((page) =>
				page.data.some((credential) => credentialErasing(credential, vaultEnded)),
			) === true
				? ERASING_POLL_MS
				: false,
	})

export const vaultChoices = infiniteQueryOptions({
	queryKey: ["vaults", "choices"],
	queryFn: ({ pageParam, signal }) => checkfu.vaults.list(pageParam, signal),
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

export const artifactsPage = (after?: string) =>
	queryOptions({
		queryKey: ["artifacts", "page", after ?? null],
		queryFn: ({ signal }) => checkfu.artifacts.list(after, signal),
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
		initialPageParam: undefined as number | undefined,
		getNextPageParam: (page) => (page.has_more ? (page.next_cursor ?? undefined) : undefined),
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

export type Lookup<T> =
	| { readonly state: "pending" }
	| { readonly state: "active"; readonly found: T }
	| { readonly state: "gone" }
	| { readonly state: "failed" }

export const lookup = <T>(
	query: { readonly data: T | undefined; readonly error: unknown },
	active: (found: T) => boolean = () => true,
): Lookup<T> => {
	if (query.error instanceof ApiError && query.error.status === 404) {
		return { state: "gone" }
	}
	if (query.error !== null && query.error !== undefined) {
		return { state: "failed" }
	}
	if (query.data !== undefined) {
		return active(query.data) ? { state: "active", found: query.data } : { state: "gone" }
	}
	return { state: "pending" }
}

export const present = <T>(query: { readonly data: T; readonly error: unknown }): T => {
	if (lookup(query).state === "gone") {
		throw query.error
	}
	return query.data
}
