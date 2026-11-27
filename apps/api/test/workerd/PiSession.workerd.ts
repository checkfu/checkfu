import { MAX_SESSION_INITIAL_MESSAGES_BYTES } from "@checkfu/sdk/Limits"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
	describeEager,
	describeMeasured,
	HARNESS_SOURCES_HELP,
	STARTUP_HELP,
	TOTAL_BYTES_HELP,
	WORKER_LIMITS,
	measureBundle,
} from "./BundleBudget.ts"
import type { FakeGitHubServer } from "./FakeGitHubServer.ts"
import type { FakeOpenAIAction, FakeOpenAIResponsesServer } from "./FakeOpenAIResponsesServer.ts"
import { authoredProjectJourney } from "./UserJourneys.ts"
import { asInitialEvents, mixedInitialMessagesAt } from "../helpers/SessionInitialMessages.ts"
import type { SessionResource } from "./WorkerdStack.ts"
import {
	REPO_ROOT,
	TEST_API_KEY,
	TEST_OPENAI_KEY,
	TEST_CUSTOM_PROVIDER_ID,
	TEST_CUSTOM_API_KEY,
	TEST_CUSTOM_HEADER_SECRET,
	TEST_GITHUB_TOKEN,
	AUTH_HEADERS,
	localR2,
	artifactBucketName,
	sleep,
	parseResponseJson,
	stripAnsi,
	boundEnv,
	boundNames,
	userMessage,
} from "./WorkerdStack.ts"
import { piSessionHelpers, startPiSessionStack } from "./PiSessionStack.ts"

