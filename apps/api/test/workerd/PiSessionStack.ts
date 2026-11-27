import { expect } from "vitest"
import { startFakeGitHubServer } from "./FakeGitHubServer.ts"
import { startFakeOpenAIResponsesServer } from "./FakeOpenAIResponsesServer.ts"
import type { SessionResource, SessionEventItem } from "./WorkerdStack.ts"
import {
	TEST_GITHUB_TOKEN,
	AUTH_HEADERS,
	sleep,
	parseResponseJson,
	startAlchemyDev,
	apiAt,
} from "./WorkerdStack.ts"

export interface SavedOutputs {
	readonly turn: number
	readonly status: string
	readonly files: ReadonlyArray<{
		readonly id: string
		readonly size: number
		readonly sha256: string
		readonly content_type: string
		readonly origin: { readonly path: string; readonly turn: number }
	}>
	readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>
}

export const savedPaths = (saved: SavedOutputs) => saved.files.map((file) => file.origin.path)

export const piSessionHelpers = (at: {
	readonly baseUrl: () => string
	readonly agentId: () => string
	readonly environmentId: () => string
}) => {
	const { apiFetch, apiJson } = apiAt(at.baseUrl)

	const pollResourceReady = async <T>(
		resourcePath: string,
		predicate?: (resource: T) => boolean,
		timeoutMs = 15_000,
	): Promise<T> => {
		const deadline = Date.now() + timeoutMs
		let lastStatus = 0
		let lastRaw = ""
		while (Date.now() < deadline) {
			const res = await apiFetch(resourcePath)
			lastStatus = res.status
			lastRaw = await res.text()
			if (res.status === 200) {
				const parsed = parseResponseJson<T>("GET", resourcePath, res.status, lastRaw)
				if (predicate === undefined || predicate(parsed)) {
					return parsed
				}
			} else if (res.status !== 404 && res.status !== 503) {
				throw new Error(`GET ${resourcePath} failed (status=${res.status}): ${lastRaw}`)
			}
			await sleep(100)
		}
		throw new Error(`Timed out waiting for ${resourcePath} (lastStatus=${lastStatus}): ${lastRaw}`)
	}

	const createResource = async <T extends { readonly id: string }>(
		collectionPath: string,
		body: unknown,
		options?: { readonly retryTransient503?: boolean; readonly timeoutMs?: number },
	): Promise<T> => {
		const maxAttempts = options?.retryTransient503 === true ? 10 : 1
		let lastError = ""
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const res = await apiFetch(collectionPath, { method: "POST", body })
			const raw = await res.text()
			if (res.status === 201) {
				return parseResponseJson<T>("POST", collectionPath, res.status, raw)
			}
			if (res.status === 202) {
				const pending = parseResponseJson<{ readonly id?: unknown }>(
					"POST",
					collectionPath,
					res.status,
					raw,
				)
				if (typeof pending.id !== "string" || pending.id.length === 0) {
					throw new Error(`POST ${collectionPath} returned 202 without id: ${raw}`)
				}
				return pollResourceReady<T>(
					`${collectionPath}/${encodeURIComponent(pending.id)}`,
					undefined,
					options?.timeoutMs,
				)
			}
			lastError = `POST ${collectionPath} failed (status=${res.status}): ${raw}`
			if (res.status === 503 && attempt + 1 < maxAttempts) {
				await sleep(200)
				continue
			}
			throw new Error(lastError)
		}
		throw new Error(lastError)
	}

	const createSession = (): Promise<SessionResource> =>
		createResource<SessionResource>("/v1/sessions", {
			agent: at.agentId(),
			environment_id: at.environmentId(),
		})

	const waitForSession = (
		sessionId: string,
		predicate: (session: SessionResource) => boolean,
		timeoutMs = 20_000,
	): Promise<SessionResource> =>
		pollResourceReady<SessionResource>(
			`/v1/sessions/${encodeURIComponent(sessionId)}`,
			predicate,
			timeoutMs,
		)

	const listAllEvents = async (sessionId: string): Promise<ReadonlyArray<SessionEventItem>> => {
		const res = await apiJson<{ readonly data: ReadonlyArray<SessionEventItem> }>(
			`/v1/sessions/${sessionId}/events?limit=100`,
		)
		expect(res.status).toBe(200)
		return res.body.data
	}

	const storedMemories = async (storeId: string): Promise<Record<string, string>> => {
		const listed = await apiJson<{
			readonly data: ReadonlyArray<{ readonly id: string; readonly path: string }>
		}>(`/v1/memory_stores/${storeId}/memories`)
		const contents: Record<string, string> = {}
		for (const entry of listed.body.data) {
			const memory = await apiJson<{ readonly content: string }>(
				`/v1/memory_stores/${storeId}/memories/${entry.id}`,
			)
			contents[entry.path] = memory.body.content
		}
		return contents
	}

	const replyAfterTurn = async (sessionId: string, text: string, number: number) => {
		const sent = await apiJson(`/v1/sessions/${sessionId}/events`, {
			method: "POST",
			body: { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
		})
		expect(sent.status).toBe(200)
		await waitForSession(sessionId, (s) => s.status === "idle" && s.turn === number, 240_000)
		const replies = (await listAllEvents(sessionId)).filter((e) => e.type === "agent.message")
		return replies.at(-1)?.content?.[0]?.text ?? ""
	}

	const outputsAt = async (sessionId: string, turn: number): Promise<SavedOutputs> => {
		const deadline = Date.now() + 30_000
		for (;;) {
			const current = await apiJson<SavedOutputs>(`/v1/sessions/${sessionId}/outputs`)
			expect(current.status).toBe(200)
			if (current.body.turn >= turn || Date.now() > deadline) {
				return current.body
			}
			await sleep(100)
		}
	}
	const fileBytes = async (fileId: string) => {
		const response = await apiFetch(`/v1/files/${fileId}/content`)
		expect(response.status).toBe(200)
		return Buffer.from(await response.arrayBuffer())
	}

	const uploadFile = (
		query: string,
		bytes: Uint8Array<ArrayBuffer>,
		headers: Record<string, string> = {},
	) =>
		fetch(`${at.baseUrl()}/v1/files?${query}`, {
			method: "POST",
			headers: {
				...AUTH_HEADERS,
				"content-type": "application/octet-stream",
				"content-length": String(bytes.byteLength),
				...headers,
			},
			body: bytes,
		})

	return {
		apiFetch,
		apiJson,
		pollResourceReady,
		createResource,
		createSession,
		waitForSession,
		listAllEvents,
		storedMemories,
		replyAfterTurn,
		outputsAt,
		fileBytes,
		uploadFile,
	}
}

