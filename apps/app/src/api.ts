import { CheckfuFetchError, createFetchClient, operationUrl } from "@checkfu/sdk/fetch"
import type { FetchInput, FetchResult, JsonOperationId } from "@checkfu/sdk/fetch"
import type {
	CreateAgentBody,
	CreateArtifactLinkBody,
	CreateAutomationBody,
	CreateEnvironmentBody,
	CreateMemoryBody,
	CreateMemoryStoreBody,
	SendSessionEventsBody,
	UpdateAgentBody,
	UpdateAutomationBody,
	UpdateEnvironmentBody,
	UpdateMemoryBody,
} from "@checkfu/sdk/Api"
import { changesOf, conflictsOf, draftOf, showsChanges } from "./automation-draft.ts"
import type { AutomationDraft } from "./automation-draft.ts"
import type {
	JsonAgent,
	JsonArtifact,
	JsonAutomation,
	JsonEnvironment,
	JsonMemory,
	JsonMemoryStore,
	JsonSession,
} from "@checkfu/sdk/client"

export { CheckfuFetchError as ApiError }

export type RunPage = FetchResult<"automations.runs.list">
export type JsonAutomationRun = RunPage["data"][number]
export type EventPage = FetchResult<"sessions.events.list">
export type JsonArtifactLink = FetchResult<"artifacts.versions.link">

interface Pending {
	readonly id: string
	readonly pending: true
}

const request = createFetchClient()

const isPending = <T>(value: T | Pending): value is Pending =>
	typeof value === "object" && value !== null && "pending" in value && value.pending === true

const pause = () =>
	new Promise((resolve) => {
		setTimeout(resolve, 250)
	})

const settled = async <T>(
	retrieve: (id: string) => Promise<T>,
	result: NoInfer<T> | Pending,
	done: (resource: T) => boolean = () => true,
): Promise<T> => {
	if (!isPending(result)) {
		return result
	}
	for (let attempt = 0; ; attempt++) {
		try {
			const resource = await retrieve(result.id)
			if (done(resource)) {
				return resource
			}
			if (attempt >= 40) {
				throw new Error("The change was accepted but is not visible yet. Reload in a moment.")
			}
			await pause()
		} catch (error) {
			if (
				attempt >= 40 ||
				!(error instanceof CheckfuFetchError) ||
				![404, 503].includes(error.status)
			) {
				throw error
			}
			await pause()
		}
	}
}

const versionOf = (value: unknown): number =>
	typeof value === "object" &&
	value !== null &&
	"version" in value &&
	typeof value.version === "number"
		? value.version
		: 0

const requireAutomationRevision = (revision: number): number => {
	if (!Number.isSafeInteger(revision) || revision < 1) {
		throw new Error(
			"The API did not return a usable automation revision. Your edits are still here.",
		)
	}
	return revision
}

const isArchived = (value: unknown): boolean =>
	typeof value === "object" &&
	value !== null &&
	"archived_at" in value &&
	value.archived_at !== null

const isStored = (credential: FetchResult<"vaults.credentials.retrieve">): boolean =>
	credential.custody !== "storing"

export const newIdempotencyKey = (): string => crypto.randomUUID()

const newestFirst = (page: string | undefined) => ({
	limit: 100,
	order: "desc" as const,
	...(page === undefined ? {} : { page }),
})

const retrieveAgent = (
	agent_id: string,
	options?: { readonly version?: number | undefined; readonly signal?: AbortSignal },
): Promise<JsonAgent> =>
	request("agents.retrieve", {
		path: { agent_id },
		...(options?.version === undefined ? {} : { query: { version: options.version } }),
		...withSignal(options?.signal),
	})
const retrieveEnvironment = (
	environment_id: string,
	signal?: AbortSignal,
): Promise<JsonEnvironment> =>
	request("environments.retrieve", {
		path: { environment_id },
		...(signal === undefined ? {} : { signal }),
	})
const retrieveAutomation = (automation_id: string, signal?: AbortSignal): Promise<JsonAutomation> =>
	request("automations.retrieve", {
		path: { automation_id },
		...(signal === undefined ? {} : { signal }),
	})
const retrieveSession = (session_id: string, signal?: AbortSignal): Promise<JsonSession> =>
	request("sessions.retrieve", {
		path: { session_id },
		...(signal === undefined ? {} : { signal }),
	})
const withSignal = (signal: AbortSignal | undefined) => (signal === undefined ? {} : { signal })

export type JsonMemoryEntry = FetchResult<"memoryStores.memories.list">["data"][number]

const retrieveMemoryStore = (
	memory_store_id: string,
	signal?: AbortSignal,
): Promise<JsonMemoryStore> =>
	request("memoryStores.retrieve", { path: { memory_store_id }, ...withSignal(signal) })
