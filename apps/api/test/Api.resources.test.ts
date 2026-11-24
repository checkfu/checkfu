import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeApiHandler } from "../src/Http/Router.ts"
import { createRepositoryFetch } from "../src/Workspace/Repositories.ts"
import {
	AUTH_HEADERS,
	extractSystemText,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendAndSettle,
	sendRequest,
	waitForSession,
} from "./helpers/ApiHarness.ts"

type ApiFetch = Parameters<typeof sendRequest>[0]

interface ResourceItem {
	readonly id: string
	readonly type: string
	readonly url: string
	readonly mount_path: string
	readonly checkout: unknown
	readonly created_at: string
	readonly updated_at: string
}

interface SessionBody {
	readonly id: string
	readonly created_at: string
	readonly resources: ReadonlyArray<ResourceItem>
}

const TOKEN = "ghp_test_secret_token"

interface RepositoryOverrides {
	readonly type?: string
	readonly url?: string
	readonly mount_path?: string
	readonly authorization_token?: string
	readonly checkout?: { readonly type: string; readonly sha?: string; readonly name?: string }
}

const request = (apiFetch: ApiFetch, method: string, path: string, body?: unknown) =>
	sendRequest(apiFetch, {
		method,
		path,
		headers: AUTH_HEADERS,
		...(body === undefined ? {} : { body }),
	})

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

const createAgentAndEnvironment = (apiFetch: ApiFetch) =>
	Effect.gen(function* () {
		const agent = yield* json<{ id: string }>(
			yield* request(apiFetch, "POST", "/v1/agents", {
				name: "Agent",
				model: "gpt-4o-mini",
				system: "Be brief.",
			}),
		)
		const environment = yield* json<{ id: string }>(
			yield* request(apiFetch, "POST", "/v1/environments", { name: "Env" }),
		)
		return { agent: agent.id, environment_id: environment.id }
	})