export const startPiSessionStack = async () => {
	const cleanup: Array<() => Promise<void>> = []
	try {
		const fakeOpenAI = await startFakeOpenAIResponsesServer((req) => ({
			kind: "reply",
			text: `Echo: ${req.lastUserText}`,
			inputTokens: 17,
			outputTokens: 9,
		}))
		cleanup.push(() => fakeOpenAI.close())
		const fakeGitHub = await startFakeGitHubServer([
			{ name: "acme/api", files: { "README.md": "# Acme API\n" }, token: TEST_GITHUB_TOKEN },
			{ name: "acme/secret", files: { "KEYS.md": "do not read\n" }, token: "ghp_another_token" },
		])
		cleanup.push(() => fakeGitHub.close())
		const worker = await startAlchemyDev(fakeOpenAI.baseUrl, fakeGitHub.baseUrl)
		cleanup.push(() => worker.stop())
		const { createResource } = piSessionHelpers({
			baseUrl: () => worker.baseUrl,
			agentId: () => "",
			environmentId: () => "",
		})
		const agent = await createResource<{ readonly id: string }>(
			"/v1/agents",
			{
				name: "Workerd Test Agent",
				model: "gpt-4o-mini",
				system: "Remember facts from earlier turns.",
			},
			{ retryTransient503: true },
		)
		const environment = await createResource<{ readonly id: string }>("/v1/environments", {
			name: "Workerd Test Env",
		})
		return { fakeOpenAI, fakeGitHub, worker, agentId: agent.id, environmentId: environment.id }
	} catch (error) {
		await Promise.allSettled(cleanup.reverse().map(async (stop) => stop()))
		throw error
	}
}
