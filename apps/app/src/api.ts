import { CheckfuFetchError, createFetchClient, operationUrl } from "@checkfu/sdk/fetch"
import type { FetchResult } from "@checkfu/sdk/fetch"
import type {
	ERROR_CODES,
	CreateAgentBody,
	CreateArtifactLinkBody,
	CreateAutomationBody,
	CreateEnvironmentBody,
	CreateSessionBody,
	PublishArtifactBody,
	SendSessionEventsBody,
	UpdateAgentBody,
	UpdateAutomationBody,
} from "@checkfu/sdk/Api"
import { showsChanges } from "./automation-draft.ts"
import type {
	JsonAgent,
	JsonArtifact,
	JsonAutomation,
	JsonEnvironment,
	JsonSession,
} from "@checkfu/sdk/client"

export { CheckfuFetchError as ApiError }

export const SESSION_AWAITING_ACTION: (typeof ERROR_CODES)["sessionAwaitingAction"] =
	"session_awaiting_action"

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

const isArchived = (value: unknown): boolean =>
	typeof value === "object" &&
	value !== null &&
	"archived_at" in value &&
	value.archived_at !== null

export const newIdempotencyKey = (): string => crypto.randomUUID()

const newestFirst = (page: string | undefined) => ({
	limit: 100,
	order: "desc" as const,
	...(page === undefined ? {} : { page }),
})

const retrieveAgent = (agent_id: string, signal?: AbortSignal): Promise<JsonAgent> =>
	request("agents.retrieve", { path: { agent_id }, ...(signal === undefined ? {} : { signal }) })
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

export const checkfu = {
	agents: {
		list: (after?: string, signal?: AbortSignal) =>
			request("agents.list", { query: newestFirst(after), ...withSignal(signal) }),
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
		list: (after?: string, signal?: AbortSignal) =>
			request("environments.list", { query: newestFirst(after), ...withSignal(signal) }),
		retrieve: retrieveEnvironment,
		create: async (body: CreateEnvironmentBody, idempotencyKey: string) =>
			settled(retrieveEnvironment, await request("environments.create", { body, idempotencyKey })),
		archive: async (environment_id: string) =>
			settled(
				retrieveEnvironment,
				await request("environments.archive", { path: { environment_id } }),
				isArchived,
			),
	},
	automations: {
		list: (after?: string, signal?: AbortSignal) =>
			request("automations.list", { query: newestFirst(after), ...withSignal(signal) }),
		retrieve: retrieveAutomation,
		create: async (body: CreateAutomationBody, idempotencyKey: string) =>
			settled(retrieveAutomation, await request("automations.create", { body, idempotencyKey })),
		update: async (automation_id: string, body: UpdateAutomationBody) =>
			settled(
				retrieveAutomation,
				await request("automations.update", { path: { automation_id }, body }),
				(saved) => showsChanges(saved, body),
			),
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
		): Promise<{ readonly run: number; readonly listed: JsonAutomationRun | null }> => {
			const queued = await request("automations.run", { path: { automation_id } })
			const listed = await settled(
				(run) =>
					request("automations.runs.retrieve", { path: { automation_id, run: Number(run) } }),
				{ id: String(queued.run), pending: true },
			).catch(() => null)
			return { run: queued.run, listed }
		},
		runs: (automation_id: string, before?: string, signal?: AbortSignal) =>
			request("automations.runs.list", {
				path: { automation_id },
				query: { order: "desc", limit: 20, ...(before === undefined ? {} : { page: before }) },
				...withSignal(signal),
			}),
	},
	sessions: {
		list: (after?: string, signal?: AbortSignal) =>
			request("sessions.list", { query: newestFirst(after), ...withSignal(signal) }),
		retrieve: retrieveSession,
		create: async (body: CreateSessionBody, idempotencyKey: string) =>
			settled(retrieveSession, await request("sessions.create", { body, idempotencyKey })),
		archive: async (session_id: string) =>
			settled(
				retrieveSession,
				await request("sessions.archive", { path: { session_id } }),
				isArchived,
			),
		send: (session_id: string, body: SendSessionEventsBody, idempotencyKey: string) =>
			request("sessions.events.send", { path: { session_id }, body, idempotencyKey }),
		events: (session_id: string, before?: string, signal?: AbortSignal) =>
			request("sessions.events.list", {
				path: { session_id },
				query: { order: "desc", limit: 100, ...(before === undefined ? {} : { page: before }) },
				...withSignal(signal),
			}),
		streamUrl: (session_id: string, after: number) =>
			operationUrl("sessions.events.stream", {
				path: { session_id },
				query: { after, "event_deltas[]": ["agent.message"] },
			}),
	},
	artifacts: {
		list: (after?: string, signal?: AbortSignal) =>
			request("artifacts.list", { query: newestFirst(after), ...withSignal(signal) }),
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
		publish: (artifact_id: string, body: PublishArtifactBody, idempotencyKey: string) =>
			request("artifacts.publish", { path: { artifact_id }, body, idempotencyKey }),
		unpublish: (artifact_id: string, idempotencyKey: string) =>
			request("artifacts.unpublish", { path: { artifact_id }, idempotencyKey }),
		delete: (artifact_id: string) => request("artifacts.delete", { path: { artifact_id } }),
	},
}

export const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : "Something went wrong."

export const isSignedOut = (error: unknown): boolean =>
	error instanceof CheckfuFetchError && error.status === 401

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