describe("Session resources", () => {
	it("mounts repositories at admission, hands their tokens to the workspace, and never returns them", async () => {
		const { layer, closeAll, repositoryTokens } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const base = yield* createAgentAndEnvironment(apiFetch)
					const created = yield* request(apiFetch, "POST", "/v1/sessions", {
						...base,
						resources: [
							{
								type: "github_repository",
								url: "https://github.com/acme/api",
								authorization_token: TOKEN,
							},
							{
								type: "github_repository",
								url: "https://github.com/acme/docs",
								mount_path: "/workspace/handbook",
								checkout: { type: "branch", name: "release" },
							},
						],
					})
					expect(created.status).toBe(201)
					const createdText = yield* Effect.promise(() => created.text())
					expect(createdText).not.toContain(TOKEN)
					const session = JSON.parse(createdText) as SessionBody
					expect(session.resources).toEqual([
						{
							id: expect.stringMatching(/^sesrsc_/),
							type: "github_repository",
							url: "https://github.com/acme/api",
							mount_path: "/workspace/api",
							checkout: null,
							created_at: session.created_at,
							updated_at: session.created_at,
						},
						{
							id: expect.stringMatching(/^sesrsc_/),
							type: "github_repository",
							url: "https://github.com/acme/docs",
							mount_path: "/workspace/handbook",
							checkout: { type: "branch", name: "release" },
							created_at: session.created_at,
							updated_at: session.created_at,
						},
					])
					const [api, docs] = session.resources
					expect([...repositoryTokens]).toEqual([[`${session.id}/${api?.id}`, TOKEN]])

					const fetched = yield* request(apiFetch, "GET", `/v1/sessions/${session.id}`)
					expect((yield* json<SessionBody>(fetched)).resources).toEqual(session.resources)

					const listed = yield* request(apiFetch, "GET", `/v1/sessions/${session.id}/resources`)
					expect(listed.status).toBe(200)
					const listedText = yield* Effect.promise(() => listed.text())
					expect(listedText).not.toContain(TOKEN)
					expect(JSON.parse(listedText)).toEqual({ data: session.resources })

					const one = yield* request(
						apiFetch,
						"GET",
						`/v1/sessions/${session.id}/resources/${docs?.id}`,
					)
					expect(yield* json(one)).toEqual(docs)

					const missing = yield* request(
						apiFetch,
						"GET",
						`/v1/sessions/${session.id}/resources/sesrsc_missing`,
					)
					expect(missing.status).toBe(404)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("gives a retried create the same resources and stores the token again", async () => {
		const { layer, closeAll, repositoryTokens } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const base = yield* createAgentAndEnvironment(apiFetch)
					const create = (token: string) =>
						sendRequest(apiFetch, {
							method: "POST",
							path: "/v1/sessions",
							headers: { ...AUTH_HEADERS, "idempotency-key": "session-with-repo" },
							body: {
								...base,
								resources: [
									{
										type: "github_repository",
										url: "https://github.com/acme/api",
										authorization_token: token,
									},
								],
							},
						})
					const first = yield* json<SessionBody>(yield* create(TOKEN))
					const second = yield* json<SessionBody>(yield* create("ghp_rotated_before_retry"))
					expect(second.id).toBe(first.id)
					expect(second.resources).toEqual(first.resources)
					expect([...repositoryTokens]).toEqual([
						[`${first.id}/${first.resources[0]?.id}`, "ghp_rotated_before_retry"],
					])

					const changed = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: { ...AUTH_HEADERS, "idempotency-key": "session-with-repo" },
						body: {
							...base,
							resources: [{ type: "github_repository", url: "https://github.com/acme/other" }],
						},
					})
					expect(changed.status).toBe(409)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("refuses repositories that are malformed or whose mount paths collide", async () => {
		const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		const repository = (overrides: RepositoryOverrides) => ({
			type: "github_repository",
			url: "https://github.com/acme/api",
			...overrides,
		})
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const base = yield* createAgentAndEnvironment(apiFetch)
					const refused: ReadonlyArray<ReadonlyArray<RepositoryOverrides>> = [
						[repository({ url: "https://gitlab.com/acme/api" })],
						[repository({ url: "https://github.com/acme/api.git" })],
						[repository({ url: "https://github.com/acme/../other" })],
						[repository({ url: "http://github.com/acme/api" })],
						[repository({ url: "https://token@github.com/acme/api" })],
						[repository({ mount_path: "/etc/passwd" })],
						[repository({ mount_path: "/workspace/../etc" })],
						[repository({ mount_path: "workspace/api" })],
						[repository({ mount_path: "/workspace" })],
						[repository({ checkout: { type: "commit", sha: "abc123" } })],
						[repository({ authorization_token: "" })],
						[repository({}), repository({})],
						[repository({}), repository({ mount_path: "/workspace/second-copy" })],
						[
							repository({ mount_path: "/workspace/code" }),
							repository({ url: "https://github.com/acme/web", mount_path: "/workspace/code/web" }),
						],
						Array.from({ length: 9 }, (_, index) =>
							repository({ url: `https://github.com/acme/repo-${index}` }),
						),
					]
					for (const resources of refused) {
						const response = yield* request(apiFetch, "POST", "/v1/sessions", {
							...base,
							resources,
						})
						expect([JSON.stringify(resources), response.status]).toEqual([
							JSON.stringify(resources),
							400,
						])
					}
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("clones the session's repositories before a turn and tells the model where they are", async () => {
		const systems: Array<string> = []
		const { layer, closeAll, preparedWorkspaces, preparations } = makePiDurableTestLayer(
			async (model, context) => {
				systems.push(extractSystemText(context))
				return makeAssistantReply(model, null, "ok", 1, 1)
			},
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const base = yield* createAgentAndEnvironment(apiFetch)
					const session = yield* json<SessionBody>(
						yield* request(apiFetch, "POST", "/v1/sessions", {
							...base,
							resources: [
								{
									type: "github_repository",
									url: "https://github.com/acme/api",
									checkout: { type: "commit", sha: "0123456789abcdef0123456789abcdef01234567" },
								},
							],
						}),
					)
					const [repository] = session.resources
					const mount = {
						id: repository?.id,
						type: "github_repository",
						url: "https://github.com/acme/api",
						mount_path: "/workspace/api",
						checkout: { type: "commit", sha: "0123456789abcdef0123456789abcdef01234567" },
					}

					preparations.push({
						ok: false,
						resource_id: repository?.id ?? "",
						message: "HTTP Error: 401 Unauthorized",
					})
					const send = (text: string) =>
						request(apiFetch, "POST", `/v1/sessions/${session.id}/events`, {
							events: [{ type: "user.message", content: [{ type: "text", text }] }],
						})
					expect((yield* send("first")).status).toBe(200)
					yield* waitForSession(apiFetch, session.id, (s) => s.status === "idle" && s.turn === 1)
					const events = yield* json<{
						data: ReadonlyArray<{ type: string; error?: { type: string; message: string } }>
					}>(yield* request(apiFetch, "GET", `/v1/sessions/${session.id}/events`))
					expect(events.data.find((event) => event.type === "session.error")?.error).toEqual({
						type: "repository_unavailable",
						message: "Could not clone https://github.com/acme/api: HTTP Error: 401 Unauthorized",
						retry_status: { type: "exhausted" },
					})
					expect(systems).toEqual([])

					yield* sendAndSettle(apiFetch, session.id, ["second"], 2)
					expect(preparedWorkspaces).toEqual([
						{ sessionId: session.id, repositories: [mount] },
						{ sessionId: session.id, repositories: [mount] },
					])
					expect(systems).toHaveLength(1)
					expect(systems[0]).toContain("Be brief.")
					expect(systems[0]).toContain(
						"- /workspace/api: https://github.com/acme/api (commit 0123456789abcdef0123456789abcdef01234567)",
					)

					const plain = yield* json<SessionBody>(
						yield* request(apiFetch, "POST", "/v1/sessions", base),
					)
					expect(plain.resources).toEqual([])
					yield* sendAndSettle(apiFetch, plain.id, ["hello"], 1)
					expect(preparedWorkspaces).toHaveLength(2)
					expect(systems[1]).not.toContain("Repositories mounted")
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("gives the workspace to a turn before it clones, and stops a turn the workspace refuses", async () => {
		let modelCalls = 0
		const { layer, closeAll, workspaceCalls, refusedWorkspaces, preparedWorkspaces } =
			makePiDurableTestLayer(async (model) => {
				modelCalls += 1
				return makeAssistantReply(model, null, "ok", 1, 1)
			})
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const ids = yield* createAgentAndEnvironment(apiFetch)
					const create = () =>
						Effect.flatMap(
							request(apiFetch, "POST", "/v1/sessions", {
								...ids,
								resources: [{ type: "github_repository", url: "https://github.com/acme/api" }],
							}),
							(res) => json<SessionBody>(res),
						)
					const first = yield* create()
					yield* sendAndSettle(apiFetch, first.id, ["Look around."], 1)
					expect(workspaceCalls).toEqual([`enter ${first.id} 1`, `prepare ${first.id} 1`])
					expect(modelCalls).toBe(1)

					// A later turn already has the workspace, or the session has ended.
					const second = yield* create()
					refusedWorkspaces.add(second.id)
					const sent = yield* request(apiFetch, "POST", `/v1/sessions/${second.id}/events`, {
						events: [{ type: "user.message", content: [{ type: "text", text: "Too late." }] }],
					})
					expect(sent.status).toBe(200)
					yield* waitForSession(apiFetch, second.id, (s) => s.status === "idle" && s.turn === 1)
					const events = yield* json<{
						data: ReadonlyArray<{ type: string; stop_reason?: unknown }>
					}>(yield* request(apiFetch, "GET", `/v1/sessions/${second.id}/events`))
					expect(events.data.at(-1)?.stop_reason).toEqual({ type: "interrupted" })
					expect(workspaceCalls.filter((call) => call.includes(second.id))).toEqual([
						`enter ${second.id} 1`,
					])
					expect(preparedWorkspaces.map(({ sessionId }) => sessionId)).toEqual([first.id])
					expect(modelCalls).toBe(1)
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})

	it("rotates a repository's token while the session lives, and not after it ends", async () => {
		const { layer, closeAll, repositoryTokens } = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 1, 1),
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const base = yield* createAgentAndEnvironment(apiFetch)
					const session = yield* json<SessionBody>(
						yield* request(apiFetch, "POST", "/v1/sessions", {
							...base,
							resources: [{ type: "github_repository", url: "https://github.com/acme/api" }],
						}),
					)
					const [repository] = session.resources
					const path = `/v1/sessions/${session.id}/resources/${repository?.id}`
					expect(repositoryTokens.size).toBe(0)

					const rotated = yield* request(apiFetch, "POST", path, { authorization_token: TOKEN })
					expect(rotated.status).toBe(200)
					const rotatedText = yield* Effect.promise(() => rotated.text())
					expect(rotatedText).not.toContain(TOKEN)
					expect(JSON.parse(rotatedText)).toEqual(repository)
					expect([...repositoryTokens]).toEqual([[`${session.id}/${repository?.id}`, TOKEN]])

					expect((yield* request(apiFetch, "POST", path, {})).status).toBe(400)
					expect(
						(yield* request(
							apiFetch,
							"POST",
							`/v1/sessions/${session.id}/resources/sesrsc_missing`,
							{ authorization_token: TOKEN },
						)).status,
					).toBe(404)

					expect(
						(yield* request(apiFetch, "POST", `/v1/sessions/${session.id}/archive`)).status,
					).toBe(200)
					const late = yield* request(apiFetch, "POST", path, {
						authorization_token: "ghp_too_late",
					})
					expect(late.status).toBe(409)
					expect([...repositoryTokens]).toEqual([[`${session.id}/${repository?.id}`, TOKEN]])
				}).pipe(Effect.scoped, Effect.provide(layer)),
			)
		} finally {
			await closeAll()
		}
	})
})

describe("repository fetch", () => {
	const mounted = [
		{ id: "sesrsc_api", url: "https://github.com/acme/api" },
		{ id: "sesrsc_docs", url: "https://github.com/acme/docs" },
	]
	const record = (baseUrl: string | null = null) => {
		const calls: Array<{ url: string; authorization: string | null; redirect: unknown }> = []
		const repositoryFetch = createRepositoryFetch({
			repositories: () => mounted,
			token: (resourceId) => (resourceId === "sesrsc_api" ? TOKEN : undefined),
			baseUrl,
			fetch: (input, init) => {
				calls.push({
					url: String(input),
					authorization: new Headers(init?.headers).get("authorization"),
					redirect: init?.redirect,
				})
				return Promise.resolve(new Response("ok"))
			},
		})
		return { calls, repositoryFetch }
	}

	it("sends a mounted repository's token to that repository only, and follows no redirect", async () => {
		const { calls, repositoryFetch } = record()
		const basic = `Basic ${btoa(`x-access-token:${TOKEN}`)}`
		await repositoryFetch("https://github.com/acme/api/info/refs?service=git-upload-pack")
		await repositoryFetch(new URL("https://github.com/acme/api.git/git-receive-pack"), {
			method: "POST",
			headers: { authorization: "Basic c3RvbGVu" },
		})
		await repositoryFetch("https://github.com/acme/docs/info/refs", {
			headers: { authorization: "Bearer supplied-by-the-model" },
		})
		expect(calls).toEqual([
			{
				url: "https://github.com/acme/api/info/refs?service=git-upload-pack",
				authorization: basic,
				redirect: "manual",
			},
			{
				url: "https://github.com/acme/api.git/git-receive-pack",
				authorization: basic,
				redirect: "manual",
			},
			{ url: "https://github.com/acme/docs/info/refs", authorization: null, redirect: "manual" },
		])
	})

	it("reaches nothing that is not a mounted repository", async () => {
		const { calls, repositoryFetch } = record()
		const refused = [
			"https://github.com/acme/other/info/refs",
			"https://github.com/acme/api-private/info/refs",
			"https://github.com/acme/api",
			"https://github.com/acme/api/../other/info/refs",
			"https://github.com/acme/docs/%2e%2e/api-private/info/refs",
			"https://evil.example/acme/api/info/refs",
			"https://github.com.evil.example/acme/api/info/refs",
			"https://user@github.com/acme/api/info/refs",
			"http://github.com/acme/api/info/refs",
			"not a url",
		]
		for (const url of refused) {
			const response = await repositoryFetch(url)
			expect([url, response.status]).toEqual([url, 403])
		}
		expect(
			(await repositoryFetch(new Request("https://github.com/acme/api/info/refs"))).status,
		).toBe(403)
		expect(calls).toEqual([])
	})

	it("sends the same paths to a local server when one stands in for GitHub", async () => {
		const { calls, repositoryFetch } = record("http://127.0.0.1:4010")
		await repositoryFetch("https://github.com/acme/api/info/refs?service=git-upload-pack")
		expect(calls.map((call) => call.url)).toEqual([
			"http://127.0.0.1:4010/acme/api/info/refs?service=git-upload-pack",
		])
	})
})
