import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	API_WORKER_BUDGET,
	EAGER_BYTES_HELP,
	HARNESS_SOURCES_HELP,
	PI_HARNESS_WORKER_BUDGET,
	STARTUP_HELP,
	measureBundle,
} from "./BundleBudget.ts"
import { removeStage } from "./StageCleanup.ts"
import { startFakeOpenAIResponsesServer } from "./FakeOpenAIResponsesServer.ts"
import type { FakeOpenAIResponsesServer } from "./FakeOpenAIResponsesServer.ts"

const REPO_ROOT = resolve(import.meta.dirname, "../../../..")
const TEST_API_KEY = "ck_workerd_test_key"
const TEST_OPENAI_KEY = "sk-workerd-fake-key"
const TEST_ANTHROPIC_KEY = "sk-ant-workerd-fake-key"
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

const startAlchemyDev = async (openAIBaseUrl: string) => {
	const stage = `wd-${process.pid.toString(36)}-${Date.now().toString(36).slice(-4)}`
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

	const stop = async () => {
		clearTimeout(startupTimer)
		await stopProcessByPid(child)
		rmSync(envDir, { recursive: true, force: true })
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
					return { baseUrl, logs, stage, stop }
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
	let baseUrl: string
	let stage: string
	let stopWorker: (() => Promise<void>) | undefined
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

	beforeAll(async () => {
		fakeOpenAI = await startFakeOpenAIResponsesServer((req) => ({
			kind: "reply",
			text: `Echo: ${req.lastUserText}`,
			inputTokens: 17,
			outputTokens: 9,
		}))

		const worker = await startAlchemyDev(fakeOpenAI.baseUrl)
		baseUrl = worker.baseUrl
		stage = worker.stage
		stopWorker = worker.stop

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
	}, 30_000)

	it("serves the OpenAPI document as a static asset, without running the Worker", async () => {
		const res = await fetch(`${baseUrl}/openapi.json`)
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8")
		expect(await res.json()).toEqual(
			JSON.parse(readFileSync(join(REPO_ROOT, "apps", "api", "public", "openapi.json"), "utf8")),
		)
		// The Worker stamps every response it handles with a request id.
		expect(res.headers.get("request-id")).toBeNull()
	})

	it("keeps the code every isolate loads at start-up inside its budget", async () => {
		for (const [worker, budget] of [
			["ApiWorker", API_WORKER_BUDGET],
			["PiHarnessWorker", PI_HARNESS_WORKER_BUDGET],
		] as const) {
			const measured = await measureBundle(
				join(REPO_ROOT, ".alchemy", "bundles", `Checkfu-${stage}-${worker}`),
				`${worker}.js`,
			)
			const found = `${worker} measured ${JSON.stringify(measured)}`
			expect(measured.eagerBytes, `${EAGER_BYTES_HELP} ${found}`).toBeLessThanOrEqual(
				budget.eagerBytes,
			)
			expect(measured.totalBytes, found).toBeLessThanOrEqual(budget.totalBytes)
			expect(measured.startupCpuMs, `${STARTUP_HELP} ${found}`).toBeLessThanOrEqual(
				budget.startupCpuMs,
			)
			if (worker === "ApiWorker") {
				expect(measured.harnessSources, HARNESS_SOURCES_HELP).toEqual([])
			} else {
				expect(measured.harnessSources.length).toBeGreaterThan(0)
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
	}, 30_000)
})
