import type {
	ArtifactFileContent,
	ArtifactLink,
	AutomationRun,
	AutomationRunQueued,
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
	IsoDateTimes,
	JsonAgent,
	JsonArtifact,
	JsonArtifactVersion,
	JsonAutomation,
	JsonEnvironment,
	JsonSession,
	JsonSessionEvent,
} from "@checkfu/sdk/client"

export type JsonAutomationRun = IsoDateTimes<AutomationRun>

export interface RunPage {
	readonly data: ReadonlyArray<JsonAutomationRun>
	readonly has_more: boolean
	readonly next_cursor: number | null
}

export class ApiError extends Error {
	readonly status: number

	constructor(status: number, message: string) {
		super(message)
		this.status = status
	}
}

interface Page<T> {
	readonly data: ReadonlyArray<T>
	readonly has_more: boolean
	readonly next_cursor: string | null
}

export interface EventPage {
	readonly data: ReadonlyArray<JsonSessionEvent>
	readonly has_more: boolean
	readonly next_cursor: number | null
}

interface Pending {
	readonly id: string
	readonly pending: true
}

const call = async <T>(
	method: "GET" | "POST" | "DELETE",
	path: string,
	body?: unknown,
	idempotencyKey?: string,
	signal?: AbortSignal,
): Promise<T> => {
	const headers = new Headers()
	if (body !== undefined) {
		headers.set("content-type", "application/json")
	}
	if (idempotencyKey !== undefined) {
		headers.set("idempotency-key", idempotencyKey)
	}
	const response = await fetch(path, {
		method,
		headers,
		...(signal === undefined ? {} : { signal }),
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	if (!response.ok) {
		const json: unknown = await response.json().catch(() => undefined)
		const message =
			typeof json === "object" &&
			json !== null &&
			"error" in json &&
			typeof json.error === "object" &&
			json.error !== null &&
			"message" in json.error &&
			typeof json.error.message === "string"
				? json.error.message
				: `Request failed with status ${response.status}.`
		throw new ApiError(response.status, message)
	}
	const text = await response.text()
	const json: unknown = text === "" ? undefined : JSON.parse(text)
	return json as T
}

const isPending = <T>(value: T | Pending): value is Pending =>
	typeof value === "object" && value !== null && "pending" in value && value.pending === true

const pause = () =>
	new Promise((resolve) => {
		setTimeout(resolve, 250)
	})

const settled = async <T>(
	collection: string,
	result: T | Pending,
	done: (resource: T) => boolean = () => true,
): Promise<T> => {
	if (!isPending(result)) {
		return result
	}
	for (let attempt = 0; ; attempt++) {
		try {
			const resource = await call<T>("GET", `${collection}/${encodeURIComponent(result.id)}`)
			if (done(resource)) {
				return resource
			}
			if (attempt >= 40) {
				throw new Error("The change was accepted but is not visible yet. Reload in a moment.")
			}
			await pause()
		} catch (error) {
			if (attempt >= 40 || !(error instanceof ApiError) || ![404, 503].includes(error.status)) {
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

const readable = <T>(collection: string) => ({
	list: (after?: string, signal?: AbortSignal) =>
		call<Page<T>>(
			"GET",
			`${collection}?limit=100&order=desc${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`,
			undefined,
			undefined,
			signal,
		),
	retrieve: (id: string, signal?: AbortSignal) =>
		call<T>("GET", `${collection}/${encodeURIComponent(id)}`, undefined, undefined, signal),
})

const resource = <T, Create, Update extends { readonly version: number } = never>(
	collection: string,
) => ({
	...readable<T>(collection),
	create: async (body: Create, idempotencyKey: string) =>
		settled(collection, await call<T | Pending>("POST", collection, body, idempotencyKey)),
	update: async (id: string, body: Update) =>
		settled(
			collection,
			await call<T | Pending>("POST", `${collection}/${encodeURIComponent(id)}`, body),
			(saved) => versionOf(saved) > body.version,
		),
	archive: async (id: string) =>
		settled(
			collection,
			await call<T | Pending>("POST", `${collection}/${encodeURIComponent(id)}/archive`),
			isArchived,
		),
})

const automations = "/v1/automations"
const automationPath = (id: string, action = "") =>
	`${automations}/${encodeURIComponent(id)}${action}`
const automationAction = async (
	id: string,
	action: string,
	done: (automation: JsonAutomation) => boolean,
) =>
	settled(
		automations,
		await call<JsonAutomation | Pending>("POST", automationPath(id, action)),
		done,
	)

export type JsonArtifactLink = IsoDateTimes<ArtifactLink>

const artifactPath = (id: string) => `/v1/artifacts/${encodeURIComponent(id)}`
const versionPath = (id: string, version: number) => `${artifactPath(id)}/versions/${version}`

export const checkfu = {
	agents: resource<JsonAgent, CreateAgentBody, UpdateAgentBody>("/v1/agents"),
	environments: resource<JsonEnvironment, CreateEnvironmentBody>("/v1/environments"),
	automations: {
		...resource<JsonAutomation, CreateAutomationBody>(automations),
		update: async (id: string, body: UpdateAutomationBody) =>
			settled(
				automations,
				await call<JsonAutomation | Pending>("POST", automationPath(id), body),
				(saved) => showsChanges(saved, body),
			),
		pause: (id: string) =>
			automationAction(id, "/pause", (automation) => automation.status !== "active"),
		unpause: (id: string) =>
			automationAction(id, "/unpause", (automation) => automation.status !== "paused"),
		run: async (
			id: string,
		): Promise<{ readonly run: number; readonly listed: JsonAutomationRun | null }> => {
			const queued = await call<AutomationRunQueued>("POST", automationPath(id, "/run"))
			const listed = await settled<JsonAutomationRun>(automationPath(id, "/runs"), {
				id: String(queued.run),
				pending: true,
			}).catch(() => null)
			return { run: queued.run, listed }
		},
		runs: (id: string, before?: number, signal?: AbortSignal) =>
			call<RunPage>(
				"GET",
				`${automationPath(id, "/runs")}?order=desc&limit=20${before === undefined ? "" : `&after=${before}`}`,
				undefined,
				undefined,
				signal,
			),
	},
	sessions: {
		...resource<JsonSession, CreateSessionBody>("/v1/sessions"),
		send: (id: string, body: SendSessionEventsBody, idempotencyKey: string) =>
			call<unknown>("POST", `/v1/sessions/${encodeURIComponent(id)}/events`, body, idempotencyKey),
		events: (id: string, before?: number, signal?: AbortSignal) =>
			call<EventPage>(
				"GET",
				`/v1/sessions/${encodeURIComponent(id)}/events?order=desc&limit=100${before === undefined ? "" : `&after=${before}`}`,
				undefined,
				undefined,
				signal,
			),
		streamUrl: (id: string, after: number) =>
			`/v1/sessions/${encodeURIComponent(id)}/events/stream?after=${after}`,
	},
	artifacts: {
		...readable<JsonArtifact>("/v1/artifacts"),
		version: (id: string, version: number, signal?: AbortSignal) =>
			call<JsonArtifactVersion>("GET", versionPath(id, version), undefined, undefined, signal),
		file: (id: string, version: number, path: string, signal?: AbortSignal) =>
			call<ArtifactFileContent>(
				"GET",
				`${versionPath(id, version)}/file?path=${encodeURIComponent(path)}`,
				undefined,
				undefined,
				signal,
			),
		link: (id: string, version: number, body: CreateArtifactLinkBody) =>
			call<JsonArtifactLink>("POST", `${versionPath(id, version)}/links`, body),
		publish: (id: string, body: PublishArtifactBody, idempotencyKey: string) =>
			call<JsonArtifact>("POST", `${artifactPath(id)}/publication`, body, idempotencyKey),
		unpublish: (id: string, idempotencyKey: string) =>
			call<JsonArtifact>("DELETE", `${artifactPath(id)}/publication`, undefined, idempotencyKey),
		delete: (id: string) => call<unknown>("DELETE", artifactPath(id)),
	},
}

export const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : "Something went wrong."

export const isSignedOut = (error: unknown): boolean =>
	error instanceof ApiError && error.status === 401

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