type BodyOf<Op extends JsonOperationId> =
	FetchInput<Op> extends { readonly body: infer Body } ? Body : never

const retrieveVault = (vault_id: string, signal?: AbortSignal) =>
	request("vaults.retrieve", { path: { vault_id }, ...withSignal(signal) })
const retrieveCredential = (vault_id: string, credential_id: string, signal?: AbortSignal) =>
	request("vaults.credentials.retrieve", {
		path: { vault_id, credential_id },
		...withSignal(signal),
	})
const credentialOf = (vault_id: string) => (credential_id: string) =>
	retrieveCredential(vault_id, credential_id)

const vaults = {
	list: (token?: string, signal?: AbortSignal, includeArchived = false) =>
		request("vaults.list", {
			query: { ...newestFirst(token), ...(includeArchived ? { include_archived: true } : {}) },
			...withSignal(signal),
		}),
	retrieve: retrieveVault,
	create: async (body: BodyOf<"vaults.create">, idempotencyKey: string) =>
		settled(retrieveVault, await request("vaults.create", { body, idempotencyKey })),
	archive: async (vault_id: string) =>
		settled(retrieveVault, await request("vaults.archive", { path: { vault_id } }), isArchived),
	delete: (vault_id: string) => request("vaults.delete", { path: { vault_id } }),
	credentials: {
		list: (vault_id: string, includeArchived: boolean, token?: string, signal?: AbortSignal) =>
			request("vaults.credentials.list", {
				path: { vault_id },
				query: { ...newestFirst(token), ...(includeArchived ? { include_archived: true } : {}) },
				...withSignal(signal),
			}),
		retrieve: retrieveCredential,
		create: async (
			vault_id: string,
			body: BodyOf<"vaults.credentials.create">,
			idempotencyKey: string,
		) =>
			settled(
				credentialOf(vault_id),
				await request("vaults.credentials.create", { path: { vault_id }, body, idempotencyKey }),
				isStored,
			),
		update: async (
			vault_id: string,
			credential_id: string,
			body: BodyOf<"vaults.credentials.update">,
			since: { readonly updated_at: string },
		) =>
			settled(
				credentialOf(vault_id),
				await request("vaults.credentials.update", { path: { vault_id, credential_id }, body }),
				(credential) =>
					Date.parse(credential.updated_at) > Date.parse(since.updated_at) &&
					!(typeof body === "object" && body !== null && "auth" in body && !isStored(credential)),
			),
		archive: async (vault_id: string, credential_id: string) =>
			settled(
				credentialOf(vault_id),
				await request("vaults.credentials.archive", { path: { vault_id, credential_id } }),
				isArchived,
			),
		delete: (vault_id: string, credential_id: string) =>
			request("vaults.credentials.delete", { path: { vault_id, credential_id } }),
	},
}

