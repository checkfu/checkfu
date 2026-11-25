import { spawn } from "node:child_process"
import { createHash, createHmac } from "node:crypto"
import type { ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	API_WORKER_BUDGET,
	EAGER_BYTES_HELP,
	describeEager,
	HARNESS_SOURCES_HELP,
	CONTENT_WORKER_BUDGET,
	PI_HARNESS_WORKER_BUDGET,
	STARTUP_HELP,
	measureBundle,
} from "./BundleBudget.ts"
import { removeStage } from "./StageCleanup.ts"
import { startFakeGitHubServer } from "./FakeGitHubServer.ts"
import type { FakeGitHubServer } from "./FakeGitHubServer.ts"
import { startFakeOpenAIResponsesServer } from "./FakeOpenAIResponsesServer.ts"
import type { FakeOpenAIAction, FakeOpenAIResponsesServer } from "./FakeOpenAIResponsesServer.ts"

const REPO_ROOT = resolve(import.meta.dirname, "../../../..")
const TEST_API_KEY = "ck_workerd_test_key"
const TEST_OPENAI_KEY = "sk-workerd-fake-key"
const TEST_ANTHROPIC_KEY = "sk-ant-workerd-fake-key"
const TEST_GITHUB_TOKEN = "ghp_workerd_fake_token"
const AUTH_HEADERS = {
	authorization: `Bearer ${TEST_API_KEY}`,
}

interface SessionResource {
	readonly id: string
	readonly status: string
	readonly turn: number
	readonly archived_at: string | null
}

interface SessionEventItem {
	readonly id: string
	readonly seq: number
	readonly type: string
	readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
	readonly is_error?: boolean
	readonly model_usage?: { readonly input_tokens: number; readonly output_tokens: number }
	readonly stop_reason?: { readonly type: string }
}

const LOCAL_R2_ACCESS_KEY = "alchemy-local-r2"
const LOCAL_R2_SECRET_KEY = "alchemy-local-r2-secret"

const sha256Hex = (data: string) => createHash("sha256").update(data).digest("hex")
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest()

const localR2 = (baseUrl: string, method: string, bucket: string, key: string, body = "") => {
	const url = new URL(`${baseUrl}/cdn-cgi/local/r2/s3/${bucket}/${key}`)
	const amzDate = new Date()
		.toISOString()
		.replaceAll(/[-:]/gu, "")
		.replace(/\.\d{3}/u, "")
	const day = amzDate.slice(0, 8)
	const payloadHash = sha256Hex(body)
	const signedHeaders = "host;x-amz-content-sha256;x-amz-date"
	const canonical = [
		method,
		url.pathname,
		"",
		`host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
		signedHeaders,
		payloadHash,
	].join("\n")
	const scope = `${day}/auto/s3/aws4_request`
	const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n")
	const signingKey = ["auto", "s3", "aws4_request"].reduce<Buffer>(
		(key, part) => hmac(key, part),
		hmac(`AWS4${LOCAL_R2_SECRET_KEY}`, day),
	)
	const signature = hmac(signingKey, toSign).toString("hex")
	return fetch(url, {
		method,
		headers: {
			"x-amz-content-sha256": payloadHash,
			"x-amz-date": amzDate,
			authorization: `AWS4-HMAC-SHA256 Credential=${LOCAL_R2_ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
		},
		...(method === "PUT" ? { body } : {}),
	})
}

const artifactBucketName = (stage: string): string => {
	const saved = JSON.parse(
		readFileSync(
			join(REPO_ROOT, ".alchemy", "state", "Checkfu", stage, "ArtifactBucket.json"),
			"utf8",
		),
	) as { readonly attr?: { readonly bucketName?: unknown } }
	const name = saved.attr?.bucketName
	if (typeof name !== "string") {
		throw new Error(`No bucket name in the ArtifactBucket state: ${JSON.stringify(saved)}`)
	}
	return name
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms)
	})

const parseResponseJson = <T>(method: string, path: string, status: number, raw: string): T => {
	try {
		return JSON.parse(raw) as T
	} catch {
		throw new Error(`${method} ${path} returned non-JSON body (status=${status}): ${raw}`)
	}
}

interface ChildState {
	spawnError: Error | null
}

const waitForExit = (child: ChildProcess, timeoutMs: number): Promise<boolean> => {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve(true)
	}
	return new Promise((resolveExit) => {
		const timer = setTimeout(() => {
			child.off("exit", onExit)
			resolveExit(false)
		}, timeoutMs)
		const onExit = () => {
			clearTimeout(timer)
			resolveExit(true)
		}
		child.once("exit", onExit)
	})
}

const killProcessTree = (pid: number, signal: NodeJS.Signals): void => {
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, signal)
			return
		} catch {
			try {
				process.kill(pid, signal)
			} catch {
				return
			}
			return
		}
	}
	try {
		process.kill(pid, signal)
	} catch {
		return
	}
}

const stopProcessByPid = async (child: ChildProcess): Promise<void> => {
	const pid = child.pid
	if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
		return
	}
	try {
		process.kill(pid, "SIGTERM")
	} catch {
		return
	}
	const exited = await waitForExit(child, 10_000)
	if (!exited) {
		killProcessTree(pid, "SIGKILL")
		await waitForExit(child, 5000)
	}
}

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const ANSI_ESCAPE_RE = new RegExp(
	`${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${BEL}]*(?:${BEL}|${ESC}\\\\))`,
	"g",
)

