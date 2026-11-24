import type {
	CreateAgentBody,
	CreateEnvironmentBody,
	CreateSessionBody,
	SendSessionEventsBody,
	UpdateAgentBody,
} from "@checkfu/sdk/Api"
import type { JsonAgent, JsonEnvironment, JsonSession } from "@checkfu/sdk/client"

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

interface Pending {
	readonly id: string
	readonly pending: true
}

const call = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
	const response = await fetch(
		path,
		body === undefined
			? { method }
			: { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
	)
	const text = await response.text()
	const json: unknown = text === "" ? undefined : JSON.parse(text)
	if (!response.ok) {
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
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary: the API's own JSON, typed by @checkfu/sdk
	return json as T
}

const isPending = <T>(value: T | Pending): value is Pending =>
	typeof value === "object" && value !== null && "pending" in value && value.pending === true

const settled = async <T>(collection: string, result: T | Pending): Promise<T> => {
	if (!isPending(result)) {
		return result
	}
	for (let attempt = 0; ; attempt++) {
		try {
			return await call<T>("GET", `${collection}/${encodeURIComponent(result.id)}`)
		} catch (error) {
			if (attempt >= 40 || !(error instanceof ApiError) || ![404, 503].includes(error.status)) {
				throw error
			}
			await new Promise((resolve) => {
				setTimeout(resolve, 250)
			})
		}
	}
}

const resource = <T, Create, Update = never>(collection: string) => ({
	list: () => call<Page<T>>("GET", `${collection}?limit=100&order=desc`),
	retrieve: (id: string) => call<T>("GET", `${collection}/${encodeURIComponent(id)}`),
	create: async (body: Create) =>
		settled(collection, await call<T | Pending>("POST", collection, body)),
	update: async (id: string, body: Update) =>
		settled(
			collection,
			await call<T | Pending>("POST", `${collection}/${encodeURIComponent(id)}`, body),
		),
	archive: (id: string) => call<unknown>("POST", `${collection}/${encodeURIComponent(id)}/archive`),
})

export const checkfu = {
	agents: resource<JsonAgent, CreateAgentBody, UpdateAgentBody>("/v1/agents"),
	environments: resource<JsonEnvironment, CreateEnvironmentBody>("/v1/environments"),
	sessions: {
		...resource<JsonSession, CreateSessionBody>("/v1/sessions"),
		send: (id: string, body: SendSessionEventsBody) =>
			call<unknown>("POST", `/v1/sessions/${encodeURIComponent(id)}/events`, body),
		streamUrl: (id: string) => `/v1/sessions/${encodeURIComponent(id)}/events/stream`,
	},
}

export const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : "Something went wrong."

export const isSignedOut = (error: unknown): boolean =>
	error instanceof ApiError && error.status === 401

let verified = false

export const signedIn = async (): Promise<boolean> => {
	if (verified) {
		return true
	}
	const response = await fetch("/auth/session")
	if (response.status !== 401 && !response.ok) {
		throw new Error(`Could not reach the API (${response.status}).`)
	}
	verified = response.ok
	return verified
}

export const signIn = async (key: string): Promise<"ok" | "rejected" | "failed"> => {
	const response = await fetch("/auth/sign-in", {
		method: "POST",
		body: new URLSearchParams({ key }),
	})
	if (response.ok) {
		verified = true
	}
	return response.ok ? "ok" : response.status === 401 ? "rejected" : "failed"
}

export const signOut = async (): Promise<void> => {
	verified = false
	await fetch("/auth/sign-out", { method: "POST" })
}