export const checkfu = {
	agents: {
		list: (page?: string, signal?: AbortSignal) =>
			request("agents.list", { query: newestFirst(page), ...withSignal(signal) }),
		retrieve: retrieveAgent,
		create: async (body: CreateAgentBody, idempotencyKey: string) =>
			settled(retrieveAgent, await request("agents.create", { body, idempotencyKey })),
		update: async (agent_id: string, body: UpdateAgentBody & { readonly version: number }) =>
			settled(
				retrieveAgent,
				await request("agents.update", { path: { agent_id }, body }),
				(saved) => versionOf(saved) > body.version,
			),
		archive: async (agent_id: string) =>
			settled(retrieveAgent, await request("agents.archive", { path: { agent_id } }), isArchived),
	},
	environments: {
		list: (page?: string, signal?: AbortSignal) =>
			request("environments.list", { query: newestFirst(page), ...withSignal(signal) }),
		retrieve: retrieveEnvironment,
		create: async (body: CreateEnvironmentBody, idempotencyKey: string) =>
			settled(retrieveEnvironment, await request("environments.create", { body, idempotencyKey })),
		update: async (environment_id: string, body: UpdateEnvironmentBody) =>
			settled(
				retrieveEnvironment,
				await request("environments.update", { path: { environment_id }, body }),
				(saved) => saved.version > body.version,
			),
		archive: async (environment_id: string) =>
			settled(
				retrieveEnvironment,
				await request("environments.archive", { path: { environment_id } }),
				isArchived,
			),
	},
	automations: {
		list: (page?: string, signal?: AbortSignal) =>
			request("automations.list", { query: newestFirst(page), ...withSignal(signal) }),
		retrieve: retrieveAutomation,
		create: async (body: CreateAutomationBody, idempotencyKey: string) =>
			settled(retrieveAutomation, await request("automations.create", { body, idempotencyKey })),
		update: async (
			automation_id: string,
			body: UpdateAutomationBody & { readonly revision: number },
		) => {
			requireAutomationRevision(body.revision)
			return settled(
				retrieveAutomation,
				await request("automations.update", { path: { automation_id }, body }),
				(saved) => showsChanges(saved, body),
			)
		},
		pause: async (automation_id: string) =>
			settled(
				retrieveAutomation,
				await request("automations.pause", { path: { automation_id } }),
				(automation) => automation.status !== "active",
			),
		unpause: async (automation_id: string) =>
			settled(
				retrieveAutomation,
				await request("automations.unpause", { path: { automation_id } }),
				(automation) => automation.status !== "paused",
			),
		archive: async (automation_id: string) =>
			settled(
				retrieveAutomation,
				await request("automations.archive", { path: { automation_id } }),
				isArchived,
			),
		run: async (
			automation_id: string,
			idempotencyKey: string,
		): Promise<{ readonly run: number; readonly listed: JsonAutomationRun | null }> => {
			const queued = await request("automations.run", { path: { automation_id }, idempotencyKey })
			const listed = await settled(
				(run) =>
					request("automations.runs.retrieve", { path: { automation_id, run: Number(run) } }),
				{ id: String(queued.run), pending: true },
			).catch(() => null)
			return { run: queued.run, listed }
		},
		runs: (automation_id: string, page?: string, signal?: AbortSignal) =>
			request("automations.runs.list", {
				path: { automation_id },
				query: { order: "desc", limit: 20, ...(page === undefined ? {} : { page }) },
				...withSignal(signal),
			}),
	},
	vaults,
	sessions: {
		list: (page?: string, signal?: AbortSignal) =>
			request("sessions.list", { query: newestFirst(page), ...withSignal(signal) }),
		retrieve: retrieveSession,
		create: async (body: BodyOf<"sessions.create">, idempotencyKey: string) =>
			settled(retrieveSession, await request("sessions.create", { body, idempotencyKey })),
		archive: async (session_id: string) =>
			settled(
				retrieveSession,
				await request("sessions.archive", { path: { session_id } }),
				isArchived,
			),
		send: (session_id: string, body: SendSessionEventsBody, idempotencyKey: string) =>
			request("sessions.events.send", { path: { session_id }, body, idempotencyKey }),
		events: (session_id: string, page?: string, signal?: AbortSignal) =>
			request("sessions.events.list", {
				path: { session_id },
				query: { order: "desc", limit: 100, ...(page === undefined ? {} : { page }) },
				...withSignal(signal),
			}),
		streamUrl: (session_id: string, after: number) =>
			operationUrl("sessions.events.stream", {
				path: { session_id },
				query: { after, "event_deltas[]": ["agent.message"] },
			}),
		rotateToken: (session_id: string, resource_id: string, token: string) =>
			request("sessions.resources.update", {
				path: { session_id, resource_id },
				body: { authorization_token: token },
			}),
	},
	memoryStores: {
		list: (page?: string, signal?: AbortSignal) =>
			request("memoryStores.list", {
				query: { order: "desc", limit: 100, ...(page === undefined ? {} : { page }) },
				...withSignal(signal),
			}),
		retrieve: retrieveMemoryStore,
		create: async (body: typeof CreateMemoryStoreBody.Type, idempotencyKey: string) =>
			settled(retrieveMemoryStore, await request("memoryStores.create", { body, idempotencyKey })),
		archive: async (memory_store_id: string) =>
			settled(
				retrieveMemoryStore,
				await request("memoryStores.archive", { path: { memory_store_id } }),
				isArchived,
			),
		memories: async (memory_store_id: string, signal?: AbortSignal) => {
			const data: Array<JsonMemoryEntry> = []
			let page: string | null = null
			do {
				const result: FetchResult<"memoryStores.memories.list"> = await request(
					"memoryStores.memories.list",
					{
						path: { memory_store_id },
						query: { limit: 100, ...(page === null ? {} : { page }) },
						...withSignal(signal),
					},
				)
				data.push(...result.data)
				page = result.next_page
			} while (page !== null)
			return { data }
		},
		memory: (memory_store_id: string, memory_id: string, signal?: AbortSignal) =>
			request("memoryStores.memories.retrieve", {
				path: { memory_store_id, memory_id },
				...withSignal(signal),
			}),
		createMemory: async (memory_store_id: string, body: typeof CreateMemoryBody.Type) =>
			settled(
				(memory_id) =>
					request("memoryStores.memories.retrieve", { path: { memory_store_id, memory_id } }),
				await request("memoryStores.memories.create", { path: { memory_store_id }, body }),
			),
		updateMemory: async (memory_store_id: string, memory: JsonMemory, content: string) => {
			const body: typeof UpdateMemoryBody.Type = {
				content,
				precondition: { type: "content_sha256", content_sha256: memory.content_sha256 },
			}
			return settled(
				(memory_id) =>
					request("memoryStores.memories.retrieve", { path: { memory_store_id, memory_id } }),
				await request("memoryStores.memories.update", {
					path: { memory_store_id, memory_id: memory.id },
					body,
				}),
				(saved) => saved.version > memory.version,
			)
		},
		deleteMemory: (memory_store_id: string, memory: JsonMemory) =>
			request("memoryStores.memories.delete", {
				path: { memory_store_id, memory_id: memory.id },
				query: { expected_content_sha256: memory.content_sha256 },
			}),
	},
	artifacts: {
		list: (page?: string, signal?: AbortSignal) =>
			request("artifacts.list", { query: newestFirst(page), ...withSignal(signal) }),
		retrieve: (artifact_id: string, signal?: AbortSignal): Promise<JsonArtifact> =>
			request("artifacts.retrieve", { path: { artifact_id }, ...withSignal(signal) }),
		version: (artifact_id: string, version: number, signal?: AbortSignal) =>
			request("artifacts.versions.retrieve", {
				path: { artifact_id, version },
				...withSignal(signal),
			}),
		file: (artifact_id: string, version: number, path: string, signal?: AbortSignal) =>
			request("artifacts.versions.file", {
				path: { artifact_id, version },
				query: { file: path },
				...withSignal(signal),
			}),
		link: (artifact_id: string, version: number, body: CreateArtifactLinkBody) =>
			request("artifacts.versions.link", { path: { artifact_id, version }, body }),
		publish: (
			artifact_id: string,
			body: NonNullable<FetchInput<"artifacts.publish">["body"]>,
			idempotencyKey: string,
		) => request("artifacts.publish", { path: { artifact_id }, body, idempotencyKey }),
		unpublish: (artifact_id: string, address: string, idempotencyKey: string) =>
			request("artifacts.unpublish", {
				path: { artifact_id },
				query: { if_current: address },
				idempotencyKey,
			}),
		delete: (artifact_id: string) => request("artifacts.delete", { path: { artifact_id } }),
	},
}