const stripAnsi = (text: string): string => text.replaceAll(ANSI_ESCAPE_RE, "")

const WORKERS = ["ApiWorker", "PiHarnessWorker"] as const

const boundNames = (stage: string, worker: (typeof WORKERS)[number]): ReadonlyArray<string> => {
	const saved = JSON.parse(
		readFileSync(join(REPO_ROOT, ".alchemy", "state", "Checkfu", stage, `${worker}.json`), "utf8"),
	) as { readonly props?: { readonly env?: object } }
	return Object.keys(saved.props?.env ?? {})
}

const startAlchemyDev = async (
	openAIBaseUrl: string,
	gitHubBaseUrl: string,
	stage = `wd-${process.pid.toString(36)}-${Date.now().toString(36).slice(-4)}`,
) => {
	const envDir = mkdtempSync(join(tmpdir(), `checkfu-${stage}-`))
	const envFile = join(envDir, "test.env")
	try {
		writeFileSync(
			envFile,
			[
				`CHECKFU_API_KEY=${TEST_API_KEY}`,
				`OPENAI_API_KEY=${TEST_OPENAI_KEY}`,
				`ANTHROPIC_API_KEY=${TEST_ANTHROPIC_KEY}`,
				`CHECKFU_OPENAI_BASE_URL=${openAIBaseUrl}`,
				"CHECKFU_PUBLISH_DOMAIN=pages.example",
				"CHECKFU_API_DOMAIN=none",
				"CHECKFU_MCP_DOMAIN=none",
				`CHECKFU_GITHUB_BASE_URL=${gitHubBaseUrl}`,
				"",
			].join("\n"),
			{ flag: "wx", mode: 0o600 },
		)
	} catch (error) {
		rmSync(envDir, { recursive: true, force: true })
		throw error
	}

	const childEnv = { ...process.env }
	delete childEnv.CHECKFU_API_KEY
	delete childEnv.OPENAI_API_KEY
	delete childEnv.ANTHROPIC_API_KEY
	delete childEnv.CHECKFU_OPENAI_BASE_URL
	delete childEnv.CHECKFU_PUBLISH_DOMAIN
	delete childEnv.CHECKFU_API_DOMAIN
	delete childEnv.CHECKFU_MCP_DOMAIN
	delete childEnv.CHECKFU_GITHUB_BASE_URL
	delete childEnv.CHECKFU_LOCAL_DEV
	delete childEnv.ALCHEMY_STAGE
	delete childEnv.ALCHEMY_PROFILE

	const alchemyBin = join(REPO_ROOT, "node_modules", ".bin", "alchemy")
	let child: ChildProcess
	try {
		child = spawn(alchemyBin, ["dev", "--stage", stage, "--no-input", "--env-file", envFile], {
			cwd: REPO_ROOT,
			env: childEnv,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		})
	} catch (error) {
		rmSync(envDir, { recursive: true, force: true })
		throw error
	}

	const logs: Array<string> = []
	let readyUrl: string | null = null
	let resolveReady!: (url: string) => void
	let rejectReady!: (err: Error) => void
	const ready = new Promise<string>((res, rej) => {
		resolveReady = res
		rejectReady = rej
	})

	const inspectLine = (line: string) => {
		if (readyUrl !== null) {
			return
		}
		const clean = stripAnsi(line)
		const match = clean.match(/\[ApiWorker\] ready at (http:\/\/[^\s]+)/)
		if (match?.[1] !== undefined) {
			readyUrl = match[1].replace(/\/+$/, "")
			resolveReady(readyUrl)
		}
	}

	const makeLineListener = () => {
		let pending = ""
		return {
			onData: (chunk: Buffer) => {
				const text = chunk.toString("utf8")
				logs.push(text)
				pending += text
				const lines = pending.split(/\r?\n/)
				pending = lines.pop() ?? ""
				for (const line of lines) {
					inspectLine(line)
				}
			},
			onEnd: () => {
				if (pending.length > 0) {
					inspectLine(pending)
					pending = ""
				}
			},
		}
	}

	const stdoutListener = makeLineListener()
	const stderrListener = makeLineListener()
	const childState: ChildState = { spawnError: null }
	child.on("error", (err) => {
		childState.spawnError = err
		if (readyUrl === null) {
			rejectReady(new Error(`Failed to spawn alchemy dev: ${err.message}\n${logs.join("")}`))
		}
	})
	child.stdout?.on("data", stdoutListener.onData)
	child.stdout?.on("end", stdoutListener.onEnd)
	child.stderr?.on("data", stderrListener.onData)
	child.stderr?.on("end", stderrListener.onEnd)
	child.once("exit", (code, signal) => {
		if (readyUrl === null) {
			rejectReady(
				new Error(
					`alchemy dev exited before ready (code=${String(code)}, signal=${String(signal)})\n${logs.join("")}`,
				),
			)
		}
	})

	const startupTimer = setTimeout(() => {
		if (readyUrl === null) {
			rejectReady(new Error(`Timed out waiting for alchemy dev\n${logs.join("")}`))
		}
	}, 45_000)

	const halt = async () => {
		clearTimeout(startupTimer)
		await stopProcessByPid(child)
		rmSync(envDir, { recursive: true, force: true })
	}
	const stop = async () => {
		await halt()
		removeStage(join(REPO_ROOT, ".alchemy"), "Checkfu", stage)
	}

	try {
		const baseUrl = await ready
		clearTimeout(startupTimer)
		const healthDeadline = Date.now() + 10_000
		while (Date.now() < healthDeadline) {
			if (childState.spawnError !== null) {
				throw new Error(`alchemy dev errored during health probe: ${childState.spawnError.message}`)
			}
			if (child.exitCode !== null || child.signalCode !== null) {
				throw new Error(
					`alchemy dev exited before /health became ready (code=${String(child.exitCode)}, signal=${String(child.signalCode)})\n${logs.join("")}`,
				)
			}
			const remainingMs = healthDeadline - Date.now()
			if (remainingMs <= 0) {
				break
			}
			try {
				const res = await fetch(`${baseUrl}/health`, {
					signal: AbortSignal.timeout(Math.min(2000, remainingMs)),
				})
				void res.body?.cancel().catch(() => undefined)
				if (res.status === 200) {
					return { baseUrl, logs, stage, stop, halt }
				}
			} catch {
				const sleepMs = Math.min(100, healthDeadline - Date.now())
				if (sleepMs > 0) {
					await sleep(sleepMs)
				}
				continue
			}
			const sleepMs = Math.min(100, healthDeadline - Date.now())
			if (sleepMs > 0) {
				await sleep(sleepMs)
			}
		}
		throw new Error(`Worker at ${baseUrl} did not respond 200 on /health\n${logs.join("")}`)
	} catch (error) {
		await stop()
		throw error
	}
}