describe("PiSession real Durable Object under workerd", () => {
	let fakeOpenAI: FakeOpenAIResponsesServer
	let fakeGitHub: FakeGitHubServer
	let baseUrl: string
	let stage: string
	let stopWorker: (() => Promise<void>) | undefined
	let workerLogs: ReadonlyArray<string> = []
	let workerStage: string
	let agentId: string
	let environmentId: string

	const {
		apiFetch,
		apiJson,
		pollResourceReady,
		createResource,
		createSession,
		waitForSession,
		listAllEvents,
		storedMemories,
		replyAfterTurn,
		uploadFile,
	} = piSessionHelpers({
		baseUrl: () => baseUrl,
		agentId: () => agentId,
		environmentId: () => environmentId,
	})

	beforeAll(async () => {
		const started = await startPiSessionStack()
		fakeOpenAI = started.fakeOpenAI
		fakeGitHub = started.fakeGitHub
		baseUrl = started.worker.baseUrl
		stage = started.worker.stage
		stopWorker = started.worker.stop
		workerLogs = started.worker.logs
		workerStage = started.worker.stage
		agentId = started.agentId
		environmentId = started.environmentId
	}, 240_000)

	afterAll(async () => {
		await stopWorker?.()
		await fakeOpenAI?.close()
		await fakeGitHub?.close()
	}, 30_000)

	afterEach(({ task }) => {
		if (task.tags?.includes("acceptance")) {
			Object.assign(task.meta, {
				workerLogs: workerLogs.join("").slice(-30_000),
				modelRequests: fakeOpenAI.requests.length,
			})
		}
	})

	it(
		"takes a YAML project through the installed npm CLI and an independent MCP client without losing history or competing edits",
		{ timeout: 120_000, tags: ["acceptance", "authored-project"] },
		async () => {
			const deadline = Date.now() + 15_000
			let mcpUrl: string | undefined
			while (mcpUrl === undefined && Date.now() < deadline) {
				mcpUrl = stripAnsi(workerLogs.join("")).match(
					/\[McpWorker\] ready at (http:\/\/[^\s]+)/,
				)?.[1]
				if (mcpUrl === undefined) {
					await sleep(100)
				}
			}
			if (mcpUrl === undefined) {
				throw new Error("The MCP Worker did not become ready")
			}
			fakeOpenAI.setHandler((req) =>
				req.toolOutputs.length === 0
					? {
							kind: "tool_call",
							name: "write",
							arguments: {
								path: "/mnt/session/outputs/report.csv",
								content: "region,total\nEMEA,4217\n",
							},
						}
					: { kind: "reply", text: "The report is ready." },
			)
			try {
				await authoredProjectJourney({
					baseUrl,
					mcpUrl: `${mcpUrl}/mcp`,
					apiKey: TEST_API_KEY,
				})
			} finally {
				fakeOpenAI.setHandler((req) => ({
					kind: "reply",
					text: `Echo: ${req.lastUserText}`,
					inputTokens: 17,
					outputTokens: 9,
				}))
			}
		},
	)

	it.each(["rate limit", "provider unavailable", "truncated stream"] as const)(
		"preserves a queued follow-up after a %s and recovers without duplicate replies",
		async (failure) => {
			const session = await createSession()
			const first = `Fail this request: ${failure}`
			const followUp = `Recover this session: ${failure}`
			let release!: () => void
			const ready = new Promise<void>((resolve) => {
				release = resolve
			})
			fakeOpenAI.setHandler(async (request) => {
				if (request.lastUserText !== first) {
					return { kind: "reply", text: `Recovered: ${request.lastUserText}` }
				}
				await ready
				return failure === "truncated stream"
					? { kind: "hold", release: Promise.resolve(null) }
					: { kind: "http_error", status: failure === "rate limit" ? 429 : 503, message: failure }
			})
			try {
				expect(
					(
						await apiJson(`/v1/sessions/${session.id}/events`, {
							method: "POST",
							body: { events: [userMessage(first)] },
						})
					).status,
				).toBe(200)
				await fakeOpenAI.waitForRequest((request) => request.lastUserText === first)
				expect(
					(
						await apiJson(`/v1/sessions/${session.id}/events`, {
							method: "POST",
							body: { events: [userMessage(followUp)] },
						})
					).status,
				).toBe(200)
				release()
				await waitForSession(
					session.id,
					(state) => state.status === "idle" && state.turn === 2,
					60_000,
				)
				const events = await listAllEvents(session.id)
				expect(
					events
						.filter((event) => event.type === "user.message")
						.map((event) => event.content?.[0]?.text),
				).toEqual([first, followUp])
				expect(events.filter((event) => event.type === "session.error")).toHaveLength(1)
				expect(
					events
						.filter((event) => event.type === "agent.message")
						.map((event) => event.content?.[0]?.text),
				).toEqual([`Recovered: ${followUp}`])
				expect(new Set(events.map((event) => event.id)).size).toBe(events.length)
			} finally {
				release()
				await apiJson(`/v1/sessions/${session.id}/archive`, { method: "POST" })
			}
		},
		90_000,
	)

	const answer = (sessionId: string, callId: string, text: string) =>
		apiJson(`/v1/sessions/${sessionId}/events`, {
			method: "POST",
			body: {
				events: [
					{
						type: "user.custom_tool_result",
						custom_tool_use_id: callId,
						content: [{ type: "text", text }],
					},
				],
			},
		})

	it("finishes an automation run whose tool would wait in a user-started session", async () => {
		const agent = await createResource<{ readonly id: string }>("/v1/agents", {
			name: "Receipt reporter",
			model: "gpt-4o-mini",
			tools: [
				{
					type: "custom",
					name: "receipt",
					description: "Return a receipt",
					input_schema: { type: "object", properties: {} },
				},
			],
		})
		fakeOpenAI.setHandler((request) =>
			request.toolOutputs.length === 0
				? { kind: "tool_call", name: "receipt", arguments: {} }
				: { kind: "reply", text: "Finished checking for a receipt." },
		)
		const initial_events = [userMessage("Find the receipt.")]
		const automation = await apiJson<{ readonly id: string }>("/v1/automations", {
			method: "POST",
			headers: { "idempotency-key": "unattended-custom-tool" },
			body: {
				name: "Receipt report",
				agent: agent.id,
				environment_id: environmentId,
				initial_events,
				schedule: { type: "cron", expression: "0 0 1 1 *", timezone: "UTC" },
			},
		})
		expect([201, 202]).toContain(automation.status)
		const automationPath = `/v1/automations/${automation.body.id}`
		await pollResourceReady(automationPath)
		const queued = await apiJson<{ readonly run: number }>(`${automationPath}/run`, {
			method: "POST",
		})
		expect(queued.status).toBe(201)
		const ran = await pollResourceReady<{ readonly session_id: string }>(
			`${automationPath}/runs/${queued.body.run}`,
			(row) => typeof row.session_id === "string",
		)
		const automated = await waitForSession(
			ran.session_id,
			(session) => session.status === "idle" && session.turn === 1,
		)
		const automaticEvents = await listAllEvents(automated.id)
		expect(automaticEvents.at(-1)?.stop_reason).toEqual({ type: "end_turn" })
		const refused = automaticEvents.find((event) => event.type === "agent.tool_result")
		expect(refused?.is_error).toBe(true)
		expect(refused?.content?.some((part) => part.text?.includes("started by an automation"))).toBe(
			true,
		)

		const attended = await createResource<SessionResource>("/v1/sessions", {
			agent: agent.id,
			environment_id: environmentId,
			initial_events,
		})
		await expect
			.poll(
				async () =>
					(await listAllEvents(attended.id)).findLast(
						(event) => event.type === "session.status_idle",
					)?.stop_reason?.type,
			)
			.toBe("requires_action")
		const pending = (await listAllEvents(attended.id)).find(
			(event) => event.type === "agent.custom_tool_use",
		)
		if (pending?.tool_use_id === undefined) {
			throw new Error("No pending receipt")
		}
		expect((await answer(attended.id, pending.tool_use_id, "Receipt found")).status).toBe(200)
	}, 60_000)

	it("isolates pending custom tools across parallel sessions, including archived and repeated answers", async () => {
		const agent = await createResource<{ readonly id: string }>("/v1/agents", {
			name: "Parallel receipts",
			model: "gpt-4o-mini",
			tools: [
				{
					type: "custom",
					name: "receipt",
					description: "Return a receipt",
					input_schema: {
						type: "object",
						properties: { owner: { type: "string" } },
						required: ["owner"],
					},
				},
			],
		})
		fakeOpenAI.setHandler((request) =>
			request.toolOutputs.length === 0
				? { kind: "tool_call", name: "receipt", arguments: { owner: request.lastUserText } }
				: { kind: "reply", text: `${request.lastUserText}: ${request.toolOutputs.join(" | ")}` },
		)
		const sessions = await Promise.all(
			["OWNER_A", "OWNER_B", "OWNER_C"].map(async (owner) => {
				const session = await createResource<SessionResource>("/v1/sessions", {
					agent: agent.id,
					environment_id: environmentId,
				})
				expect(
					(
						await apiJson(`/v1/sessions/${session.id}/events`, {
							method: "POST",
							body: { events: [userMessage(owner)] },
						})
					).status,
				).toBe(200)
				return { ...session, owner }
			}),
		)

		try {
			const waiting = await Promise.all(
				sessions.map(async (session) => {
					await expect
						.poll(
							async () =>
								(await listAllEvents(session.id)).some(
									(event) =>
										event.type === "session.status_idle" &&
										event.stop_reason?.type === "requires_action",
								),
							{ timeout: 20_000 },
						)
						.toBe(true)
					const call = (await listAllEvents(session.id)).find(
						(event) => event.type === "agent.custom_tool_use",
					)
					if (call?.tool_use_id === undefined) {
						throw new Error("No pending receipt")
					}
					expect(call.input).toEqual({ owner: session.owner })
					return { ...session, callId: call.tool_use_id, eventId: call.id }
				}),
			)
			const [first, archived, last] = waiting
			if (first === undefined || archived === undefined || last === undefined) {
				throw new Error("Missing parallel session")
			}
			expect((await answer(first.id, archived.callId, "FOREIGN_RESULT")).status).toBe(409)
			expect((await answer(first.id, archived.eventId, "FOREIGN_EVENT_RESULT")).status).toBe(409)
			const outcomes = await Promise.all([
				answer(first.id, first.callId, "RECEIPT_A"),
				apiJson(`/v1/sessions/${archived.id}/archive`, { method: "POST" }),
				answer(last.id, last.callId, "RECEIPT_C"),
			])
			expect(outcomes.map((outcome) => outcome.status)).toEqual([200, 200, 200])
			for (const session of [first, last]) {
				await expect
					.poll(
						async () =>
							(await listAllEvents(session.id)).filter((event) => event.type === "agent.message")
								.length,
						{ timeout: 20_000 },
					)
					.toBe(1)
				const events = await listAllEvents(session.id)
				expect(events.filter((event) => event.type === "agent.custom_tool_use")).toHaveLength(1)
				expect(events.filter((event) => event.type === "user.custom_tool_result")).toHaveLength(1)
				const text =
					events.find((event) => event.type === "agent.message")?.content?.[0]?.text ?? ""
				expect(text).toContain(session.owner)
				expect(text).toContain(session.id === first.id ? "RECEIPT_A" : "RECEIPT_C")
				expect(text).not.toContain(session.id === first.id ? "RECEIPT_C" : "RECEIPT_A")
				expect(JSON.stringify(events)).not.toContain("FOREIGN")
			}
			expect((await answer(first.id, first.callId, "DUPLICATE_RESULT")).status).toBe(409)
			expect((await answer(archived.id, archived.callId, "LATE_RESULT")).status).toBe(409)
			expect(
				(await listAllEvents(archived.id)).filter((event) => event.type === "agent.message"),
			).toHaveLength(0)
		} finally {
			await Promise.all(
				sessions.map((session) =>
					apiJson(`/v1/sessions/${session.id}/archive`, { method: "POST" }),
				),
			)
		}
	}, 60_000)

	it("round-trips the initial message byte boundary through real Durable Objects", async () => {
		fakeOpenAI.setHandler(() => ({ kind: "reply", text: "Received." }))
		const messages = mixedInitialMessagesAt(MAX_SESSION_INITIAL_MESSAGES_BYTES)
		const session = await createResource<SessionResource>("/v1/sessions", {
			agent: agentId,
			environment_id: environmentId,
			initial_events: asInitialEvents(messages),
		})
		await waitForSession(session.id, (resource) => resource.turn === 1)
		const history = await listAllEvents(session.id)
		const recorded = history.flatMap((event) =>
			event.type === "user.message" ? [event.content?.[0]?.text] : [],
		)
		expect(recorded).toHaveLength(messages.length)
		expect(recorded.every((message, index) => message === messages[index])).toBe(true)
	}, 60_000)

	it("replays a keyed session admission after its agent is archived", async () => {
		const agent = await createResource<{ readonly id: string }>("/v1/agents", {
			name: "Keyed session agent",
			model: "gpt-4o-mini",
		})
		const title = "Keyed session"
		const path = "/v1/sessions"
		const create = (requestedTitle: string) =>
			fetch(`${baseUrl}${path}`, {
				method: "POST",
				headers: {
					...AUTH_HEADERS,
					"content-type": "application/json",
					"idempotency-key": `create-${agent.id}`,
				},
				body: JSON.stringify({
					agent: agent.id,
					environment_id: environmentId,
					title: requestedTitle,
				}),
			})
		const idOf = async (response: Response) => {
			const raw = await response.text()
			expect([201, 202], raw).toContain(response.status)
			return parseResponseJson<{ readonly id: string }>("POST", path, response.status, raw).id
		}

		const [first, concurrent] = await Promise.all([create(title), create(title)])
		const id = await idOf(first)
		expect(await idOf(concurrent)).toBe(id)
		const archived = await apiJson(`/v1/agents/${agent.id}/archive`, { method: "POST" })
		expect([200, 202]).toContain(archived.status)
		await pollResourceReady<{ readonly archived_at: string | null }>(
			`/v1/agents/${agent.id}`,
			(row) => row.archived_at !== null,
		)
		expect(await idOf(await create(title))).toBe(id)
		const changed = await create("Different title")
		expect(changed.status, await changed.text()).toBe(409)
		const session = await pollResourceReady<{ readonly title: string }>(`${path}/${id}`)
		expect(session.title).toBe(title)
	}, 30_000)

	it("serializes a conditional archive with a competing automation repoint", async () => {
		const target = await createResource<{ readonly id: string }>("/v1/environments", {
			name: "Prune target",
		})
		const creation = await fetch(`${baseUrl}/v1/automations`, {
			method: "POST",
			headers: {
				...AUTH_HEADERS,
				"content-type": "application/json",
				"idempotency-key": "guarded-archive-race",
			},
			body: JSON.stringify({
				name: "Guarded archive race",
				agent: agentId,
				environment_id: environmentId,
				initial_events: [
					{ type: "user.message", content: [{ type: "text", text: "Write a report." }] },
				],
				schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
			}),
		})
		const raw = await creation.text()
		expect([201, 202], raw).toContain(creation.status)
		const { id } = parseResponseJson<{ readonly id: string }>(
			"POST",
			"/v1/automations",
			creation.status,
			raw,
		)
		const automationPath = `/v1/automations/${id}`
		const environmentPath = `/v1/environments/${target.id}`
		await pollResourceReady<{ readonly data: ReadonlyArray<{ readonly id: string }> }>(
			"/v1/automations",
			(page) => page.data.some((row) => row.id === id),
		)

		const [archive, repoint] = await Promise.all([
			apiJson(`${environmentPath}/archive?version=1`, { method: "POST" }),
			apiJson(automationPath, { method: "POST", body: { environment_id: target.id } }),
		])
		const archived = archive.status === 200 || archive.status === 202
		if (archived) {
			expect(repoint.status, JSON.stringify(repoint.body)).toBe(409)
		} else {
			expect([409, 503], JSON.stringify(archive.body)).toContain(archive.status)
			expect([200, 202], JSON.stringify(repoint.body)).toContain(repoint.status)
		}
		await pollResourceReady<{ readonly archived_at: string | null }>(
			environmentPath,
			(environment) => (environment.archived_at !== null) === archived,
		)
		const automation = await pollResourceReady<{
			readonly environment_id: string
			readonly revision: number
		}>(automationPath, (row) => row.environment_id === (archived ? environmentId : target.id))
		const cleanup = await apiJson(`${automationPath}/archive?revision=${automation.revision}`, {
			method: "POST",
		})
		expect([200, 202], JSON.stringify(cleanup.body)).toContain(cleanup.status)
	}, 30_000)

	it("builds an artifact from uploaded files by copying their bytes in R2, and keeps them after the files are deleted", async () => {
		const data = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 31 + 7) % 256)
		const sha256 = createHash("sha256").update(data).digest("hex")
		const uploadBytes = async (filename: string, bytes: Uint8Array<ArrayBuffer>) => {
			const response = await fetch(`${baseUrl}/v1/files?filename=${filename}`, {
				method: "POST",
				headers: {
					...AUTH_HEADERS,
					"content-type": "application/octet-stream",
					"content-length": String(bytes.byteLength),
				},
				body: bytes,
			})
			expect(response.status, await response.clone().text()).toBe(201)
			return (await response.json()) as { readonly id: string }
		}
		const file = await uploadBytes("data.bin", data)
		const empty = await uploadBytes("empty.txt", new Uint8Array(0))
		const created = await apiJson<{
			readonly id: string
			readonly version: number
			readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>
		}>("/v1/artifacts", {
			method: "POST",
			body: {
				name: "Bytes",
				files: [
					{ path: "data.bin", file_id: file.id },
					{ path: "empty.txt", file_id: empty.id },
					{ path: "note.txt", content: "inline" },
				],
			},
		})
		expect(created.status, JSON.stringify(created.body)).toBe(201)
		expect(created.body.version).toBe(1)
		expect(created.body.files.map(({ path }) => path)).toEqual([
			"data.bin",
			"empty.txt",
			"note.txt",
		])
		expect(created.body.files[0]?.sha256).toBe(sha256)
		const bucket = artifactBucketName(workerStage)
		expect(
			(
				await localR2(
					baseUrl,
					"GET",
					bucket,
					`artifacts/default/${created.body.id}/blobs/${sha256}`,
				)
			).status,
		).toBe(200)

		for (const id of [file.id, empty.id]) {
			expect((await apiFetch(`/v1/files/${id}`, { method: "DELETE" })).status).toBe(200)
		}
		const download = await apiFetch(
			`/v1/artifacts/${created.body.id}/versions/1/content?file=data.bin`,
		)
		expect(download.status).toBe(200)
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(data)
		const middle = await apiFetch(`/v1/files/${file.id}/content`, {
			headers: { range: "bytes=65536-131071" },
		})
		expect(middle.status).toBe(206)
		expect(middle.headers.get("content-range")).toBe("bytes 65536-131071/300000")
		expect(new Uint8Array(await middle.arrayBuffer())).toEqual(data.subarray(65_536, 131_072))

		const version = await apiJson<{ readonly version: number }>(
			`/v1/artifacts/${created.body.id}/versions`,
			{
				method: "POST",
				body: {
					version: 1,
					files: [
						{ path: "kept.bin", sha256 },
						{ path: "note.txt", content: "changed" },
					],
				},
			},
		)
		expect(version.status).toBe(201)
		expect(version.body.version).toBe(2)
		const gone = await apiJson(`/v1/artifacts/${created.body.id}/versions`, {
			method: "POST",
			body: { version: 2, files: [{ path: "data.bin", file_id: file.id }] },
		})
		expect(gone.status).toBe(404)
	}, 60_000)

	it("keeps an artifact's documents in its own database, and erases them with the artifact", async () => {
		interface Document {
			readonly id: string
			readonly data: unknown
			readonly created_at: string
		}
		const make = async (name: string) =>
			(
				await apiJson<{ readonly id: string }>("/v1/artifacts", {
					method: "POST",
					body: { name, files: [{ path: "index.html", content: `<h1>${name}</h1>` }] },
				})
			).body.id
		const one = await make("Data one")
		const two = await make("Data two")
		const data = `/v1/artifacts/${one}/data`

		const keyed = {
			method: "POST",
			body: { data: { choice: "b" } },
			headers: { "idempotency-key": `vote-${one}` },
		}
		const added = await apiJson<Document>(`${data}/votes`, keyed)
		expect(added.status, JSON.stringify(added.body)).toBe(201)
		expect(added.body.data).toEqual({ choice: "b" })
		const again = await apiJson<Document>(`${data}/votes`, keyed)
		expect(again.body).toEqual(added.body)
		expect(
			(await apiJson(`${data}/votes`, { ...keyed, body: { data: { choice: "a" } } })).status,
		).toBe(409)

		const large = "é".repeat(30_000)
		const put = await apiJson<Document>(`${data}/votes/pinned`, {
			method: "PUT",
			body: { data: { large, list: [1, null, true] } },
		})
		expect(put.status, JSON.stringify(put.body).slice(0, 300)).toBe(200)
		const replaced = await apiJson<Document>(`${data}/votes/pinned`, {
			method: "PUT",
			body: { data: "second" },
		})
		expect(replaced.body).toMatchObject({ data: "second", created_at: put.body.created_at })
		expect(
			(
				await apiJson(`${data}/votes/too-large`, {
					method: "PUT",
					body: { data: "x".repeat(65_536) },
				})
			).status,
		).toBe(400)

		const first = await apiJson<{
			readonly data: ReadonlyArray<Document>
			readonly next_page: string | null
		}>(`${data}/votes?limit=1`)
		expect(first.body.data.map((document) => document.id)).toEqual([added.body.id])
		const rest = await apiJson<{
			readonly data: ReadonlyArray<Document>
			readonly next_page: string | null
		}>(`${data}/votes?limit=1&page=${first.body.next_page}`)
		expect(rest.body.data.map((document) => document.id)).toEqual(["pinned"])
		expect(rest.body.next_page).toBeNull()

		expect((await apiJson(data)).body).toEqual({
			type: "artifact_database",
			artifact_id: one,
			bytes: 14 + 8,
			collections: [{ name: "votes", documents: 2, bytes: 14 + 8 }],
		})
		expect((await apiJson(`/v1/artifacts/${two}/data`)).body).toMatchObject({ collections: [] })
		expect((await apiFetch(`/v1/artifacts/${two}/data/votes/pinned`)).status).toBe(404)

		expect((await apiFetch(`${data}/votes/pinned`, { method: "DELETE" })).status).toBe(200)
		expect((await apiFetch(`${data}/votes/pinned`)).status).toBe(404)

		expect((await apiFetch(`/v1/artifacts/${one}`, { method: "DELETE" })).status).toBe(200)
		expect((await apiFetch(data)).status).toBe(404)
		expect((await apiJson(`${data}/votes/late`, { method: "PUT", body: { data: 1 } })).status).toBe(
			404,
		)
		expect((await apiFetch(`/v1/artifacts/${two}`, { method: "DELETE" })).status).toBe(200)
	}, 60_000)

	it("stores an uploaded file in R2, answers a retry with the same file, and removes its bytes on delete", async () => {
		interface StoredFile {
			readonly id: string
			readonly filename: string
			readonly content_type: string
			readonly size: number
			readonly sha256: string
		}
		const data = Uint8Array.from({ length: 300_000 }, (_, index) => (index * 29 + 3) % 256)
		const key = { "idempotency-key": `file-${crypto.randomUUID()}` }
		const created = await uploadFile("filename=report.pdf", data, key)
		expect(created.status, await created.clone().text()).toBe(201)
		const file = (await created.json()) as StoredFile
		expect(file).toMatchObject({
			filename: "report.pdf",
			content_type: "application/pdf",
			size: data.byteLength,
			sha256: createHash("sha256").update(data).digest("hex"),
		})
		const bucket = artifactBucketName(workerStage)
		const storedBytes = () => localR2(baseUrl, "GET", bucket, `files/default/${file.id}/content`)
		expect((await storedBytes()).status).toBe(200)

		const replay = await uploadFile("filename=report.pdf", data, key)
		expect(replay.status).toBe(201)
		expect(((await replay.json()) as StoredFile).id).toBe(file.id)
		expect(
			(
				await uploadFile(
					"filename=report.pdf",
					data.map((byte) => 255 - byte),
					key,
				)
			).status,
		).toBe(409)

		expect((await apiJson<StoredFile>(`/v1/files/${file.id}`)).body).toMatchObject({
			id: file.id,
			size: data.byteLength,
		})
		const download = await apiFetch(`/v1/files/${file.id}/content`)
		expect(download.status).toBe(200)
		expect(download.headers.get("content-type")).toBe("application/pdf")
		expect(download.headers.get("content-disposition")).toBe(
			"attachment; filename*=UTF-8''report.pdf",
		)
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(data)

		const empty = await uploadFile("filename=empty.txt", new Uint8Array(0))
		expect(empty.status).toBe(201)
		const emptyFile = (await empty.json()) as StoredFile
		expect(emptyFile.size).toBe(0)
		expect(
			(await (await apiFetch(`/v1/files/${emptyFile.id}/content`)).arrayBuffer()).byteLength,
		).toBe(0)

		const listed = await pollResourceReady<{ readonly data: ReadonlyArray<StoredFile> }>(
			"/v1/files?limit=100",
			(page) => page.data.some((row) => row.id === file.id),
		)
		expect(listed.data.find((row) => row.id === file.id)).toMatchObject({ filename: "report.pdf" })

		const deleted = await apiFetch(`/v1/files/${file.id}`, { method: "DELETE" })
		expect(deleted.status).toBe(200)
		expect(await deleted.json()).toEqual({ id: file.id, type: "file_deleted" })
		expect((await storedBytes()).status).toBe(404)
		expect((await apiFetch(`/v1/files/${file.id}`)).status).toBe(404)
		expect((await apiFetch(`/v1/files/${file.id}/content`)).status).toBe(404)
		expect((await uploadFile("filename=report.pdf", data, key)).status).toBe(409)
		expect((await storedBytes()).status).toBe(404)
	}, 60_000)

	it("serves the OpenAPI document as a static asset, without running the Worker", async () => {
		const res = await fetch(`${baseUrl}/openapi.json`)
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8")
		expect(await res.json()).toEqual(
			JSON.parse(readFileSync(join(REPO_ROOT, "apps", "api", "public", "openapi.json"), "utf8")),
		)
		expect(res.headers.get("request-id")).toBeNull()
	})

	const listedAgentIds = async () => {
		const res = await apiJson<{ readonly data: ReadonlyArray<{ readonly id: string }> }>(
			"/v1/agents?limit=100",
		)
		expect(res.status).toBe(200)
		return res.body.data.map((agent) => agent.id)
	}

	it("lists a memory with the hash of the update just acknowledged, and reads it back at once", async () => {
		const store = await createResource<{ id: string }>("/v1/memory_stores", { name: "Notes" })
		const memories = `/v1/memory_stores/${store.id}/memories`
		const created = await createResource<{ id: string }>(memories, {
			path: "/a.md",
			content: "0",
		})
		for (let round = 1; round <= 12; round += 1) {
			const res = await apiFetch(`${memories}/${created.id}`, {
				method: "POST",
				body: { content: `Round ${round}.` },
			})
			expect(res.status).toBe(200)
			const updated = (await res.json()) as { content_sha256: string; version: number }
			const [listed, read] = await Promise.all([
				apiFetch(memories).then(
					(list) => list.json() as Promise<{ data: ReadonlyArray<{ content_sha256: string }> }>,
				),
				apiFetch(`${memories}/${created.id}`).then(
					(one) => one.json() as Promise<{ version: number }>,
				),
			])
			expect([round, listed.data.map((entry) => entry.content_sha256)]).toEqual([
				round,
				[updated.content_sha256],
			])
			expect(read.version).toBeGreaterThanOrEqual(updated.version)
		}
	}, 60_000)

	it("answers successive list requests in one isolate", async () => {
		const deadline = Date.now() + 20_000
		while (!(await listedAgentIds()).includes(agentId) && Date.now() < deadline) {
			await sleep(200)
		}
		for (const _ of [1, 2, 3]) {
			expect(await listedAgentIds()).toContain(agentId)
		}
	}, 30_000)

	it("keeps every Worker's start-up and size well inside Cloudflare's limits", async () => {
		for (const worker of ["ApiWorker", "ContentWorker", "PiHarnessWorker"] as const) {
			const measured = await measureBundle(
				join(REPO_ROOT, ".alchemy", "bundles", `Checkfu-${stage}-${worker}`),
				`${worker}.js`,
			)
			process.stdout.write(`${describeMeasured(worker, measured)}\n`)
			expect(
				measured.startupCpuMs,
				`${STARTUP_HELP}\n${describeEager(worker, measured)}`,
			).toBeLessThanOrEqual(WORKER_LIMITS.startupCpuMs)
			expect(
				measured.totalBytes,
				`${TOTAL_BYTES_HELP} ${describeMeasured(worker, measured)}`,
			).toBeLessThanOrEqual(WORKER_LIMITS.totalBytes)
			if (worker === "PiHarnessWorker") {
				expect(measured.harnessSources.length).toBeGreaterThan(0)
			} else {
				expect(measured.harnessSources, HARNESS_SOURCES_HELP).toEqual([])
			}
		}
	}, 60_000)

	it("binds provider keys only to the harness Worker and the API key only to the API Worker", () => {
		const api = boundNames(stage, "ApiWorker")
		const apiEnvSerialized = JSON.stringify(boundEnv(stage, "ApiWorker"))
		const harness = boundNames(stage, "PiHarnessWorker")
		expect(api).toContain("CHECKFU_API_KEY")
		expect(api).toContain("CHECKFU_PROVIDER_CATALOG")
		expect(api).not.toContain("CHECKFU_PROVIDERS")
		expect(apiEnvSerialized).toContain(TEST_CUSTOM_PROVIDER_ID)
		expect(apiEnvSerialized).not.toContain("x-tenant")
		expect(apiEnvSerialized).not.toContain("acme-tenant-tag")
		expect(apiEnvSerialized).not.toContain("x-custom-secret")
		expect(apiEnvSerialized).not.toContain("CHECKFU_PROVIDER_SECRET_CUSTOM_LOCAL_API_KEY")
		expect(api).not.toContain("OPENAI_API_KEY")
		expect(api).not.toContain("ANTHROPIC_API_KEY")
		expect(api).not.toContain("OPENROUTER_API_KEY")
		expect(api).not.toContain("CLOUDFLARE_AI_API_KEY")
		expect(api).not.toContain("CLOUDFLARE_API_KEY")
		expect(api).not.toContain("CHECKFU_PROVIDER_SECRET_CUSTOM_LOCAL_API_KEY")
		expect(api).not.toContain("CHECKFU_PROVIDER_SECRET_CUSTOM_LOCAL_HEADER_SECRET")
		expect(harness).toContain("CHECKFU_PROVIDERS")
		expect(harness).toContain("OPENAI_API_KEY")
		expect(harness).toContain("ANTHROPIC_API_KEY")
		expect(harness).toContain("OPENROUTER_API_KEY")
		expect(harness).toContain("CLOUDFLARE_AI_API_KEY")
		expect(harness).not.toContain("CLOUDFLARE_API_KEY")
		expect(harness).toContain("CHECKFU_PROVIDER_SECRET_CUSTOM_LOCAL_API_KEY")
		expect(harness).toContain("CHECKFU_PROVIDER_SECRET_CUSTOM_LOCAL_HEADER_SECRET")
		expect(harness).not.toContain("CHECKFU_API_KEY")
	})

	it("runs a turn against a custom format-compatible provider with isolated secrets", async () => {
		fakeOpenAI.setHandler((req) => ({
			kind: "reply",
			text: `Custom echo: ${req.lastUserText}`,
			inputTokens: 13,
			outputTokens: 6,
		}))

		const customAgent = await createResource<{ readonly id: string }>("/v1/agents", {
			name: "Custom Provider Agent",
			model: `${TEST_CUSTOM_PROVIDER_ID}/custom-model-v1`,
			system: "Respond concisely.",
		})
		const session = await createResource<SessionResource>("/v1/sessions", {
			agent: customAgent.id,
			environment_id: environmentId,
		})
		const startCount = fakeOpenAI.requests.length
		const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: {
				events: [
					{
						type: "system.message",
						content: [{ type: "text", text: "Report distances in meters." }],
					},
					{
						type: "user.message",
						content: [{ type: "text", text: "Hello custom provider" }],
					},
				],
			},
		})
		expect(sent.status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)

		const req = fakeOpenAI.requests[startCount]
		expect(req?.model).toBe("custom-model-v1")
		const system = req?.messages.filter(
			(message) => message.role === "system" || message.role === "developer",
		)
		expect(system?.[0]?.text).toContain("Respond concisely.")
		expect(system?.map((message) => message.text).join("\n")).toContain(
			"Report distances in meters.",
		)
		expect(req?.userTexts).toEqual(["Hello custom provider"])
		expect(req?.authorization).toBe(`Bearer ${TEST_CUSTOM_API_KEY}`)
		expect(req?.headers["x-tenant"]).toBe("acme-tenant-tag")
		expect(req?.headers["x-custom-secret"]).toBe(TEST_CUSTOM_HEADER_SECRET)

		const events = await listAllEvents(session.id)
		expect(events.find((e) => e.type === "agent.message")?.content).toEqual([
			{ type: "text", text: "Custom echo: Hello custom provider" },
		])
	}, 30_000)

	it("runs a turn from message to reply and remembers the first turn on the second", async () => {
		fakeOpenAI.setHandler((req) => {
			if (req.lastUserText.startsWith("Remember the secret code:")) {
				return {
					kind: "reply",
					text: "Stored MANGO-42.",
					inputTokens: 21,
					outputTokens: 7,
				}
			}
			const priorUser = req.userTexts.find((text) => text.includes("MANGO-42"))
			const priorAssistant = req.assistantTexts.find((text) => text.includes("Stored MANGO-42."))
			return {
				kind: "reply",
				text:
					priorUser !== undefined && priorAssistant !== undefined
						? "The secret code is MANGO-42."
						: "I do not remember any code.",
				inputTokens: 43,
				outputTokens: 11,
			}
		})

		const session = await createSession()
		const startCount = fakeOpenAI.requests.length

		const turn1Send = await apiJson<{ readonly data: ReadonlyArray<{ readonly turn: number }> }>(
			`/v1/sessions/${session.id}/events`,
			{
				method: "POST",
				body: {
					events: [
						{
							type: "user.message",
							content: [{ type: "text", text: "Remember the secret code: MANGO-42." }],
						},
					],
				},
			},
		)
		expect(turn1Send.status).toBe(200)
		expect(turn1Send.body.data[0]?.turn).toBe(1)

		const afterTurn1 = await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)
		expect(afterTurn1.status).toBe("idle")

		const eventsAfterTurn1 = await listAllEvents(session.id)
		expect(eventsAfterTurn1.map((e) => e.type)).toEqual([
			"user.message",
			"session.status_running",
			"span.model_request_start",
			"agent.message",
			"span.model_request_end",
			"session.status_idle",
		])
		expect(eventsAfterTurn1.find((e) => e.type === "agent.message")?.content).toEqual([
			{ type: "text", text: "Stored MANGO-42." },
		])
		expect(eventsAfterTurn1.find((e) => e.type === "span.model_request_end")?.model_usage).toEqual({
			input_tokens: 21,
			output_tokens: 7,
		})
		expect(eventsAfterTurn1.at(-1)?.stop_reason).toEqual({ type: "end_turn" })

		const turn1Request = fakeOpenAI.requests[startCount]
		expect(turn1Request?.authorization).toBe(`Bearer ${TEST_OPENAI_KEY}`)
		expect(turn1Request?.model).toBe("gpt-4o-mini")
		expect(
			turn1Request?.messages.some(
				(m) =>
					(m.role === "system" || m.role === "developer") &&
					m.text.includes("Remember facts from earlier turns."),
			),
		).toBe(true)
		expect(turn1Request?.userTexts).toEqual(["Remember the secret code: MANGO-42."])

		const turn2Send = await apiJson<{ readonly data: ReadonlyArray<{ readonly turn: number }> }>(
			`/v1/sessions/${session.id}/events`,
			{
				method: "POST",
				body: {
					events: [
						{
							type: "user.message",
							content: [{ type: "text", text: "What was the secret code?" }],
						},
					],
				},
			},
		)
		expect(turn2Send.status).toBe(200)
		expect(turn2Send.body.data[0]?.turn).toBe(2)

		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 2)

		const turn2Request = fakeOpenAI.requests[startCount + 1]
		expect(turn2Request?.userTexts).toEqual([
			"Remember the secret code: MANGO-42.",
			"What was the secret code?",
		])
		expect(turn2Request?.assistantTexts).toEqual(["Stored MANGO-42."])

		const eventsAfterTurn2 = await listAllEvents(session.id)
		const agentMessages = eventsAfterTurn2.filter((e) => e.type === "agent.message")
		expect(agentMessages.map((e) => e.content?.[0]?.text)).toEqual([
			"Stored MANGO-42.",
			"The secret code is MANGO-42.",
		])
		const requestEnds = eventsAfterTurn2.filter((e) => e.type === "span.model_request_end")
		expect(requestEnds.map((e) => e.model_usage)).toEqual([
			{ input_tokens: 21, output_tokens: 7 },
			{ input_tokens: 43, output_tokens: 11 },
		])
	}, 30_000)

	it("keeps a file a workspace tool wrote for the turns that follow", async () => {
		fakeOpenAI.setHandler((req) => {
			const [output] = req.toolOutputs
			if (req.lastUserText === "Save the launch code.") {
				return output === undefined
					? {
							kind: "tool_call",
							name: "write",
							arguments: { path: "/workspace/notes/launch.txt", content: "PAPAYA-7" },
						}
					: { kind: "reply", text: "Saved." }
			}
			return output === undefined
				? { kind: "tool_call", name: "read", arguments: { path: "/workspace/notes/launch.txt" } }
				: { kind: "reply", text: `The file says: ${output}` }
		})

		const session = await createSession()
		const startCount = fakeOpenAI.requests.length
		const send = (text: string) =>
			apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
			})

		expect((await send("Save the launch code.")).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)
		expect((await send("What is in the launch file?")).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 2)

		const requests = fakeOpenAI.requests.slice(startCount)
		expect(requests).toHaveLength(4)
		expect(requests[0]?.toolNames).toEqual([
			"read",
			"ls",
			"find",
			"grep",
			"write",
			"edit",
			"delete",
			"bash",
			"save_artifact",
			"artifact_data",
			"codemode",
		])
		expect(requests[3]?.toolOutputs.join("")).toContain("PAPAYA-7")

		const events = await listAllEvents(session.id)
		expect(events.map((e) => e.type)).toEqual([
			"user.message",
			"session.status_running",
			"span.model_request_start",
			"agent.tool_use",
			"agent.tool_result",
			"agent.message",
			"span.model_request_end",
			"session.status_idle",
			"user.message",
			"session.status_running",
			"span.model_request_start",
			"agent.tool_use",
			"agent.tool_result",
			"agent.message",
			"span.model_request_end",
			"session.status_idle",
		])
		const [wrote, read] = events.filter((e) => e.type === "agent.tool_use")
		expect(wrote).toMatchObject({
			name: "write",
			input: { path: "/workspace/notes/launch.txt", content: "PAPAYA-7" },
		})
		expect(read).toMatchObject({ name: "read", input: { path: "/workspace/notes/launch.txt" } })
		const [wroteResult, readResult] = events.filter((e) => e.type === "agent.tool_result")
		expect(wroteResult).toMatchObject({ tool_use_id: wrote?.tool_use_id, is_error: false })
		expect(readResult).toMatchObject({ tool_use_id: read?.tool_use_id, is_error: false })
		expect(readResult?.content?.map((block) => block.text).join("")).toContain("PAPAYA-7")
		const replies = events.filter((e) => e.type === "agent.message").map((e) => e.content)
		expect(replies[0]).toEqual([{ type: "text", text: "Saved." }])
		expect(replies[1]?.[0]?.text).toContain("PAPAYA-7")
		expect(
			events.filter((e) => e.type === "span.model_request_end").map((e) => e.model_usage),
		).toEqual([
			{ input_tokens: 24, output_tokens: 12 },
			{ input_tokens: 24, output_tokens: 12 },
		])
	}, 60_000)

	it("finds and greps the workspace with globs", async () => {
		const steps = new Map<string, ReadonlyArray<FakeOpenAIAction>>(
			Object.entries({
				"Make files.": [
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: "/workspace/src/a.ts", content: "needle\n" },
					},
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: "/workspace/src/b.md", content: "needle\n" },
					},
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: "/workspace/node_modules/c.ts", content: "needle\n" },
					},
				],
				"Find them.": [
					{
						kind: "tool_call",
						name: "find",
						arguments: { pattern: "**/*.ts", exclude: ["node_modules/**"] },
					},
				],
				"Search them.": [
					{
						kind: "tool_call",
						name: "grep",
						arguments: {
							query: "needle",
							include: ["**/*.ts", "**/*.md"],
							exclude: "node_modules/**",
						},
					},
				],
			}),
		)
		fakeOpenAI.setHandler(
			(req) =>
				steps.get(req.lastUserText)?.[req.toolOutputs.length] ?? {
					kind: "reply",
					text: `Result: ${req.toolOutputs.at(-1) ?? ""}`,
				},
		)
		const session = await createSession()
		let number = 0
		const turn = async (text: string) => {
			number += 1
			const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
			})
			expect(sent.status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === number)
			return (await listAllEvents(session.id)).findLast((e) => e.type === "agent.message")
				?.content?.[0]?.text
		}
		await turn("Make files.")
		expect(await turn("Find them.")).toBe(
			'Result: {"path":"/workspace","pattern":"**/*.ts","count":1,"entries":[{"path":"/workspace/src/a.ts","type":"file"}]}',
		)
		const searched = JSON.parse((await turn("Search them."))?.slice("Result: ".length) ?? "{}") as {
			readonly matches: ReadonlyArray<{ readonly path: string }>
		}
		expect(searched.matches.map(({ path }) => path)).toEqual([
			"/workspace/src/a.ts",
			"/workspace/src/b.md",
		])
	}, 60_000)

	it("gives the working directory back, empty, after the agent deletes it", async () => {
		fakeOpenAI.setHandler((req) => {
			const [output] = req.toolOutputs
			if (output !== undefined) {
				return { kind: "reply", text: `Result: ${output}` }
			}
			return req.lastUserText === "Delete it."
				? { kind: "tool_call", name: "delete", arguments: { path: "/workspace", recursive: true } }
				: { kind: "tool_call", name: "ls", arguments: { path: "/workspace" } }
		})
		const session = await createSession()
		const send = (text: string) =>
			apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
			})
		expect((await send("Delete it.")).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)
		expect((await send("What is here?")).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 2)
		const reply = (await listAllEvents(session.id)).findLast((e) => e.type === "agent.message")
		expect(reply?.content?.[0]?.text).toBe('Result: {"path":"/workspace","count":0,"entries":[]}')
	}, 60_000)

	it("gives a new session an empty working directory it can list before writing anything", async () => {
		fakeOpenAI.setHandler((req) => {
			const [output] = req.toolOutputs
			return output === undefined
				? { kind: "tool_call", name: "ls", arguments: { path: "/workspace" } }
				: { kind: "reply", text: `Listing: ${output}` }
		})
		const session = await createSession()
		const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: {
				events: [{ type: "user.message", content: [{ type: "text", text: "What is here?" }] }],
			},
		})
		expect(sent.status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)
		const reply = (await listAllEvents(session.id)).find((e) => e.type === "agent.message")
		expect(reply?.content?.[0]?.text).toBe('Listing: {"path":"/workspace","count":0,"entries":[]}')
	}, 60_000)
	it("clones and fetches a read-only repository and refuses its push in the machine", async () => {
		const repo = "acme/api"
		const originalHead = fakeGitHub.git(repo, "rev-parse", "main")
		const before = fakeGitHub.requests.length
		fakeOpenAI.setHandler((request) =>
			request.toolOutputs.length === 0
				? {
						kind: "tool_call",
						name: "bash",
						arguments: {
							cwd: "/workspace/api",
							command:
								'git fetch -q origin main && echo fetched && git commit -q --allow-empty -m "Read-only test" && git push origin main 2>&1',
						},
					}
				: { kind: "reply", text: request.toolOutputs.at(-1) ?? "" },
		)
		const session = await createResource<
			SessionResource & {
				readonly resources: ReadonlyArray<{ readonly access: string }>
			}
		>("/v1/sessions", {
			agent: agentId,
			environment_id: environmentId,
			initial_events: [userMessage("Fetch and try to push the repository.")],
			resources: [
				{
					type: "github_repository",
					url: `https://github.com/${repo}`,
					access: "read_only",
					authorization_token: TEST_GITHUB_TOKEN,
				},
			],
		})
		expect(session.resources[0]?.access).toBe("read_only")
		await waitForSession(
			session.id,
			(state) => state.status === "idle" && state.turn === 1,
			120_000,
		)
		const reply = (await listAllEvents(session.id)).find((event) => event.type === "agent.message")
		const text = reply?.content?.[0]?.text ?? ""
		expect(text).toContain("fetched")
		expect(text).toContain("403")
		const requests = fakeGitHub.requests.slice(before)
		expect(requests.some((request) => request.path.endsWith("/git-upload-pack"))).toBe(true)
		expect(requests.some((request) => request.path.includes("git-receive-pack"))).toBe(false)
		expect(fakeGitHub.git(repo, "rev-parse", "main")).toBe(originalHead)
	}, 150_000)

	it("clones a private repository in the machine with its token kept outside it, lets the agent commit and push, and lends the token to no other repository", async () => {
		const repo = "/workspace/api"
		const steps = new Map<string, ReadonlyArray<FakeOpenAIAction>>(
			Object.entries({
				"Read the readme.": [
					{ kind: "tool_call", name: "read", arguments: { path: `${repo}/README.md` } },
				],
				"Add a changelog and push it.": [
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: `${repo}/CHANGELOG.md`, content: "## 1.0.1\n" },
					},
					{
						kind: "tool_call",
						name: "bash",
						arguments: {
							command:
								'git add CHANGELOG.md && git commit -qm "Add changelog" && git push -q origin main && echo pushed',
							cwd: repo,
						},
					},
				],
				"Look for the token.": [
					{
						kind: "tool_call",
						name: "bash",
						arguments: { command: "env; cat .git/config; git config --list", cwd: repo },
					},
				],
				"Clone the secret repository.": [
					{
						kind: "tool_call",
						name: "bash",
						arguments: {
							command:
								"git clone -q https://github.com/acme/secret /workspace/secret 2>&1 | tail -1",
							cwd: "/workspace",
						},
					},
				],
			}),
		)
		fakeOpenAI.setHandler(
			(req) =>
				steps.get(req.lastUserText)?.[req.toolOutputs.length] ?? {
					kind: "reply",
					text: `Done: ${req.toolOutputs.at(-1) ?? ""}`,
				},
		)
		const startCount = fakeOpenAI.requests.length

		const session = await createResource<
			SessionResource & {
				readonly resources: ReadonlyArray<{ readonly id: string; readonly mount_path: string }>
			}
		>("/v1/sessions", {
			agent: agentId,
			environment_id: environmentId,
			initial_events: [
				{ type: "user.message", content: [{ type: "text", text: "Read the readme." }] },
			],
			resources: [
				{
					type: "github_repository",
					url: "https://github.com/acme/api",
					authorization_token: TEST_GITHUB_TOKEN,
				},
			],
		})
		expect(session.resources.map((resource) => resource.mount_path)).toEqual([repo])
		expect(JSON.stringify(session)).not.toContain(TEST_GITHUB_TOKEN)

		const turn = (text: string, number: number) => replyAfterTurn(session.id, text, number)

		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 240_000)
		const firstReply = (await listAllEvents(session.id)).find((e) => e.type === "agent.message")
		expect(firstReply?.content?.[0]?.text).toContain("# Acme API")
		const basic = `Basic ${Buffer.from(`x-access-token:${TEST_GITHUB_TOKEN}`).toString("base64")}`
		expect(fakeGitHub.requests.length).toBeGreaterThan(0)
		expect(fakeGitHub.requests.map((request) => request.authorization)).toEqual(
			fakeGitHub.requests.map(() => basic),
		)
		expect(fakeGitHub.requests.map((request) => request.status)).toEqual(
			fakeGitHub.requests.map(() => 200),
		)

		expect(await turn("Add a changelog and push it.", 2)).toBe("Done: pushed")
		expect(
			fakeGitHub.git("acme/api", "log", "--format=%s|%an|%ae", "main").trim().split("\n"),
		).toEqual(["Add changelog|Checkfu|agent@checkfu.com", "Initial commit|Owner|owner@example.com"])
		expect(fakeGitHub.git("acme/api", "show", "main:CHANGELOG.md")).toBe("## 1.0.1\n")

		const looked = await turn("Look for the token.", 3)
		expect(looked).toContain("remote.origin.url=https://github.com/acme/api")
		expect(looked).not.toContain(TEST_GITHUB_TOKEN)
		expect(looked).not.toContain(basic)

		const refusal = await turn("Clone the secret repository.", 4)
		expect(refusal).toContain("Done: ")
		expect(refusal).not.toBe("Done: ")
		const secret = fakeGitHub.requests.filter((request) => request.path.startsWith("/acme/secret"))
		expect(secret.map((request) => request.authorization)).toEqual(secret.map(() => null))
		expect(fakeGitHub.git("acme/secret", "log", "--format=%s", "main").trim()).toBe(
			"Initial commit",
		)

		const requests = fakeOpenAI.requests.slice(startCount)
		expect(requests[0]?.toolNames).toContain("bash")
		expect(
			requests[0]?.messages.some((message) =>
				message.text.includes(`- ${repo}: https://github.com/acme/api (default branch)`),
			),
		).toBe(true)
		expect(JSON.stringify(requests.map((request) => request.body))).not.toContain(TEST_GITHUB_TOKEN)
		expect(JSON.stringify(requests.map((request) => request.body))).not.toContain(basic)
	}, 600_000)

	it("checks out a commit behind the branch tip without fetching the history before it", async () => {
		const tree = fakeGitHub.git("acme/api", "rev-parse", "main^{tree}").trim()
		const tip = fakeGitHub.git("acme/api", "rev-parse", "main").trim()
		const pinned = fakeGitHub.git("acme/api", "commit-tree", tree, "-p", tip, "-m", "Pinned").trim()
		const later = fakeGitHub
			.git("acme/api", "commit-tree", tree, "-p", pinned, "-m", "Later")
			.trim()
		fakeGitHub.git("acme/api", "update-ref", "refs/heads/main", later)
		const repo = "/workspace/pinned"
		fakeOpenAI.setHandler((req) =>
			req.toolOutputs.length === 0
				? {
						kind: "tool_call",
						name: "bash",
						arguments: { command: 'git log --format="%H %s"', cwd: repo },
					}
				: { kind: "reply", text: `Log: ${req.toolOutputs[0] ?? ""}` },
		)
		const session = await createResource<SessionResource>("/v1/sessions", {
			agent: agentId,
			environment_id: environmentId,
			resources: [
				{
					type: "github_repository",
					url: "https://github.com/acme/api",
					mount_path: repo,
					authorization_token: TEST_GITHUB_TOKEN,
					checkout: { type: "commit", sha: pinned },
				},
			],
		})
		const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: {
				events: [{ type: "user.message", content: [{ type: "text", text: "Show the log." }] }],
			},
		})
		expect(sent.status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 240_000)
		const reply = (await listAllEvents(session.id)).find((e) => e.type === "agent.message")
		expect(reply?.content?.[0]?.text).toBe(`Log: ${pinned} Pinned`)
	}, 300_000)

	it("tells the session why a repository was not reached, when its host is not allowed", async () => {
		fakeOpenAI.setHandler(() => ({ kind: "reply", text: "unused" }))
		const fenced = await createResource<{ readonly id: string }>("/v1/environments", {
			name: "Workerd Fenced Env",
			config: {
				type: "cloud",
				networking: {
					type: "limited",
					allowed_hosts: ["example.com"],
					allow_mcp_servers: false,
					allow_package_managers: false,
				},
			},
		})
		const session = await createResource<SessionResource>("/v1/sessions", {
			agent: agentId,
			environment_id: fenced.id,
			resources: [
				{
					type: "github_repository",
					url: "https://github.com/acme/api",
					authorization_token: TEST_GITHUB_TOKEN,
				},
			],
		})
		const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: { events: [{ type: "user.message", content: [{ type: "text", text: "Look." }] }] },
		})
		expect(sent.status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 120_000)
		const failure = (await listAllEvents(session.id)).find((e) => e.type === "session.error")
		expect(JSON.stringify(failure)).toContain("allowed_hosts")
	}, 180_000)
	it("mounts memory stores as files, saves a session's changes, and shares them with the next session", async () => {
		const createStore = async (name: string, memories: Readonly<Record<string, string>>) => {
			const store = await createResource<{ readonly id: string }>("/v1/memory_stores", { name })
			for (const [path, content] of Object.entries(memories)) {
				const created = await apiJson(`/v1/memory_stores/${store.id}/memories`, {
					method: "POST",
					body: { path, content },
				})
				expect(created.status).toBe(201)
			}
			return store
		}
		const notes = await createStore("Team Notes", { "/facts.md": "The launch code is KIWI-9." })
		const handbook = await createStore("Handbook", { "/rules.md": "Be kind." })
		const resources = [
			{ type: "memory_store", memory_store_id: notes.id },
			{ type: "memory_store", memory_store_id: handbook.id, access: "read_only" },
		]

		const steps = new Map<string, ReadonlyArray<FakeOpenAIAction>>(
			Object.entries({
				"What is the launch code?": [
					{
						kind: "tool_call",
						name: "read",
						arguments: { path: "/mnt/memory/team-notes/facts.md" },
					},
				],
				"Remember the customer's preference.": [
					{
						kind: "tool_call",
						name: "write",
						arguments: {
							path: "/mnt/memory/team-notes/customers/acme.md",
							content: "Prefers email.",
						},
					},
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: "/mnt/memory/handbook/rules.md", content: "Be cruel." },
					},
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: "/mnt/memory/./handbook//rules.md", content: "Be cruel." },
					},
					{ kind: "tool_call", name: "delete", arguments: { path: "/mnt/memory" } },
					{
						kind: "tool_call",
						name: "read",
						arguments: { path: "/mnt/memory/handbook/rules.md" },
					},
				],
				"What does Acme prefer?": [
					{
						kind: "tool_call",
						name: "read",
						arguments: { path: "/mnt/memory/team-notes/customers/acme.md" },
					},
				],
			}),
		)
		fakeOpenAI.setHandler(
			(req) =>
				steps.get(req.lastUserText)?.[req.toolOutputs.length] ?? {
					kind: "reply",
					text: `Done: ${req.toolOutputs.join(" | ")}`,
				},
		)
		const startCount = fakeOpenAI.requests.length

		const first = await createResource<SessionResource>("/v1/sessions", {
			agent: agentId,
			environment_id: environmentId,
			resources,
		})
		expect(await replyAfterTurn(first.id, "What is the launch code?", 1)).toContain("KIWI-9")
		const refused = await replyAfterTurn(first.id, "Remember the customer's preference.", 2)
		expect(refused.split("The memory store handbook is read-only.").length - 1).toBe(2)
		expect(refused).toContain("mount root can't be removed or renamed: /mnt/memory")
		expect(refused.endsWith("Be kind.")).toBe(true)
		expect(await storedMemories(notes.id)).toEqual({
			"/customers/acme.md": "Prefers email.",
			"/facts.md": "The launch code is KIWI-9.",
		})
		expect(await storedMemories(handbook.id)).toEqual({ "/rules.md": "Be kind." })

		const second = await createResource<SessionResource>("/v1/sessions", {
			agent: agentId,
			environment_id: environmentId,
			resources,
		})
		expect(await replyAfterTurn(second.id, "What does Acme prefer?", 1)).toContain("Prefers email.")

		const systemText = fakeOpenAI.requests[startCount]?.messages
			.filter((message) => message.role === "system" || message.role === "developer")
			.map((message) => message.text)
			.join("\n")
		expect(systemText).toContain("- /mnt/memory/team-notes (read and write): Team Notes.")
		expect(systemText).toContain("- /mnt/memory/handbook (read-only): Handbook.")
	}, 180_000)

	it("follows a memory path that turns from a directory into a file between turns", async () => {
		const store = await createResource<{ readonly id: string }>("/v1/memory_stores", {
			name: "Shapes",
		})
		const memories = `/v1/memory_stores/${store.id}/memories`
		const todo = await apiJson<{ readonly id: string }>(memories, {
			method: "POST",
			body: { path: "/notes/todo.md", content: "A file in a directory." },
		})
		expect(todo.status).toBe(201)
		const session = await createResource<SessionResource>("/v1/sessions", {
			agent: agentId,
			environment_id: environmentId,
			resources: [{ type: "memory_store", memory_store_id: store.id }],
		})
		const reads = new Map([
			["Read the todo.", "/mnt/memory/shapes/notes/todo.md"],
			["Read the notes.", "/mnt/memory/shapes/notes"],
		])
		fakeOpenAI.setHandler((req) =>
			req.toolOutputs.length === 0
				? {
						kind: "tool_call",
						name: "read",
						arguments: { path: reads.get(req.lastUserText) ?? "/missing" },
					}
				: { kind: "reply", text: `Done: ${req.toolOutputs.join(" | ")}` },
		)
		expect(await replyAfterTurn(session.id, "Read the todo.", 1)).toContain(
			"A file in a directory.",
		)

		expect((await apiJson(`${memories}/${todo.body.id}`, { method: "DELETE" })).status).toBe(200)
		const notes = await apiJson(memories, {
			method: "POST",
			body: { path: "/notes", content: "Now the directory is a file." },
		})
		expect(notes.status).toBe(201)
		expect(await replyAfterTurn(session.id, "Read the notes.", 2)).toContain(
			"Now the directory is a file.",
		)
		expect(await storedMemories(store.id)).toEqual({ "/notes": "Now the directory is a file." })
	}, 120_000)
})