export interface AutomationEditReview {
	readonly latest: JsonAutomation
	readonly conflicts: ReadonlyArray<ReturnType<typeof conflictsOf>[number]>
}

const refreshAutomationAfterConflict = async (
	current: JsonAutomation,
	error: CheckfuFetchError,
) => {
	for (let attempt = 0; attempt <= 2; attempt++) {
		const latest = await retrieveAutomation(current.id)
		if (latest.status === "archived") {
			break
		}
		if (requireAutomationRevision(latest.revision) > current.revision) {
			return latest
		}
		if (attempt < 2) {
			await pause()
		}
	}
	throw error
}

export const saveAutomationEdit = async (
	base: JsonAutomation,
	draft: AutomationDraft,
): Promise<AutomationEditReview | undefined> => {
	const changes = changesOf(draftOf(base), draft)
	if (Object.keys(changes).length === 0) {
		return undefined
	}
	let current = base
	for (let attempt = 0; ; attempt++) {
		try {
			await checkfu.automations.update(base.id, { ...changes, revision: current.revision })
			return undefined
		} catch (error) {
			if (!(error instanceof CheckfuFetchError) || error.status !== 409) {
				throw error
			}
			const latest = await refreshAutomationAfterConflict(current, error)
			const conflicts = conflictsOf(base, latest, changes)
			if (conflicts.length > 0 || attempt === 1) {
				return { latest, conflicts }
			}
			current = latest
		}
	}
}

export const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : "Something went wrong."

export const isSignedOut = (error: unknown): boolean =>
	error instanceof CheckfuFetchError && error.status === 401

export const deploymentApiUrl = async (): Promise<string> => {
	const response = await fetch("/auth/deployment")
	if (!response.ok) {
		throw new Error("Could not get this deployment’s API URL for the export.")
	}
	const body: unknown = await response.json()
	if (
		typeof body !== "object" ||
		body === null ||
		!("api_url" in body) ||
		typeof body.api_url !== "string"
	) {
		throw new Error("This deployment did not return its API URL.")
	}
	return body.api_url
}

export const signedIn = async (): Promise<boolean> => {
	const response = await fetch("/auth/session")
	if (response.status !== 401 && !response.ok) {
		throw new Error(`Could not reach the dashboard (${response.status}).`)
	}
	return response.ok
}

export const signIn = async (key: string): Promise<"ok" | "rejected" | "failed"> => {
	const response = await fetch("/auth/sign-in", {
		method: "POST",
		body: new URLSearchParams({ key }),
	})
	return response.ok ? "ok" : response.status === 401 ? "rejected" : "failed"
}

export const signOut = async (): Promise<void> => {
	const response = await fetch("/auth/sign-out", { method: "POST" })
	if (!response.ok) {
		throw new Error(`Could not sign out (${response.status}). Try again.`)
	}
}
