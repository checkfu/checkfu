import type {
	CreateAgentBody,
	CreateEnvironmentBody,
	CreateSessionBody,
	SendSessionEventsBody,
	UpdateAgentBody,
} from "@checkfu/sdk/Api"
import type { JsonAgent, JsonEnvironment, JsonSession, JsonSessionEvent } from "@checkfu/sdk/client"

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
	method: "GET" | "POST",
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
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary: the API's own JSON, typed by @checkfu/sdk
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

const resource = <T, Create, Update extends { readonly version: number } = never>(
	collection: string,
) => ({
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

export const checkfu = {
	agents: resource<JsonAgent, CreateAgentBody, UpdateAgentBody>("/v1/agents"),
	environments: resource<JsonEnvironment, CreateEnvironmentBody>("/v1/environments"),
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