describe("PiSession real Durable Object under workerd", () => {
	let fakeOpenAI: FakeOpenAIResponsesServer
	let fakeGitHub: FakeGitHubServer
	let baseUrl: string
	let stage: string
	let stopWorker: (() => Promise<void>) | undefined
	let haltWorker: (() => Promise<void>) | undefined
	let workerLogs: ReadonlyArray<string> = []
	let workerStage: string
	let agentId: string
	let environmentId: string

	const apiFetch = async (
		path: string,
		init?: { readonly method?: string; readonly body?: unknown },
	): Promise<Response> => {
		const headers = {
			...AUTH_HEADERS,
			...(init?.body === undefined ? {} : { "content-type": "application/json" }),
		}
		return fetch(`${baseUrl}${path}`, {
			method: init?.method ?? "GET",
			headers,
			...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		})
	}

	const apiJson = async <T>(
		path: string,
		init?: { readonly method?: string; readonly body?: unknown },
	): Promise<{ readonly status: number; readonly body: T }> => {
		const res = await apiFetch(path, init)
		const body = (await res.json()) as T
		return { status: res.status, body }
	}

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
			agent: agentId,
			environment_id: environmentId,
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
		await waitForSession(sessionId, (s) => s.status === "idle" && s.turn === number, 60_000)
		const replies = (await listAllEvents(sessionId)).filter((e) => e.type === "agent.message")
		return replies.at(-1)?.content?.[0]?.text ?? ""
	}

	beforeAll(async () => {
		fakeOpenAI = await startFakeOpenAIResponsesServer((req) => ({
			kind: "reply",
			text: `Echo: ${req.lastUserText}`,
			inputTokens: 17,
			outputTokens: 9,
		}))

		fakeGitHub = await startFakeGitHubServer([
			{ name: "acme/api", files: { "README.md": "# Acme API\n" }, token: TEST_GITHUB_TOKEN },
			{ name: "acme/secret", files: { "KEYS.md": "do not read\n" }, token: "ghp_another_token" },
		])

		const worker = await startAlchemyDev(fakeOpenAI.baseUrl, fakeGitHub.baseUrl)
		baseUrl = worker.baseUrl
		stage = worker.stage
		stopWorker = worker.stop
		haltWorker = worker.halt
		workerLogs = worker.logs
		workerStage = worker.stage

		const createdAgent = await createResource<{ readonly id: string }>(
			"/v1/agents",
			{
				name: "Workerd Test Agent",
				model: "gpt-4o-mini",
				system: "Remember facts from earlier turns.",
			},
			{ retryTransient503: true },
		)
		agentId = createdAgent.id

		const createdEnv = await createResource<{ readonly id: string }>("/v1/environments", {
			name: "Workerd Test Env",
		})
		environmentId = createdEnv.id
	}, 90_000)

	afterAll(async () => {
		await stopWorker?.()
		await fakeOpenAI?.close()
		await fakeGitHub?.close()
	}, 30_000)

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

	it("keeps the code every isolate loads at start-up inside its budget", async () => {
		for (const [worker, budget] of [
			["ApiWorker", API_WORKER_BUDGET],
			["ContentWorker", CONTENT_WORKER_BUDGET],
			["PiHarnessWorker", PI_HARNESS_WORKER_BUDGET],
		] as const) {
			const measured = await measureBundle(
				join(REPO_ROOT, ".alchemy", "bundles", `Checkfu-${stage}-${worker}`),
				`${worker}.js`,
			)
			const found = `${worker} measured ${JSON.stringify(measured)}`
			expect(
				measured.eagerBytes,
				`${EAGER_BYTES_HELP}\n${describeEager(worker, measured)}`,
			).toBeLessThanOrEqual(budget.eagerBytes)
			expect(measured.totalBytes, found).toBeLessThanOrEqual(budget.totalBytes)
			expect(measured.startupCpuMs, `${STARTUP_HELP} ${found}`).toBeLessThanOrEqual(
				budget.startupCpuMs,
			)
			if (worker === "PiHarnessWorker") {
				expect(measured.harnessSources.length).toBeGreaterThan(0)
			} else {
				expect(measured.harnessSources, HARNESS_SOURCES_HELP).toEqual([])
			}
		}
	}, 60_000)

	it("binds provider keys only to the harness Worker and the API key only to the API Worker", () => {
		const api = boundNames(stage, "ApiWorker")
		const harness = boundNames(stage, "PiHarnessWorker")
		expect(api).toContain("CHECKFU_API_KEY")
		expect(api).not.toContain("OPENAI_API_KEY")
		expect(api).not.toContain("ANTHROPIC_API_KEY")
		expect(harness).toContain("OPENAI_API_KEY")
		expect(harness).toContain("ANTHROPIC_API_KEY")
		expect(harness).not.toContain("CHECKFU_API_KEY")
	})

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
			"git",
		])
		expect(requests[3]?.toolOutputs.join("")).toContain("PAPAYA-7")

		const events = await listAllEvents(session.id)
		expect(events.map((e) => e.type)).toEqual([
			"user.message",
			"session.status_running",
			"span.model_request_start",
			"agent.message",
			"span.model_request_end",
			"session.status_idle",
			"user.message",
			"session.status_running",
			"span.model_request_start",
			"agent.message",
			"span.model_request_end",
			"session.status_idle",
		])
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
	it("clones a private repository with its token, lets the agent commit and push, and reaches no other repository", async () => {
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
						name: "git",
						arguments: { args: ["add", "CHANGELOG.md"], cwd: repo },
					},
					{
						kind: "tool_call",
						name: "git",
						arguments: { args: ["commit", "-m", "Add changelog"], cwd: repo },
					},
					{
						kind: "tool_call",
						name: "git",
						arguments: { args: ["push", "origin", "main"], cwd: repo },
					},
				],
				"Clone the secret repository.": [
					{
						kind: "tool_call",
						name: "git",
						arguments: {
							args: ["clone", "https://github.com/acme/secret", "/workspace/secret"],
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

		expect(await turn("Read the readme.", 1)).toContain("# Acme API")
		const basic = `Basic ${Buffer.from(`x-access-token:${TEST_GITHUB_TOKEN}`).toString("base64")}`
		expect(fakeGitHub.requests.length).toBeGreaterThan(0)
		expect(fakeGitHub.requests.map((request) => request.authorization)).toEqual(
			fakeGitHub.requests.map(() => basic),
		)
		expect(fakeGitHub.requests.map((request) => request.status)).toEqual(
			fakeGitHub.requests.map(() => 200),
		)

		await turn("Add a changelog and push it.", 2)
		expect(
			fakeGitHub.git("acme/api", "log", "--format=%s|%an|%ae", "main").trim().split("\n"),
		).toEqual(["Add changelog|Checkfu|agent@checkfu.com", "Initial commit|Owner|owner@example.com"])
		expect(fakeGitHub.git("acme/api", "show", "main:CHANGELOG.md")).toBe("## 1.0.1\n")

		const refusal = await turn("Clone the secret repository.", 3)
		expect(refusal).toContain("Done: ")
		expect(refusal).not.toBe("Done: ")
		expect(
			fakeGitHub.requests.filter((request) => request.path.startsWith("/acme/secret")),
		).toEqual([])

		const requests = fakeOpenAI.requests.slice(startCount)
		expect(requests[0]?.toolNames).toContain("git")
		expect(
			requests[0]?.messages.some((message) =>
				message.text.includes(`- ${repo}: https://github.com/acme/api (default branch)`),
			),
		).toBe(true)
		expect(JSON.stringify(requests.map((request) => request.body))).not.toContain(TEST_GITHUB_TOKEN)
		expect(JSON.stringify(requests.map((request) => request.body))).not.toContain(basic)
	}, 180_000)

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
						name: "git",
						arguments: { args: ["log", "--format=%H %s"], cwd: repo },
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
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 60_000)
		const reply = (await listAllEvents(session.id)).find((e) => e.type === "agent.message")
		expect(reply?.content?.[0]?.text).toBe(`Log: ${pinned} Pinned\n`)
	}, 120_000)

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
					{
						kind: "tool_call",
						name: "git",
						arguments: { args: ["init"], cwd: "/mnt/memory/handbook" },
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
		expect(refused.split("The memory store handbook is read-only.").length - 1).toBe(3)
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

	it("reaches memory stores in a turn Pi resumes after the Workers restart mid-turn", async () => {
		const store = await createResource<{ readonly id: string }>("/v1/memory_stores", {
			name: "Journal",
		})
		const session = await createResource<SessionResource>("/v1/sessions", {
			agent: agentId,
			environment_id: environmentId,
			resources: [{ type: "memory_store", memory_store_id: store.id }],
		})
		const prompt = "Keep a journal across the restart."
		let restarted = false
		const steps: ReadonlyArray<FakeOpenAIAction> = [
			{
				kind: "tool_call",
				name: "write",
				arguments: { path: "/mnt/memory/journal/before.md", content: "Written before." },
			},
			{
				kind: "tool_call",
				name: "write",
				arguments: { path: "/mnt/memory/journal/after.md", content: "Written after." },
			},
			{ kind: "tool_call", name: "read", arguments: { path: "/mnt/memory/journal/before.md" } },
		]
		fakeOpenAI.setHandler((req) => {
			if (req.lastUserText !== prompt) {
				return { kind: "reply", text: "unexpected" }
			}
			if (req.toolOutputs.length === 1 && !restarted) {
				return { kind: "hold" }
			}
			return (
				steps[req.toolOutputs.length] ?? {
					kind: "reply",
					text: `Done: ${req.toolOutputs.join(" | ")}`,
				}
			)
		})

		const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: { events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }] },
		})
		expect(sent.status).toBe(200)
		await fakeOpenAI.waitForRequest(
			(req) => req.lastUserText === prompt && req.toolOutputs.length === 1,
			30_000,
		)

		await haltWorker?.()
		restarted = true
		const worker = await startAlchemyDev(fakeOpenAI.baseUrl, fakeGitHub.baseUrl, stage)
		baseUrl = worker.baseUrl
		stopWorker = worker.stop
		haltWorker = worker.halt
		workerLogs = worker.logs

		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 120_000)
		const reply = (await listAllEvents(session.id)).filter((e) => e.type === "agent.message").at(-1)
			?.content?.[0]?.text
		expect(reply).toContain("Written before.")
		expect(await storedMemories(store.id)).toEqual({
			"/after.md": "Written after.",
			"/before.md": "Written before.",
		})
	}, 240_000)

	it("interrupts a running turn and answers the message queued behind it", async () => {
		const holdPrompt = "hold-for-interrupt"
		const queuedPrompt = "queued-after-interrupt"

		fakeOpenAI.setHandler((req) => {
			if (req.lastUserText === holdPrompt) {
				return { kind: "hold" }
			}
			return {
				kind: "reply",
				text: `Answered queued: ${req.lastUserText}`,
				inputTokens: 15,
				outputTokens: 8,
			}
		})

		const session = await createSession()

		const startRes = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: {
				events: [{ type: "user.message", content: [{ type: "text", text: holdPrompt }] }],
			},
		})
		expect(startRes.status).toBe(200)

		const heldRequest = await fakeOpenAI.waitForRequest((req) => req.lastUserText === holdPrompt)

		const queuedRes = await apiJson<{ readonly data: ReadonlyArray<{ readonly turn: number }> }>(
			`/v1/sessions/${session.id}/events`,
			{
				method: "POST",
				body: {
					events: [{ type: "user.message", content: [{ type: "text", text: queuedPrompt }] }],
				},
			},
		)
		expect(queuedRes.status).toBe(200)
		expect(queuedRes.body.data[0]?.turn).toBe(2)

		const interruptRes = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: {
				events: [{ type: "user.interrupt" }],
			},
		})
		expect(interruptRes.status).toBe(200)

		await Promise.race([
			heldRequest.waitAborted,
			sleep(15_000).then(() => {
				throw new Error("Timed out waiting for held OpenAI request to abort on user.interrupt")
			}),
		])

		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 2)

		const events = await listAllEvents(session.id)
		expect(events.map((e) => e.type)).toEqual([
			"user.message",
			"session.status_running",
			"span.model_request_start",
			"user.message",
			"user.interrupt",
			"span.model_request_end",
			"session.status_idle",
			"session.status_running",
			"span.model_request_start",
			"agent.message",
			"span.model_request_end",
			"session.status_idle",
		])

		const idleEvents = events.filter((e) => e.type === "session.status_idle")
		expect(idleEvents.map((e) => e.stop_reason)).toEqual([
			{ type: "interrupted" },
			{ type: "end_turn" },
		])
		expect(events.find((e) => e.type === "agent.message")?.content).toEqual([
			{ type: "text", text: `Answered queued: ${queuedPrompt}` },
		])

		const turn2Request = fakeOpenAI.requests.find((req) => req.lastUserText === queuedPrompt)
		expect(turn2Request?.userTexts).toEqual([queuedPrompt])
	}, 30_000)

	it("streams committed events over SSE as they happen, resumes from a cursor and ends on archive", async () => {
		fakeOpenAI.setHandler(() => ({
			kind: "reply",
			text: "Streamed.",
			inputTokens: 5,
			outputTokens: 3,
		}))
		const session = await createSession()
		const streamPath = `/v1/sessions/${session.id}/events/stream`

		const openStream = async (lastEventId?: string) => {
			const res = await fetch(`${baseUrl}${streamPath}`, {
				headers: {
					...AUTH_HEADERS,
					...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
				},
			})
			const reader = res.body?.getReader()
			const decoder = new TextDecoder()
			let buffer = ""
			const next = async (): Promise<{ id: string; event: string } | null> => {
				while (reader !== undefined) {
					const boundary = buffer.indexOf("\n\n")
					if (boundary >= 0) {
						const block = buffer.slice(0, boundary)
						buffer = buffer.slice(boundary + 2)
						const field = (name: string) =>
							block
								.split("\n")
								.find((line) => line.startsWith(`${name}: `))
								?.slice(name.length + 2)
						const id = field("id")
						const event = field("event")
						if (id !== undefined && event !== undefined) {
							return { id, event }
						}
						continue
					}
					const chunk = await reader.read()
					if (chunk.done) {
						return null
					}
					buffer += decoder.decode(chunk.value, { stream: true })
				}
				return null
			}
			const until = async (type: string, timeoutMs = 15_000) => {
				const frames: Array<{ id: string; event: string }> = []
				const read = (async () => {
					for (;;) {
						const frame = await next()
						if (frame === null) {
							throw new Error(`SSE ended before ${type}: ${JSON.stringify(frames)}`)
						}
						frames.push(frame)
						if (frame.event === type) {
							return frames
						}
					}
				})()
				return Promise.race([
					read,
					sleep(timeoutMs).then(() => {
						throw new Error(`Timed out waiting for ${type}: ${JSON.stringify(frames)}`)
					}),
				])
			}
			return { res, next, until, cancel: () => reader?.cancel() }
		}

		const live = await openStream()
		expect(live.res.status).toBe(200)
		expect(live.res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
		await sleep(500)

		const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: { events: [{ type: "user.message", content: [{ type: "text", text: "stream me" }] }] },
		})
		expect(sent.status).toBe(200)
		const turn = await live.until("session.status_idle")
		expect(turn.map((frame) => frame.event)).toEqual([
			"user.message",
			"session.status_running",
			"span.model_request_start",
			"agent.message",
			"span.model_request_end",
			"session.status_idle",
		])
		expect(turn.map((frame) => Number(frame.id))).toEqual([1, 2, 3, 4, 5, 6])
		await live.cancel()

		const resumed = await openStream("2")
		expect(resumed.res.status).toBe(200)
		const rest = await resumed.until("session.status_idle")
		expect(rest.map((frame) => frame.id)).toEqual(["3", "4", "5", "6"])

		const ahead = await openStream("100")
		expect(ahead.res.status).toBe(200)

		const archiveRes = await apiFetch(`/v1/sessions/${session.id}/archive`, { method: "POST" })
		expect([200, 202]).toContain(archiveRes.status)
		const ending = await resumed.until("session.archived")
		expect(ending.at(-1)?.event).toBe("session.archived")
		expect(await resumed.next()).toBeNull()
		expect(
			await Promise.race([ahead.next(), sleep(15_000).then(() => "still open after archive")]),
		).toBeNull()

		const caughtUp = await openStream(ending.at(-1)?.id)
		expect(caughtUp.res.status).toBe(204)
	}, 60_000)

	it("stops a running turn when the session is archived", async () => {
		const holdPrompt = "hold-for-archive"

		fakeOpenAI.setHandler((req) => {
			if (req.lastUserText === holdPrompt) {
				return { kind: "hold" }
			}
			return { kind: "reply", text: "unexpected" }
		})

		const session = await createSession()

		const startRes = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: {
				events: [{ type: "user.message", content: [{ type: "text", text: holdPrompt }] }],
			},
		})
		expect(startRes.status).toBe(200)

		const heldRequest = await fakeOpenAI.waitForRequest((req) => req.lastUserText === holdPrompt)

		const archiveRes = await apiFetch(`/v1/sessions/${session.id}/archive`, {
			method: "POST",
		})
		const archiveRaw = await archiveRes.text()
		const archived =
			archiveRes.status === 200
				? parseResponseJson<SessionResource>(
						"POST",
						`/v1/sessions/${session.id}/archive`,
						archiveRes.status,
						archiveRaw,
					)
				: archiveRes.status === 202
					? await waitForSession(
							session.id,
							(s) => s.status === "terminated" && s.archived_at !== null,
						)
					: (() => {
							throw new Error(
								`POST /v1/sessions/${session.id}/archive failed (status=${archiveRes.status}): ${archiveRaw}`,
							)
						})()
		expect(archived.status).toBe("terminated")
		expect(archived.archived_at).not.toBeNull()

		await Promise.race([
			heldRequest.waitAborted,
			sleep(15_000).then(() => {
				throw new Error("Timed out waiting for held OpenAI request to abort on archive")
			}),
		])

		const events = await listAllEvents(session.id)
		expect(events.map((e) => e.type)).toEqual([
			"user.message",
			"session.status_running",
			"span.model_request_start",
			"span.model_request_end",
			"session.status_terminated",
			"session.archived",
		])
		expect(events.some((e) => e.type === "agent.message")).toBe(false)

		const afterArchive = await apiFetch(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: {
				events: [{ type: "user.message", content: [{ type: "text", text: "after-archive" }] }],
			},
		})
		expect(afterArchive.status).toBe(409)

		const recorded = (message: string) =>
			stripAnsi(workerLogs.join(""))
				.split("\n")
				.some((line) => line.includes(message) && line.includes(session.id))
		const discardDeadline = Date.now() + 10_000
		while (!recorded("Workspace discarded") && Date.now() < discardDeadline) {
			await sleep(100)
		}
		expect(recorded("Workspace discarded")).toBe(true)
		expect(recorded("Workspace not discarded")).toBe(false)
	}, 30_000)

	it("stores artifact versions in R2, reads them back, and removes them on delete", async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]).toString("base64")
		const created = await apiJson<{
			readonly id: string
			readonly version: number
			readonly files: ReadonlyArray<{
				readonly path: string
				readonly content_type: string
				readonly sha256: string
			}>
		}>("/v1/artifacts", {
			method: "POST",
			body: {
				name: "Workerd Artifact",
				files: [
					{ path: "index.html", content: "<h1>one</h1>" },
					{ path: "img/dot.png", content: png, encoding: "base64" },
				],
			},
		})
		expect(created.status).toBe(201)
		expect(created.body.version).toBe(1)
		expect(created.body.files).toMatchObject([
			{ path: "img/dot.png", content_type: "image/png" },
			{ path: "index.html", content_type: "text/html" },
		])
		const id = created.body.id
		const bucket = artifactBucketName(workerStage)
		const storedBlob = () =>
			localR2(
				baseUrl,
				"GET",
				bucket,
				`artifacts/default/${id}/blobs/${created.body.files[0]?.sha256 ?? ""}`,
			)
		expect((await storedBlob()).status).toBe(200)

		const addVersion = (version: number, files: ReadonlyArray<Record<string, string>>) =>
			apiJson<{ readonly version: number }>(`/v1/artifacts/${id}/versions`, {
				method: "POST",
				body: { version, files },
			})
		const dot = { path: "img/dot.png", content: png, encoding: "base64" }
		const added = await addVersion(1, [{ path: "index.html", content: "<h1>two</h1>" }, dot])
		expect(added.status).toBe(201)
		expect(added.body.version).toBe(2)
		const third = await addVersion(2, [{ path: "about.html", content: "<h1>three</h1>" }, dot])
		expect(third.status).toBe(201)
		expect(third.body.version).toBe(3)

		const racing = await Promise.all(
			["left", "right"].map((side) =>
				addVersion(3, [{ path: `${side}.html`, content: side }, dot]),
			),
		)
		expect(racing.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([201, 409])
		const winner = racing[0]?.status === 201 ? "left" : "right"
		const loser = winner === "left" ? "right" : "left"

		const file = (version: number, path: string) =>
			apiJson<{ readonly encoding: string; readonly content: string }>(
				`/v1/artifacts/${id}/versions/${version}/file?path=${encodeURIComponent(path)}`,
			)
		expect((await file(1, "index.html")).body).toMatchObject({
			encoding: "utf8",
			content: "<h1>one</h1>",
		})
		for (const version of [1, 2, 3, 4]) {
			expect((await file(version, "img/dot.png")).body).toMatchObject({
				encoding: "base64",
				content: png,
			})
		}
		expect((await file(2, "index.html")).body).toMatchObject({ content: "<h1>two</h1>" })
		expect((await file(3, "about.html")).body).toMatchObject({ content: "<h1>three</h1>" })
		expect((await file(3, "index.html")).status).toBe(404)
		expect((await file(4, `${winner}.html`)).body).toMatchObject({ content: winner })
		expect((await file(4, `${loser}.html`)).status).toBe(404)
		expect((await apiFetch(`/v1/artifacts/${id}/versions/5`)).status).toBe(404)

		const head = await apiJson<{ readonly version: number; readonly file_count: number }>(
			`/v1/artifacts/${id}`,
		)
		expect(head.body).toMatchObject({ version: 4, file_count: 2 })
		const listedArtifactIds = async () => {
			const res = await apiJson<{ readonly data: ReadonlyArray<{ readonly id: string }> }>(
				"/v1/artifacts?limit=100",
			)
			expect(res.status).toBe(200)
			return res.body.data.map((artifact) => artifact.id)
		}
		const deadline = Date.now() + 20_000
		while (!(await listedArtifactIds()).includes(id) && Date.now() < deadline) {
			await sleep(200)
		}
		expect(await listedArtifactIds()).toContain(id)

		const deleted = await apiFetch(`/v1/artifacts/${id}`, { method: "DELETE" })
		expect(deleted.status).toBe(200)
		const gone = Date.now() + 20_000
		while ((await listedArtifactIds()).includes(id) && Date.now() < gone) {
			await sleep(200)
		}
		expect(await listedArtifactIds()).not.toContain(id)
		expect((await apiFetch(`/v1/artifacts/${id}`)).status).toBe(404)
		expect((await file(1, "index.html")).status).toBe(404)
		expect((await storedBlob()).status).toBe(404)
		expect((await apiFetch(`/v1/artifacts/${id}`, { method: "DELETE" })).status).toBe(200)
	}, 60_000)

	it("lists an unconfirmed-write marker from the real bucket and leaves a young one alone", async () => {
		const bucket = artifactBucketName(workerStage)
		const key = "reconcile/default/art_workerd_marker/write_young"
		const marker = JSON.stringify({
			artifact_id: "art_workerd_marker",
			write_id: "write_young",
			check: { kind: "create", manifest: "0".repeat(64) },
		})
		const put = await localR2(baseUrl, "PUT", bucket, key, marker)
		expect(put.status, await put.text()).toBe(200)
		const fired = await fetch(
			`${baseUrl}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("*/15 * * * *")}`,
		)
		expect(fired.status, await fired.text()).toBe(200)
		const kept = await localR2(baseUrl, "GET", bucket, key)
		expect(kept.status).toBe(200)
		expect(await kept.text()).toBe(marker)
		expect(workerLogs.join("")).not.toContain("Artifact write reconciliation failed")
	}, 30_000)

	it("opens an artifact through a viewing link on the content origin until it is deleted", async () => {
		const created = await apiJson<{ readonly id: string }>("/v1/artifacts", {
			method: "POST",
			body: {
				name: "Linked",
				files: [
					{ path: "index.html", content: '<script src="app.js"></script>' },
					{ path: "app.js", content: "document.title = 'ok'" },
				],
			},
		})
		expect(created.status).toBe(201)
		const id = created.body.id
		const link = await apiJson<{ readonly url: string; readonly expires_at: string }>(
			`/v1/artifacts/${id}/versions/1/links`,
			{ method: "POST", body: { expires_in: 120 } },
		)
		expect(link.status).toBe(201)
		const url = new URL(link.body.url)
		expect(url.origin).not.toBe(new URL(baseUrl).origin)

		const page = await fetch(url)
		expect(page.status).toBe(200)
		expect(await page.text()).toBe('<script src="app.js"></script>')
		expect(page.headers.get("content-type")).toContain("text/html")
		expect(page.headers.get("content-security-policy")).toBe(
			"sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock; base-uri 'none'; object-src 'none'; form-action 'none'",
		)
		expect(page.headers.get("referrer-policy")).toBe("no-referrer")
		expect(page.headers.get("x-content-type-options")).toBe("nosniff")
		const etag = page.headers.get("etag") ?? ""
		expect(etag).toMatch(/^"[0-9a-f]{64}-[0-9a-f]{16}"$/)
		const unchanged = await fetch(url, { headers: { "if-none-match": etag } })
		expect(unchanged.status).toBe(304)
		expect(unchanged.headers.get("etag")).toBe(etag)

		const head = await fetch(url, { method: "HEAD" })
		expect(head.status).toBe(200)
		expect(head.headers.get("content-type")).toBe(page.headers.get("content-type"))
		expect(head.headers.get("content-length")).toBe(String('<script src="app.js"></script>'.length))
		expect(await head.text()).toBe("")

		const script = await fetch(new URL("app.js", url))
		expect(script.status).toBe(200)
		expect(await script.text()).toBe("document.title = 'ok'")

		const forged = new URL(url)
		forged.pathname = forged.pathname.replace(/\.(.)/, (_, first: string) =>
			first === "A" ? ".B" : ".A",
		)
		expect((await fetch(forged)).status).toBe(404)
		expect((await fetch(new URL("/v1/artifacts", url))).status).toBe(404)
		expect((await fetch(`${baseUrl}${url.pathname}`)).status).toBe(404)

		expect((await apiFetch(`/v1/artifacts/${id}`, { method: "DELETE" })).status).toBe(200)
		expect((await fetch(url)).status).toBe(404)
	}, 30_000)

	it("publishes an artifact at a public address that follows the latest version or a pinned one", async () => {
		interface Published {
			readonly publication: { readonly url: string; readonly version: number | null } | null
		}
		const created = await apiJson<{ readonly id: string }>("/v1/artifacts", {
			method: "POST",
			body: { name: "Published", files: [{ path: "index.html", content: "first" }] },
		})
		expect(created.status).toBe(201)
		const id = created.body.id
		const published = await apiJson<Published>(`/v1/artifacts/${id}/publication`, {
			method: "POST",
			body: { version: "latest" },
		})
		expect(published.status).toBe(200)
		const publication = published.body.publication
		expect(publication?.version).toBe(null)
		const url = new URL(publication?.url ?? "")
		expect(url.origin).not.toBe(new URL(baseUrl).origin)
		expect(url.pathname).toMatch(/^\/p\/a[0-9a-f]{1,32}-[0-9a-z]{25}\/$/)

		const page = await fetch(url)
		expect(page.status).toBe(200)
		expect(await page.text()).toBe("first")
		expect(page.headers.get("content-security-policy") ?? "").toContain("sandbox")
		expect(page.headers.get("content-security-policy") ?? "").not.toContain("allow-same-origin")

		const added = await apiFetch(`/v1/artifacts/${id}/versions`, {
			method: "POST",
			body: { version: 1, files: [{ path: "index.html", content: "second" }] },
		})
		expect(added.status).toBe(201)
		expect(await (await fetch(url)).text()).toBe("second")

		const pinned = await apiJson<Published>(`/v1/artifacts/${id}/publication`, {
			method: "POST",
			body: { version: 1 },
		})
		expect(pinned.body.publication).toMatchObject({ url: url.href, version: 1 })
		expect(await (await fetch(url)).text()).toBe("first")

		const unpublished = await apiJson<Published>(`/v1/artifacts/${id}/publication`, {
			method: "DELETE",
		})
		expect(unpublished.status).toBe(200)
		expect(unpublished.body.publication).toBe(null)
		expect((await fetch(url)).status).toBe(404)
		expect((await apiFetch(`/v1/artifacts/${id}`)).status).toBe(200)
	}, 30_000)
})
