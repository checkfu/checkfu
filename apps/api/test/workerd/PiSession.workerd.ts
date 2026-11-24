import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type * as Schema from "effect/Schema"
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
import { BIG_BODY_BYTES, startFakeHttpApi } from "./FakeHttpApi.ts"
import type { FakeApiAuth, FakeHttpApi } from "./FakeHttpApi.ts"
import { startFakeMcpServer } from "./FakeMcpServer.ts"
import { startFakeOAuthServer } from "./FakeOAuthServer.ts"
import type { FakeMcpServer } from "./FakeMcpServer.ts"
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
	readonly tool_use_id?: string
	readonly parent_tool_use_id?: string
	readonly mcp_server_name?: string
	readonly api_server_name?: string
	readonly name?: string
	readonly input?: Schema.JsonObject
	readonly model_usage?: { readonly input_tokens: number; readonly output_tokens: number }
	readonly stop_reason?: { readonly type: string; readonly event_ids?: ReadonlyArray<string> }
	readonly evaluated_permission?: string
	readonly result?: string
	readonly deny_message?: string
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

const echoScript = (server: string, text: string) =>
	`return await tools.mcp__${server}__echo({ text: ${JSON.stringify(text)} });`

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString()
const aMinuteAgo = () => new Date(Date.now() - 60_000).toISOString()

/** Reads until what is read meets the condition, and returns the last reading either way. */
const eventually = async <A>(read: () => Promise<A>, met: (value: A) => boolean) => {
	const deadline = Date.now() + 15_000
	for (;;) {
		const value = await read()
		if (met(value) || Date.now() > deadline) {
			return value
		}
		await sleep(100)
	}
}

const post = (text: string) => [{ name: "mcp__desk__post", arguments: { text } }]
const echo = (text: string) => [{ name: "mcp__desk__echo", arguments: { text } }]

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

const apiCalls = (events: ReadonlyArray<SessionEventItem>) =>
	events.filter((event) => event.type === "agent.api_tool_use")
const apiResults = (events: ReadonlyArray<SessionEventItem>) =>
	events.filter((event) => event.type === "agent.api_tool_result")
const replyOf = (events: ReadonlyArray<SessionEventItem>) =>
	events.findLast((event) => event.type === "agent.message")?.content?.[0]?.text ?? ""

describe("PiSession real Durable Object under workerd", () => {
	let fakeOpenAI: FakeOpenAIResponsesServer
	let baseUrl: string
	let stage: string
	let stopWorker: (() => Promise<void>) | undefined
	let workerLogs: ReadonlyArray<string> = []
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
		workerLogs = worker.logs

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

	it("runs a script that calls the workspace tools", async () => {
		const script = [
			'await tools.write({ path: "/workspace/notes/script.txt", content: "MANGO-3" });',
			'const text = await tools.read({ path: "/workspace/notes/script.txt" });',
			"return text;",
		].join("\n")
		fakeOpenAI.setHandler((req) => {
			const [output] = req.toolOutputs
			if (req.lastUserText === "Run the script.") {
				return output === undefined
					? { kind: "tool_call", name: "codemode", arguments: { code: script } }
					: { kind: "reply", text: `The script returned: ${output}` }
			}
			return output === undefined
				? { kind: "tool_call", name: "read", arguments: { path: "/workspace/notes/script.txt" } }
				: { kind: "reply", text: `The file says: ${output}` }
		})

		const session = await createSession()
		const send = (text: string) =>
			apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
			})

		expect((await send("Run the script.")).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)
		expect((await send("What is in the script file?")).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 2)

		const events = await listAllEvents(session.id)
		const [ran, read] = events.filter((e) => e.type === "agent.tool_use")
		expect(ran).toMatchObject({ name: "codemode", input: { code: script } })
		expect(read).toMatchObject({ name: "read" })
		const [ranResult, readResult] = events.filter((e) => e.type === "agent.tool_result")
		expect(ranResult).toMatchObject({ tool_use_id: ran?.tool_use_id, is_error: false })
		expect(ranResult?.content?.map((block) => block.text).join("")).toContain("MANGO-3")
		expect(readResult?.content?.map((block) => block.text).join("")).toContain("MANGO-3")
		const replies = events.filter((e) => e.type === "agent.message").map((e) => e.content)
		expect(replies[0]?.[0]?.text).toContain("MANGO-3")
		expect(replies[1]?.[0]?.text).toContain("MANGO-3")
	}, 60_000)

	it("ends a script that never yields and answers the next turn", async () => {
		fakeOpenAI.setHandler((req) => {
			const [output] = req.toolOutputs
			if (req.lastUserText === "Spin forever.") {
				return output === undefined
					? { kind: "tool_call", name: "codemode", arguments: { code: "while (true) {}" } }
					: { kind: "reply", text: "The script did not finish." }
			}
			return { kind: "reply", text: "Still here." }
		})

		const session = await createSession()
		const send = (text: string) =>
			apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
			})

		expect((await send("Spin forever.")).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 60_000)
		expect((await send("Are you there?")).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 2)

		const events = await listAllEvents(session.id)
		const [result] = events.filter((e) => e.type === "agent.tool_result")
		expect(result?.is_error).toBe(true)
		expect(result?.content?.map((block) => block.text).join("")).toContain("timed out")
		expect(events.filter((e) => e.type === "agent.message").map((e) => e.content)).toEqual([
			[{ type: "text", text: "The script did not finish." }],
			[{ type: "text", text: "Still here." }],
		])
	}, 90_000)

	it("keeps a credential's secret in its connection object until the credential ends", async () => {
		const token = "tok_workerd_SECRET_do_not_leak"
		const replacement = "tok_workerd_ROTATED_do_not_leak"
		const vault = await createResource<{ readonly id: string }>("/v1/vaults", {
			display_name: "workerd",
		})
		const credential = await createResource<{ readonly id: string }>(
			`/v1/vaults/${vault.id}/credentials`,
			{
				auth: {
					type: "static_bearer",
					token,
					mcp_server_url: "https://mcp.example.com/mcp",
				},
			},
		)
		const path = `/v1/vaults/${vault.id}/credentials/${credential.id}`
		const rotate = () =>
			apiJson<{ readonly error?: { readonly message: string } }>(path, {
				method: "POST",
				body: { auth: { type: "static_bearer", token: replacement } },
			})

		// Only a connection that holds a secret can have it replaced.
		expect((await rotate()).status).toBe(200)

		const archived = await apiJson<{ readonly archived_at: string | null }>(`${path}/archive`, {
			method: "POST",
		})
		expect(archived.status).toBe(200)
		expect(archived.body.archived_at).not.toBeNull()

		// Archiving erases the secret through a policy, so wait for the erase before rotating: a
		// rotation that races it is refused by the archived credential instead.
		const eraseDeadline = Date.now() + 10_000
		while (
			!stripAnsi(workerLogs.join("")).includes("Credential secret erased") &&
			Date.now() < eraseDeadline
		) {
			await sleep(100)
		}
		expect(stripAnsi(workerLogs.join(""))).toContain("Credential secret erased")
		const afterErase = await rotate()
		expect(afterErase.status).toBe(409)
		expect(afterErase.body.error?.message).toContain("no longer holds a secret")

		const deleted = await apiJson<{ readonly type: string }>(path, { method: "DELETE" })
		expect(deleted).toEqual({
			status: 200,
			body: { id: credential.id, type: "vault_credential_deleted" },
		})
		expect((await apiFetch(path)).status).toBe(404)
		expect((await rotate()).status).toBe(404)

		const logged = stripAnsi(workerLogs.join(""))
		expect(logged).toContain("Credential secret erased")
		expect(logged).toContain(credential.id)
		expect(logged).not.toContain(token)
		expect(logged).not.toContain(replacement)
	}, 30_000)

	const credentialFor = async (url: string, token: string) => {
		const vault = await createResource<{ readonly id: string }>("/v1/vaults", {
			display_name: "mcp",
		})
		const credential = await createResource<{ readonly id: string }>(
			`/v1/vaults/${vault.id}/credentials`,
			{ auth: { type: "static_bearer", token, mcp_server_url: url } },
		)
		return { vault: vault.id, credential: credential.id }
	}

	const agentWith = (name: string, url: string) =>
		createResource<{ readonly id: string }>("/v1/agents", {
			name: `MCP ${name}`,
			model: "gpt-4o-mini",
			mcp_servers: [{ type: "url", name, url }],
		})

	const sender = (sessionId: string) => (text: string) =>
		apiJson(`/v1/sessions/${sessionId}/events`, {
			method: "POST",
			body: { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
		})

	// Every turn: run the script the user message names, then say what it returned.
	const scriptOnRequest = (server: string) => {
		fakeOpenAI.setHandler((req) => {
			const [output] = req.toolOutputs
			return output === undefined
				? {
						kind: "tool_call",
						name: "codemode",
						arguments: { code: echoScript(server, req.lastUserText) },
					}
				: { kind: "reply", text: `Done: ${output}` }
		})
	}

	const agentEvents = async (sessionId: string) =>
		(await listAllEvents(sessionId)).filter((event) => event.type.startsWith("agent."))

	const confirm = (
		sessionId: string,
		tool_use_id: string,
		result: "allow" | "deny",
		deny_message?: string,
	) =>
		apiJson<{ readonly error?: { readonly message: string } }>(`/v1/sessions/${sessionId}/events`, {
			method: "POST",
			body: {
				events: [
					{
						type: "user.tool_confirmation",
						tool_use_id,
						result,
						...(deny_message === undefined ? {} : { deny_message }),
					},
				],
			},
		})

	/** Waits until the session has gone idle `count` times, and returns the last time's reason. */
	const idle = async (sessionId: string, count: number, timeoutMs = 30_000) => {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			const idles = (await listAllEvents(sessionId)).filter(
				(event) => event.type === "session.status_idle",
			)
			if (idles.length >= count) {
				await waitForSession(sessionId, (session) => session.status === "idle")
				return idles[count - 1]?.stop_reason
			}
			await sleep(100)
		}
		throw new Error(`session ${sessionId} did not go idle ${count} time(s)`)
	}

	const sessionFor = async (url: string, tools?: ReadonlyArray<Schema.JsonObject>) => {
		const agent = await createResource<{ readonly id: string; readonly tools?: unknown }>(
			"/v1/agents",
			{
				name: "Approvals",
				model: "gpt-4o-mini",
				mcp_servers: [{ type: "url", name: "desk", url }],
				...(tools === undefined ? {} : { tools }),
			},
		)
		const session = await createResource<SessionResource>("/v1/sessions", {
			agent: agent.id,
			environment_id: environmentId,
		})
		return { agent, session }
	}

	// Finds the tool, calls it as the user message says, then reports what came back.
	const callDirectly = (
		calls: (text: string) => ReadonlyArray<{ name: string; arguments: { text: string } }>,
	) => {
		fakeOpenAI.setHandler((req) => {
			switch (req.toolOutputs.length) {
				case 0:
					return { kind: "tool_call", name: "tool_search", arguments: { query: "post echo" } }
				case 1:
					return { kind: "tool_calls", calls: calls(req.lastUserText) }
				default:
					return { kind: "reply", text: `Done: ${req.toolOutputs.slice(1).join(" | ")}` }
			}
		})
	}

	describe("OAuth credentials", () => {
		const CLIENT_SECRET = "ocs_wd_CLIENT_do_not_leak"
		const closers: Array<() => Promise<void>> = []
		afterAll(async () => {
			await Promise.all(closers.map((close) => close()))
		})

		interface OAuthCredential {
			readonly auth: { readonly expires_at: string | null }
			readonly refresh_failed_at: string | null
		}

		/**
		 * An MCP server that takes one access token at a time, an authorization
		 * server whose every new token becomes that one, and a session bound to a
		 * credential holding the first.
		 */
		const grant = async (label: string) => {
			const access = `oat_wd_${label}_do_not_leak`
			const refresh = `ort_wd_${label}_do_not_leak`
			const mcp = await startFakeMcpServer([access])
			const oauth = await startFakeOAuthServer()
			closers.push(mcp.close, oauth.close)
			oauth.grant(refresh)
			oauth.onIssue((next) => mcp.accept([next]))
			const vault = await createResource<{ readonly id: string }>("/v1/vaults", {
				display_name: `oauth ${label}`,
			})
			const credential = await createResource<{ readonly id: string }>(
				`/v1/vaults/${vault.id}/credentials`,
				{
					auth: {
						type: "mcp_oauth",
						mcp_server_url: mcp.url,
						access_token: access,
						expires_at: inAnHour(),
						refresh: {
							token_endpoint: oauth.tokenEndpoint,
							client_id: "client_wd",
							refresh_token: refresh,
							token_endpoint_auth: { type: "client_secret_post", client_secret: CLIENT_SECRET },
						},
					},
				},
			)
			const agent = await agentWith("desk", mcp.url)
			const session = await createResource<SessionResource>("/v1/sessions", {
				agent: agent.id,
				environment_id: environmentId,
				vault_ids: [vault.id],
			})
			const path = `/v1/vaults/${vault.id}/credentials/${credential.id}`
			const send = sender(session.id)
			const replace = (access_token: string, expires_at: string) =>
				apiJson<OAuthCredential>(path, {
					method: "POST",
					body: { auth: { type: "mcp_oauth", access_token, expires_at } },
				})
			return {
				id: credential.id,
				access,
				refresh,
				mcp,
				oauth,
				session,
				replace,
				read: async () => (await apiJson<OAuthCredential>(path)).body,
				/** Sends a message and waits for the turn it starts to end. */
				turn: async (number: number, text: string) => {
					expect((await send(text)).status).toBe(200)
					await waitForSession(session.id, (s) => s.status === "idle" && s.turn === number)
				},
				/** Fails if any secret this grant ever had is in what a client or an operator can read. */
				expectNoLeak: async () => {
					const readable = JSON.stringify([
						await listAllEvents(session.id),
						(await apiJson(path)).body,
						(await apiJson(`/v1/sessions/${session.id}`)).body,
					])
					const logged = stripAnsi(workerLogs.join(""))
					for (const secret of [access, refresh, CLIENT_SECRET, ...oauth.issued]) {
						expect(readable).not.toContain(secret)
						expect(logged).not.toContain(secret)
					}
				},
			}
		}

		it("uses an access token while it is valid, refreshes it once, and records the new expiry", async () => {
			const g = await grant("valid")
			scriptOnRequest("desk")
			await g.turn(1, "one")
			expect(g.mcp.calls).toEqual([{ tool: "echo", arguments: { text: "one" }, token: g.access }])
			expect(g.oauth.requests).toEqual([])

			expect((await g.replace(g.access, aMinuteAgo())).status).toBe(200)
			await g.turn(2, "two")
			expect(g.oauth.requests).toEqual([
				{
					form: {
						grant_type: "refresh_token",
						refresh_token: g.refresh,
						// The renewed token is asked for the same MCP server the grant was for.
						resource: g.mcp.url,
						client_id: "client_wd",
						client_secret: CLIENT_SECRET,
					},
					authorization: undefined,
				},
			])
			const [issued] = g.oauth.issued
			expect(g.mcp.calls.at(-1)).toEqual({
				tool: "echo",
				arguments: { text: "two" },
				token: issued,
			})

			const recorded = await eventually(
				g.read,
				(seen) => Date.parse(seen.auth.expires_at ?? "") > Date.now() + 50 * 60_000,
			)
			expect(Date.parse(recorded.auth.expires_at ?? "")).toBeGreaterThan(Date.now() + 50 * 60_000)
			expect(recorded.refresh_failed_at).toBeNull()
			expect(stripAnsi(workerLogs.join(""))).not.toContain("Credential refresh not reported")

			// Only the connection can report a refresh: to an API caller the route is not there.
			const forged = await apiFetch("/internal/credential-refresh", {
				method: "POST",
				body: { credential_id: g.id, refreshes: 99, expires_at: null, refresh_failed: true },
			})
			expect(forged.status).toBe(404)
			await sleep(300)
			expect((await g.read()).refresh_failed_at).toBeNull()

			await g.turn(3, "three")
			expect(g.oauth.requests).toHaveLength(1)
			expect(g.mcp.calls.at(-1)).toMatchObject({ arguments: { text: "three" }, token: issued })
			await g.expectNoLeak()
		}, 90_000)

		it("makes one refresh for ten calls that need the token at once", async () => {
			const g = await grant("many")
			const ten =
				"const all = await Promise.all(Array.from({ length: 10 }, (_, i) => tools.mcp__desk__echo({ text: String(i) }))); return all.length;"
			fakeOpenAI.setHandler((req) => {
				const [output] = req.toolOutputs
				return output === undefined
					? {
							kind: "tool_call",
							name: "codemode",
							arguments: {
								code: req.lastUserText === "many" ? ten : echoScript("desk", req.lastUserText),
							},
						}
					: { kind: "reply", text: `Done: ${output}` }
			})
			await g.turn(1, "one")

			expect((await g.replace(g.access, aMinuteAgo())).status).toBe(200)
			g.oauth.delay(500)
			await g.turn(2, "many")
			expect(g.oauth.requests).toHaveLength(1)
			const calls = g.mcp.calls.slice(1)
			expect(calls).toHaveLength(10)
			expect(new Set(calls.map((call) => call.token))).toEqual(new Set([g.oauth.issued[0]]))
			await g.expectNoLeak()
		}, 90_000)

		it("fails closed and says so when the refresh is refused, until new tokens arrive", async () => {
			const g = await grant("refused")
			scriptOnRequest("desk")
			await g.turn(1, "one")

			expect((await g.replace(g.access, aMinuteAgo())).status).toBe(200)
			g.oauth.fail("invalid_grant", 100)
			await g.turn(2, "two")
			expect(g.mcp.calls).toHaveLength(1)
			const refusal = (await agentEvents(g.session.id))
				.filter((event) => event.type === "agent.mcp_tool_result")
				.at(-1)
			expect(refusal).toMatchObject({ is_error: true })
			expect(JSON.stringify(refusal)).toContain("needs to be re-authorized")
			const failed = await eventually(g.read, (seen) => seen.refresh_failed_at !== null)
			expect(failed.refresh_failed_at).not.toBeNull()
			expect(g.oauth.requests).toHaveLength(1)

			// Nothing is tried again on its own.
			await g.turn(3, "three")
			expect(g.oauth.requests).toHaveLength(1)
			expect(g.mcp.calls).toHaveLength(1)

			const fresh = "oat_wd_refused_FRESH_do_not_leak"
			g.mcp.accept([fresh])
			const renewed = await g.replace(fresh, inAnHour())
			expect(renewed.body.refresh_failed_at).toBeNull()
			await g.turn(4, "four")
			expect(g.mcp.calls.at(-1)).toEqual({
				tool: "echo",
				arguments: { text: "four" },
				token: fresh,
			})
			expect(g.oauth.requests).toHaveLength(1)
			const logged = stripAnsi(workerLogs.join(""))
			expect(logged).not.toContain(fresh)
			await g.expectNoLeak()
		}, 120_000)

		it("retries a failing authorization server, and refreshes when the server drops the token early", async () => {
			const g = await grant("outage")
			scriptOnRequest("desk")
			await g.turn(1, "one")

			expect((await g.replace(g.access, aMinuteAgo())).status).toBe(200)
			g.oauth.fail("server_error", 1)
			await g.turn(2, "two")
			expect(g.oauth.requests).toHaveLength(2)
			expect(g.mcp.calls.at(-1)).toMatchObject({
				arguments: { text: "two" },
				token: g.oauth.issued[0],
			})
			expect((await g.read()).refresh_failed_at).toBeNull()

			// The server stops taking a token whose expiry is still an hour away.
			g.mcp.accept(["oat_wd_someone_elses"])
			await g.turn(3, "three")
			expect(g.oauth.requests).toHaveLength(3)
			expect(g.mcp.calls.at(-1)).toEqual({
				tool: "echo",
				arguments: { text: "three" },
				token: g.oauth.issued[2],
			})
			expect(g.mcp.tokens).toContain(g.oauth.issued[0])
			expect((await g.read()).refresh_failed_at).toBeNull()
			await g.expectNoLeak()
		}, 90_000)
	})

	describe("MCP servers", () => {
		const servers: Array<FakeMcpServer> = []
		const mcpServer = async (accepted: ReadonlyArray<string> | null) => {
			const server = await startFakeMcpServer(accepted)
			servers.push(server)
			return server
		}
		afterAll(async () => {
			await Promise.all(servers.map((server) => server.close()))
		})

		it("keeps a turn whose MCP tool returns an image over the bound, with a note in its place", async () => {
			const mcp = await mcpServer(null)
			const agent = await agentWith("shots", mcp.url)
			const script = [
				// The second image is more base64 than a result keeps of images and details together.
				"const r = await tools.mcp__shots__picture({ first: 1024, second: 2500000 });",
				"const text = JSON.stringify(r);",
				'return [text.includes("left out") ? "noted" : "kept", text.includes("image/png") ? "image" : "none"].join(" ");',
			].join("\n")
			fakeOpenAI.setHandler((req) => {
				const [output] = req.toolOutputs
				return output === undefined
					? { kind: "tool_call", name: "codemode", arguments: { code: script } }
					: { kind: "reply", text: `Done: ${output}` }
			})
			const session = await createResource<SessionResource>("/v1/sessions", {
				agent: agent.id,
				environment_id: environmentId,
			})
			expect((await sender(session.id)("pictures")).status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)
			const reply = (await agentEvents(session.id)).find((event) => event.type === "agent.message")
			// The small image reaches the script; the large one is a note the result hook left.
			expect(reply?.content?.[0]?.text).toContain("noted image")
		}, 60_000)

		it("calls a server from a script with the session's credential, and logs the call", async () => {
			const token = "tok_mcp_SCRIPT_do_not_leak"
			const mcp = await mcpServer([token])
			const { vault, credential } = await credentialFor(mcp.url, token)
			const agent = await agentWith("tracker", mcp.url)
			scriptOnRequest("tracker")

			const session = await createResource<SessionResource & { readonly mcp_servers: unknown }>(
				"/v1/sessions",
				{ agent: agent.id, environment_id: environmentId, vault_ids: [vault] },
			)
			expect(session.mcp_servers).toEqual([
				{ name: "tracker", url: mcp.url, credential_id: credential },
			])
			expect((await sender(session.id)("hello")).status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)

			expect(mcp.calls).toEqual([{ tool: "echo", arguments: { text: "hello" }, token }])

			const events = await agentEvents(session.id)
			// The script call is published whole, then the calls it made.
			expect(events.map((event) => event.type)).toEqual([
				"agent.tool_use",
				"agent.tool_result",
				"agent.mcp_tool_use",
				"agent.mcp_tool_result",
				"agent.message",
			])
			const [script, scriptResult, call, result, reply] = events
			expect(script).toMatchObject({ name: "codemode" })
			expect(call).toMatchObject({
				tool_use_id: `${script?.tool_use_id}/c1`,
				parent_tool_use_id: script?.tool_use_id,
				mcp_server_name: "tracker",
				name: "echo",
				input: { text: "hello" },
			})
			expect(result).toMatchObject({
				tool_use_id: call?.tool_use_id,
				content: [{ type: "text", text: "echo:hello" }],
				is_error: false,
			})
			expect(scriptResult).toMatchObject({ tool_use_id: script?.tool_use_id, is_error: false })
			expect(reply?.content?.[0]?.text).toContain("echo:hello")

			const everything = JSON.stringify([
				await listAllEvents(session.id),
				(await apiJson(`/v1/sessions/${session.id}`)).body,
				(await apiJson(`/v1/agents/${agent.id}`)).body,
			])
			expect(everything).not.toContain(token)
			expect(stripAnsi(workerLogs.join(""))).not.toContain(token)
		}, 60_000)

		it("refuses to choose between two credentials and uses the one a session binds", async () => {
			const first = "tok_mcp_FIRST_do_not_leak"
			const second = "tok_mcp_SECOND_do_not_leak"
			const mcp = await mcpServer([first, second])
			const one = await credentialFor(mcp.url, first)
			const two = await credentialFor(mcp.url, second)
			const agent = await agentWith("tracker", mcp.url)
			scriptOnRequest("tracker")

			const body = {
				agent: agent.id,
				environment_id: environmentId,
				vault_ids: [one.vault, two.vault],
			}
			const ambiguous = await apiJson<{ readonly error?: { readonly message: string } }>(
				"/v1/sessions",
				{ method: "POST", body },
			)
			expect(ambiguous.status).toBe(400)
			expect(ambiguous.body.error?.message).toContain("matches more than one credential")

			const session = await createResource<SessionResource>("/v1/sessions", {
				...body,
				mcp_server_credentials: [{ mcp_server_name: "tracker", credential_id: two.credential }],
			})
			expect((await sender(session.id)("which")).status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)
			expect(mcp.calls.map((call) => call.token)).toEqual([second])
			expect(mcp.tokens).not.toContain(first)
		}, 60_000)

		it("uses a rotated secret at once and fails closed once the credential is archived", async () => {
			const original = "tok_mcp_ORIGINAL_do_not_leak"
			const rotated = "tok_mcp_ROTATED_do_not_leak"
			const mcp = await mcpServer([original])
			const { vault, credential } = await credentialFor(mcp.url, original)
			const agent = await agentWith("tracker", mcp.url)
			scriptOnRequest("tracker")
			const session = await createResource<SessionResource>("/v1/sessions", {
				agent: agent.id,
				environment_id: environmentId,
				vault_ids: [vault],
			})
			const send = sender(session.id)
			const path = `/v1/vaults/${vault}/credentials/${credential}`

			expect((await send("one")).status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)

			mcp.accept([rotated])
			expect(
				(
					await apiJson(path, {
						method: "POST",
						body: { auth: { type: "static_bearer", token: rotated } },
					})
				).status,
			).toBe(200)
			expect((await send("two")).status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 2)
			expect(mcp.calls.map((call) => [call.arguments, call.token])).toEqual([
				[{ text: "one" }, original],
				[{ text: "two" }, rotated],
			])

			expect((await apiJson(`${path}/archive`, { method: "POST" })).status).toBe(200)
			const erased = Date.now() + 10_000
			while (
				!stripAnsi(workerLogs.join("")).includes(`Credential secret erased ${credential}`) &&
				Date.now() < erased
			) {
				await sleep(100)
			}
			const requestsBefore = mcp.tokens.length
			expect((await send("three")).status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 3)

			expect(mcp.calls).toHaveLength(2)
			expect(mcp.tokens).toHaveLength(requestsBefore)
			const events = await agentEvents(session.id)
			const results = events.filter((event) => event.type === "agent.mcp_tool_result")
			expect(results.map((event) => event.is_error)).toEqual([false, false, true])
			expect(results[2]?.content?.[0]?.text).toContain("no longer available")
			expect(events.at(-1)).toMatchObject({ type: "agent.message" })

			const logged = stripAnsi(workerLogs.join(""))
			expect(JSON.stringify(await listAllEvents(session.id))).not.toContain(original)
			expect(JSON.stringify(await listAllEvents(session.id))).not.toContain(rotated)
			expect(logged).not.toContain(original)
			expect(logged).not.toContain(rotated)
		}, 90_000)

		it("uses a server without a credential, and offers a tool to the model only once it is found", async () => {
			const mcp = await mcpServer(null)
			const agent = await agentWith("open", mcp.url)
			const offered: Array<ReadonlyArray<string>> = []
			fakeOpenAI.setHandler((req) => {
				offered.push(req.toolNames)
				switch (req.toolOutputs.length) {
					case 0:
						return {
							kind: "tool_call",
							name: "mcp__open__echo",
							arguments: { text: "too early" },
						}
					case 1:
						return { kind: "tool_call", name: "tool_search", arguments: { query: "echo" } }
					case 2:
						return { kind: "tool_call", name: "mcp__open__echo", arguments: { text: "direct" } }
					default:
						return { kind: "reply", text: `Done: ${req.toolOutputs.at(-1)}` }
				}
			})

			const session = await createResource<SessionResource & { readonly mcp_servers: unknown }>(
				"/v1/sessions",
				{ agent: agent.id, environment_id: environmentId },
			)
			expect(session.mcp_servers).toEqual([{ name: "open", url: mcp.url, credential_id: null }])
			expect((await sender(session.id)("go")).status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)

			expect(offered[0]).toEqual(expect.arrayContaining(["codemode", "tool_search"]))
			expect(offered[0]).not.toContain("mcp__open__echo")
			expect(offered[1]).not.toContain("mcp__open__echo")
			expect(offered[2]).toContain("mcp__open__echo")
			expect(mcp.calls).toEqual([{ tool: "echo", arguments: { text: "direct" }, token: undefined }])

			const events = await agentEvents(session.id)
			const calls = events.filter((event) => event.type === "agent.mcp_tool_use")
			expect(calls).toHaveLength(1)
			expect(calls[0]).toMatchObject({
				mcp_server_name: "open",
				name: "echo",
				input: { text: "direct" },
			})
			expect(calls[0]).not.toHaveProperty("parent_tool_use_id")
			const results = events.filter((event) => event.type === "agent.mcp_tool_result")
			expect(results).toEqual([
				expect.objectContaining({
					tool_use_id: calls[0]?.tool_use_id,
					content: [{ type: "text", text: "echo:direct" }],
					is_error: false,
				}),
			])
			expect(events.indexOf(calls[0] as SessionEventItem)).toBeLessThan(
				events.indexOf(results[0] as SessionEventItem),
			)
			// The refused call and the search are ordinary tool calls.
			expect(
				events.filter((event) => event.type === "agent.tool_use").map((event) => event.name),
			).toEqual(["mcp__open__echo", "tool_search"])
			expect(events.at(-1)?.content?.[0]?.text).toContain("echo:direct")
		}, 60_000)
	})

	describe("Tool approvals", () => {
		const servers: Array<FakeMcpServer> = []
		const mcpServer = async () => {
			const server = await startFakeMcpServer(null)
			servers.push(server)
			return server
		}
		afterAll(async () => {
			await Promise.all(servers.map((server) => server.close()))
		})

		it("pauses on a tool that asks, runs it once when allowed, and refuses a second answer", async () => {
			const mcp = await mcpServer()
			const { session } = await sessionFor(mcp.url)
			callDirectly(post)

			expect((await sender(session.id)("hello")).status).toBe(200)
			const paused = await idle(session.id, 1)
			expect(paused?.type).toBe("requires_action")
			expect(paused?.event_ids).toHaveLength(1)
			const [waiting] = paused?.event_ids ?? []
			expect(mcp.calls).toEqual([])

			const before = await listAllEvents(session.id)
			expect(before.filter((event) => event.type === "agent.mcp_tool_use")).toEqual([
				expect.objectContaining({
					tool_use_id: waiting,
					mcp_server_name: "desk",
					name: "post",
					input: { text: "hello" },
					evaluated_permission: "ask",
				}),
			])
			expect(before.some((event) => event.type === "agent.mcp_tool_result")).toBe(false)
			expect((await apiJson<SessionResource>(`/v1/sessions/${session.id}`)).body.status).toBe(
				"idle",
			)

			// A message cannot jump ahead of the answer, and an unknown call has no answer to take.
			expect((await sender(session.id)("hurry up")).status).toBe(409)
			expect((await confirm(session.id, "call_nope", "allow")).status).toBe(409)
			expect(mcp.calls).toEqual([])

			expect((await confirm(session.id, waiting ?? "", "allow")).status).toBe(200)
			expect((await idle(session.id, 2))?.type).toBe("end_turn")
			expect(mcp.calls).toEqual([{ tool: "post", arguments: { text: "hello" }, token: undefined }])

			const events = await listAllEvents(session.id)
			expect(events.filter((event) => event.type === "agent.mcp_tool_use")).toHaveLength(1)
			expect(events.filter((event) => event.type === "agent.mcp_tool_result")).toEqual([
				expect.objectContaining({
					tool_use_id: waiting,
					content: [{ type: "text", text: "posted:hello" }],
					is_error: false,
				}),
			])
			expect(events.find((event) => event.type === "user.tool_confirmation")).toMatchObject({
				tool_use_id: waiting,
				result: "allow",
			})
			expect(events.findLast((event) => event.type === "agent.message")?.content?.[0]?.text).toBe(
				"Done: posted:hello",
			)

			expect((await confirm(session.id, waiting ?? "", "allow")).status).toBe(409)
			expect(mcp.calls).toHaveLength(1)
		}, 90_000)

		it("lets the resumed turn use the workspace after an approval", async () => {
			const mcp = await mcpServer()
			const { session } = await sessionFor(mcp.url)
			const path = "/workspace/after-approval.txt"
			fakeOpenAI.setHandler((req) => {
				switch (req.toolOutputs.length) {
					case 0:
						return { kind: "tool_call", name: "tool_search", arguments: { query: "post" } }
					case 1:
						return { kind: "tool_calls", calls: post("hello") }
					case 2:
						return { kind: "tool_call", name: "write", arguments: { path, content: "RESUMED-7" } }
					case 3:
						return { kind: "tool_call", name: "read", arguments: { path } }
					default:
						return { kind: "reply", text: `Read: ${req.toolOutputs.at(-1) ?? ""}` }
				}
			})

			expect((await sender(session.id)("hello")).status).toBe(200)
			const [waiting] = (await idle(session.id, 1))?.event_ids ?? []
			expect((await confirm(session.id, waiting ?? "", "allow")).status).toBe(200)
			expect((await idle(session.id, 2))?.type).toBe("end_turn")

			const events = await listAllEvents(session.id)
			const workspaceResults = events.filter(
				(event) =>
					event.type === "agent.tool_result" &&
					events.some(
						(use) =>
							use.type === "agent.tool_use" &&
							use.tool_use_id === event.tool_use_id &&
							(use.name === "write" || use.name === "read"),
					),
			)
			expect(workspaceResults.map((event) => event.is_error)).toEqual([false, false])
			expect(
				events.findLast((event) => event.type === "agent.message")?.content?.[0]?.text,
			).toContain("RESUMED-7")
			expect(mcp.calls).toHaveLength(1)
		}, 90_000)

		it("tells the model why a call was denied and never calls the server", async () => {
			const mcp = await mcpServer()
			const { session } = await sessionFor(mcp.url)
			callDirectly(post)

			await sender(session.id)("hello")
			const [waiting] = (await idle(session.id, 1))?.event_ids ?? []
			expect((await confirm(session.id, waiting ?? "", "deny", "Not on a Friday.")).status).toBe(
				200,
			)
			expect((await idle(session.id, 2))?.type).toBe("end_turn")
			expect(mcp.calls).toEqual([])

			const events = await listAllEvents(session.id)
			expect(events.find((event) => event.type === "user.tool_confirmation")).toMatchObject({
				tool_use_id: waiting,
				result: "deny",
				deny_message: "Not on a Friday.",
			})
			const [refusal] = events.filter((event) => event.type === "agent.mcp_tool_result")
			expect(refusal).toMatchObject({ tool_use_id: waiting, is_error: true })
			expect(refusal?.content?.[0]?.text).toContain("Not on a Friday.")
			expect(
				events.findLast((event) => event.type === "agent.message")?.content?.[0]?.text,
			).toContain("Not on a Friday.")
		}, 90_000)

		it("refuses the call from a script without pausing, and says to make it directly", async () => {
			const mcp = await mcpServer()
			const { session } = await sessionFor(mcp.url)
			fakeOpenAI.setHandler((req) => {
				const [output] = req.toolOutputs
				return output === undefined
					? {
							kind: "tool_call",
							name: "codemode",
							arguments: {
								code: 'return await tools.mcp__desk__post({ text: "sneak" }).catch((error) => "refused: " + error.message);',
							},
						}
					: { kind: "reply", text: `Done: ${output}` }
			})

			await sender(session.id)("go")
			expect((await idle(session.id, 1))?.type).toBe("end_turn")
			expect(mcp.calls).toEqual([])

			const events = await agentEvents(session.id)
			expect(events.map((event) => event.type)).toEqual([
				"agent.tool_use",
				"agent.tool_result",
				"agent.mcp_tool_use",
				"agent.mcp_tool_result",
				"agent.message",
			])
			const [script, , call, refusal, reply] = events
			expect(call).toMatchObject({
				parent_tool_use_id: script?.tool_use_id,
				mcp_server_name: "desk",
				name: "post",
				input: { text: "sneak" },
				evaluated_permission: "ask",
			})
			expect(refusal).toMatchObject({ tool_use_id: call?.tool_use_id, is_error: true })
			expect(refusal?.content?.[0]?.text).toContain("Call mcp__desk__post directly")
			expect(reply?.content?.[0]?.text).toContain("needs a person's approval")
		}, 60_000)

		it("lets a read-only tool through on the server's word, unless the agent says to ask", async () => {
			const mcp = await mcpServer()
			callDirectly(echo)

			const trusting = await sessionFor(mcp.url)
			await sender(trusting.session.id)("free")
			expect((await idle(trusting.session.id, 1))?.type).toBe("end_turn")
			expect(mcp.calls).toEqual([{ tool: "echo", arguments: { text: "free" }, token: undefined }])
			expect(
				(await listAllEvents(trusting.session.id)).find(
					(event) => event.type === "agent.mcp_tool_use",
				),
			).toMatchObject({ name: "echo", evaluated_permission: "allow" })

			const tools = [
				{
					type: "mcp_toolset",
					mcp_server_name: "desk",
					configs: [{ name: "echo", permission_policy: { type: "always_ask" } }],
				},
			]
			const careful = await sessionFor(mcp.url, tools)
			expect(careful.agent.tools).toEqual(tools)
			await sender(careful.session.id)("asked")
			const paused = await idle(careful.session.id, 1)
			expect(paused?.type).toBe("requires_action")
			expect(mcp.calls).toHaveLength(1)
			expect(
				(await confirm(careful.session.id, paused?.event_ids?.[0] ?? "", "allow")).status,
			).toBe(200)
			expect((await idle(careful.session.id, 2))?.type).toBe("end_turn")
			expect(mcp.calls.at(-1)).toMatchObject({ tool: "echo", arguments: { text: "asked" } })

			// And the other way: the agent may let a tool that changes things run unasked.
			const relaxed = await sessionFor(mcp.url, [
				{
					type: "mcp_toolset",
					mcp_server_name: "desk",
					default_config: { permission_policy: { type: "always_allow" } },
				},
			])
			callDirectly(post)
			await sender(relaxed.session.id)("unasked")
			expect((await idle(relaxed.session.id, 1))?.type).toBe("end_turn")
			expect(mcp.calls.at(-1)).toMatchObject({ tool: "post", arguments: { text: "unasked" } })
		}, 120_000)

		it("gives up a waiting call on an interrupt and takes a new message afterwards", async () => {
			const mcp = await mcpServer()
			const { session } = await sessionFor(mcp.url)
			callDirectly(post)

			await sender(session.id)("hello")
			const [waiting] = (await idle(session.id, 1))?.event_ids ?? []
			const interrupted = await apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [{ type: "user.interrupt" }] },
			})
			expect(interrupted.status).toBe(200)

			// Once the interrupt has reached the harness, the late answer finds nothing waiting.
			const deadline = Date.now() + 20_000
			let late = await confirm(session.id, waiting ?? "", "allow")
			while (late.status !== 409 && Date.now() < deadline) {
				await sleep(100)
				late = await confirm(session.id, waiting ?? "", "allow")
			}
			expect(late.status).toBe(409)
			expect(mcp.calls).toEqual([])
			expect((await apiJson<SessionResource>(`/v1/sessions/${session.id}`)).body.status).toBe(
				"idle",
			)

			fakeOpenAI.setHandler((req) => ({ kind: "reply", text: `Heard: ${req.lastUserText}` }))
			expect((await sender(session.id)("something else")).status).toBe(200)
			expect((await idle(session.id, 2))?.type).toBe("end_turn")
			expect(mcp.calls).toEqual([])
			const events = await listAllEvents(session.id)
			expect(events.map((event) => event.type)).toContain("user.interrupt")
			expect(events.findLast((event) => event.type === "agent.message")?.content?.[0]?.text).toBe(
				"Heard: something else",
			)
		}, 90_000)

		it("waits on two calls at once and takes their answers one at a time", async () => {
			const mcp = await mcpServer()
			const { session } = await sessionFor(mcp.url)
			callDirectly((text) => [
				{ name: "mcp__desk__post", arguments: { text: `${text}-a` } },
				{ name: "mcp__desk__post", arguments: { text: `${text}-b` } },
			])

			await sender(session.id)("two")
			const paused = await idle(session.id, 1)
			expect(paused?.type).toBe("requires_action")
			expect(paused?.event_ids).toHaveLength(2)
			const waiting = (await listAllEvents(session.id)).filter(
				(event) => event.type === "agent.mcp_tool_use",
			)
			expect(waiting.map((event) => event.input)).toEqual([{ text: "two-a" }, { text: "two-b" }])
			const [first, second] = waiting.map((event) => event.tool_use_id ?? "")

			expect((await confirm(session.id, first ?? "", "allow")).status).toBe(200)
			const again = await idle(session.id, 2)
			expect(again).toEqual({ type: "requires_action", event_ids: [second] })
			expect(mcp.calls).toEqual([{ tool: "post", arguments: { text: "two-a" }, token: undefined }])

			expect((await confirm(session.id, second ?? "", "deny", "One is enough.")).status).toBe(200)
			expect((await idle(session.id, 3))?.type).toBe("end_turn")
			expect(mcp.calls).toHaveLength(1)

			const events = await listAllEvents(session.id)
			expect(events.filter((event) => event.type === "agent.mcp_tool_use")).toHaveLength(2)
			expect(
				events
					.filter((event) => event.type === "agent.mcp_tool_result")
					.map((event) => [event.tool_use_id, event.is_error]),
			).toEqual([
				[first, false],
				[second, true],
			])
			const reply = events.findLast((event) => event.type === "agent.message")?.content?.[0]?.text
			expect(reply).toContain("posted:two-a")
			expect(reply).toContain("One is enough.")
		}, 120_000)
	})

	const returnResult = (
		sessionId: string,
		custom_tool_use_id: string,
		text: string,
		isError = false,
	) =>
		apiJson<{ readonly error?: { readonly message: string } }>(`/v1/sessions/${sessionId}/events`, {
			method: "POST",
			body: {
				events: [
					{
						type: "user.custom_tool_result",
						custom_tool_use_id,
						content: [{ type: "text", text }],
						...(isError ? { is_error: true } : {}),
					},
				],
			},
		})
	// Looks the order up, then reports what the application said.
	const lookUpOrder = () => {
		fakeOpenAI.setHandler((req) => {
			const [output] = req.toolOutputs
			return output === undefined
				? { kind: "tool_call", name: "lookup_order", arguments: { order: req.lastUserText } }
				: { kind: "reply", text: `Done: ${output}` }
		})
	}
	const replyText = async (sessionId: string) =>
		(await listAllEvents(sessionId)).findLast((event) => event.type === "agent.message")
			?.content?.[0]?.text

	// Finds the desk's tool, then looks the order up and posts about it in one round.
	const lookUpAndPost = () =>
		fakeOpenAI.setHandler((req) => {
			switch (req.toolOutputs.length) {
				case 0:
					return { kind: "tool_call", name: "tool_search", arguments: { query: "post" } }
				case 1:
					return {
						kind: "tool_calls",
						calls: [
							{ name: "lookup_order", arguments: { order: req.lastUserText } },
							{ name: "mcp__desk__post", arguments: { text: req.lastUserText } },
						],
					}
				default:
					return { kind: "reply", text: `Done: ${req.toolOutputs.slice(1).join(" | ")}` }
			}
		})

	describe("Custom tools", () => {
		const servers: Array<FakeMcpServer> = []
		afterAll(async () => {
			await Promise.all(servers.map((server) => server.close()))
		})

		const lookup = {
			type: "custom",
			name: "lookup_order",
			description: "Look an order up in the shop's own system.",
			input_schema: {
				type: "object",
				properties: { order: { type: "string" } },
				required: ["order"],
			},
		}
		const shopSession = async (mcpUrl?: string) => {
			const agent = await createResource<{ readonly id: string; readonly tools?: unknown }>(
				"/v1/agents",
				{
					name: "Shop",
					model: "gpt-4o-mini",
					tools: [lookup],
					...(mcpUrl === undefined
						? {}
						: { mcp_servers: [{ type: "url", name: "desk", url: mcpUrl }] }),
				},
			)
			expect(agent.tools).toEqual([lookup])
			return createResource<SessionResource>("/v1/sessions", {
				agent: agent.id,
				environment_id: environmentId,
			})
		}
		it("pauses on a custom tool call and carries on from the application's result", async () => {
			const session = await shopSession()
			lookUpOrder()

			expect((await sender(session.id)("A-1")).status).toBe(200)
			const paused = await idle(session.id, 1)
			expect(paused?.type).toBe("requires_action")
			expect(paused?.event_ids).toHaveLength(1)
			const [waiting] = paused?.event_ids ?? []
			expect((await agentEvents(session.id)).map((event) => [event.type, event.name])).toEqual([
				["agent.custom_tool_use", "lookup_order"],
			])
			expect((await agentEvents(session.id))[0]).toMatchObject({
				tool_use_id: waiting,
				input: { order: "A-1" },
			})
			const offered = fakeOpenAI.requests.at(-1)?.toolNames ?? []
			expect(offered).toContain("lookup_order")

			// Neither an approval nor a result for another call ends this wait.
			expect((await confirm(session.id, waiting ?? "", "allow")).status).toBe(409)
			expect((await returnResult(session.id, "call_nope", "shipped")).status).toBe(409)

			expect((await returnResult(session.id, waiting ?? "", "shipped")).status).toBe(200)
			expect((await idle(session.id, 2))?.type).toBe("end_turn")
			expect(await replyText(session.id)).toBe("Done: shipped")

			const events = await listAllEvents(session.id)
			expect(events.filter((event) => event.type === "agent.custom_tool_use")).toHaveLength(1)
			expect(events.some((event) => event.type === "agent.tool_result")).toBe(false)
			expect(events.find((event) => event.type === "user.custom_tool_result")).toMatchObject({
				content: [{ type: "text", text: "shipped" }],
			})

			expect((await returnResult(session.id, waiting ?? "", "lost")).status).toBe(409)
		}, 90_000)

		it("tells the model when the application says the tool failed", async () => {
			const session = await shopSession()
			lookUpOrder()

			await sender(session.id)("A-2")
			const [waiting] = (await idle(session.id, 1))?.event_ids ?? []
			expect((await returnResult(session.id, waiting ?? "", "no such order", true)).status).toBe(
				200,
			)
			expect((await idle(session.id, 2))?.type).toBe("end_turn")
			expect(await replyText(session.id)).toBe("Done: no such order")
			expect(
				(await listAllEvents(session.id)).find((event) => event.type === "user.custom_tool_result"),
			).toMatchObject({ is_error: true })
		}, 90_000)

		it("waits on a custom tool and an approval together, answered in either order", async () => {
			const mcp = await startFakeMcpServer(null)
			servers.push(mcp)
			const waitingCalls = async (sessionId: string) => {
				const events = await listAllEvents(sessionId)
				return {
					tool: events.find((event) => event.type === "agent.custom_tool_use")?.tool_use_id ?? "",
					ask: events.find((event) => event.type === "agent.mcp_tool_use")?.tool_use_id ?? "",
				}
			}

			lookUpAndPost()
			const resultFirst = await shopSession(mcp.url)
			await sender(resultFirst.id)("A-3")
			const paused = await idle(resultFirst.id, 1)
			expect(paused?.type).toBe("requires_action")
			const first = await waitingCalls(resultFirst.id)
			expect(paused?.event_ids?.toSorted()).toEqual([first.tool, first.ask].toSorted())
			expect((await returnResult(resultFirst.id, first.tool, "shipped")).status).toBe(200)
			expect(await idle(resultFirst.id, 2)).toEqual({
				type: "requires_action",
				event_ids: [first.ask],
			})
			expect(mcp.calls).toEqual([])
			expect((await confirm(resultFirst.id, first.ask, "allow")).status).toBe(200)
			expect((await idle(resultFirst.id, 3))?.type).toBe("end_turn")
			expect(mcp.calls).toEqual([{ tool: "post", arguments: { text: "A-3" }, token: undefined }])
			expect(await replyText(resultFirst.id)).toBe("Done: shipped | posted:A-3")

			lookUpAndPost()
			const approvalFirst = await shopSession(mcp.url)
			await sender(approvalFirst.id)("A-4")
			await idle(approvalFirst.id, 1)
			const second = await waitingCalls(approvalFirst.id)
			expect((await confirm(approvalFirst.id, second.ask, "allow")).status).toBe(200)
			expect(await idle(approvalFirst.id, 2)).toEqual({
				type: "requires_action",
				event_ids: [second.tool],
			})
			expect(mcp.calls).toHaveLength(2)
			expect((await returnResult(approvalFirst.id, second.tool, "shipped")).status).toBe(200)
			expect((await idle(approvalFirst.id, 3))?.type).toBe("end_turn")
			expect(await replyText(approvalFirst.id)).toBe("Done: shipped | posted:A-4")
			expect(
				(await listAllEvents(approvalFirst.id)).filter(
					(event) => event.type === "agent.custom_tool_use",
				),
			).toHaveLength(1)
		}, 180_000)

		it("gives up a waiting custom tool call on an interrupt and takes a new message afterwards", async () => {
			const session = await shopSession()
			lookUpOrder()

			await sender(session.id)("A-5")
			const [waiting] = (await idle(session.id, 1))?.event_ids ?? []
			const interrupted = await apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [{ type: "user.interrupt" }] },
			})
			expect(interrupted.status).toBe(200)

			const deadline = Date.now() + 20_000
			let late = await returnResult(session.id, waiting ?? "", "shipped")
			while (late.status !== 409 && Date.now() < deadline) {
				await sleep(100)
				late = await returnResult(session.id, waiting ?? "", "shipped")
			}
			expect(late.status).toBe(409)

			fakeOpenAI.setHandler((req) => ({ kind: "reply", text: `Heard: ${req.lastUserText}` }))
			expect((await sender(session.id)("something else")).status).toBe(200)
			expect((await idle(session.id, 2))?.type).toBe("end_turn")
			expect(await replyText(session.id)).toBe("Heard: something else")
			expect(
				(await listAllEvents(session.id)).some((event) => event.type === "user.custom_tool_result"),
			).toBe(false)
		}, 90_000)

		it("does not let a script call a custom tool", async () => {
			const session = await shopSession()
			fakeOpenAI.setHandler((req) => {
				const [output] = req.toolOutputs
				return output === undefined
					? {
							kind: "tool_call",
							name: "codemode",
							arguments: {
								code: 'return await tools.lookup_order({ order: "A-6" });',
							},
						}
					: { kind: "reply", text: `Done: ${output}` }
			})

			await sender(session.id)("go")
			expect((await idle(session.id, 1))?.type).toBe("end_turn")
			const events = await agentEvents(session.id)
			expect(events.map((event) => event.type)).toEqual([
				"agent.tool_use",
				"agent.tool_result",
				"agent.message",
			])
			expect(events[1]).toMatchObject({ is_error: true })
			expect(await replyText(session.id)).toContain("tools.lookup_order does not exist")
		}, 60_000)
	})

	const apiKeyFor = async (api: FakeHttpApi, token: string, placement: Schema.JsonObject) => {
		const vault = await createResource<{ readonly id: string }>("/v1/vaults", {
			display_name: "api",
		})
		const credential = await createResource<{ readonly id: string }>(
			`/v1/vaults/${vault.id}/credentials`,
			{ auth: { type: "api_key", base_url: api.baseUrl, token, placement } },
		)
		return { vault: vault.id, credential: credential.id }
	}

	// Every turn: run the user's message as a script, then say what it returned.
	const scriptFromMessage = () => {
		fakeOpenAI.setHandler((req) => {
			const [output] = req.toolOutputs
			return output === undefined
				? { kind: "tool_call", name: "codemode", arguments: { code: req.lastUserText } }
				: { kind: "reply", text: `Done: ${output}` }
		})
	}

	describe("API servers", () => {
		const apis: Array<FakeHttpApi> = []
		const httpApi = async (auth: FakeApiAuth | null, accepted: ReadonlyArray<string> | null) => {
			const api = await startFakeHttpApi(auth, accepted)
			apis.push(api)
			return api
		}
		afterAll(async () => {
			await Promise.all(apis.map((api) => api.close()))
		})

		const HEADER = { in: "header", name: "X-Api-Key" } as const
		type ApiAgent = {
			readonly id: string
			readonly api_servers: ReadonlyArray<{ readonly spec: { readonly digest: string } }>
			readonly tools: unknown
		}
		type ApiSession = SessionResource & { readonly api_servers: unknown }

		const agentWithApi = (api: FakeHttpApi, tools?: ReadonlyArray<Schema.JsonObject>) =>
			createResource<ApiAgent>("/v1/agents", {
				name: "API shop",
				model: "gpt-4o-mini",
				api_servers: [{ type: "openapi", name: "shop", base_url: api.baseUrl, spec: api.spec }],
				...(tools === undefined ? {} : { tools }),
			})

		it("calls an API from a script with the session's key, keeps the key out of everything, and logs each call", async () => {
			const key = "key_api_SCRIPT_do_not_leak"
			const api = await httpApi(HEADER, [key])
			const { vault, credential } = await apiKeyFor(api, key, HEADER)
			const agent = await agentWithApi(api)
			const [declared] = agent.api_servers
			expect(agent.api_servers).toEqual([
				{
					type: "openapi",
					name: "shop",
					base_url: api.baseUrl,
					spec: {
						title: "Pet shop",
						version: "1.2.3",
						operations: 5,
						digest: declared?.spec.digest,
					},
				},
			])
			expect(declared?.spec.digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
			expect(JSON.stringify(agent)).not.toContain("Look a pet up")
			scriptFromMessage()

			const session = await createResource<ApiSession>("/v1/sessions", {
				agent: agent.id,
				environment_id: environmentId,
				vault_ids: [vault],
			})
			expect(session.api_servers).toEqual([
				{ name: "shop", base_url: api.baseUrl, credential_id: credential },
			])
			const petId = "a/b/../c?x=1#y"
			const script = [
				`const pet = await tools.api__shop__getPet({ path: { petId: ${JSON.stringify(petId)} }, query: { verbose: true } });`,
				"const seen = await tools.api__shop__echoRequest({});",
				'let dots = "sent";',
				'try { await tools.api__shop__getPet({ path: { petId: ".." } }); } catch { dots = "refused"; }',
				"return `pet=${pet.body.name} id=${pet.body.id} status=${pet.status} dots=${dots} seen=${JSON.stringify(seen.body.headers)}`;",
			].join("\n")
			expect((await sender(session.id)(script)).status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)

			// The path argument is one segment however it reads, and `..` is never sent at all.
			expect(api.requests.map((request) => [request.method, request.target])).toEqual([
				["GET", "/v1/pets/a%2Fb%2F..%2Fc%3Fx%3D1%23y?verbose=true"],
				["GET", "/v1/echo"],
			])
			expect(api.requests.map((request) => request.headers["x-api-key"])).toEqual([key, key])

			const events = await agentEvents(session.id)
			// The script call is published whole, then the calls it made.
			expect(events.map((event) => event.type)).toEqual([
				"agent.tool_use",
				"agent.tool_result",
				"agent.api_tool_use",
				"agent.api_tool_result",
				"agent.api_tool_use",
				"agent.api_tool_result",
				"agent.api_tool_use",
				"agent.api_tool_result",
				"agent.message",
			])
			const [scriptCall] = events
			const [getPet, echoed, dots] = apiCalls(events)
			const [petResult, echoResult, dotsResult] = apiResults(events)
			expect(getPet).toMatchObject({
				tool_use_id: `${scriptCall?.tool_use_id}/c1`,
				parent_tool_use_id: scriptCall?.tool_use_id,
				api_server_name: "shop",
				name: "getPet",
				input: { path: { petId }, query: { verbose: true } },
				evaluated_permission: "allow",
			})
			expect(petResult).toMatchObject({ tool_use_id: getPet?.tool_use_id, is_error: false })
			expect(petResult?.content?.[0]?.text).toContain(JSON.stringify(petId))
			expect(echoed).toMatchObject({
				name: "echoRequest",
				parent_tool_use_id: scriptCall?.tool_use_id,
			})
			expect(echoResult?.content?.[0]?.text).toContain("[redacted]")
			expect(dots).toMatchObject({ name: "getPet", input: { path: { petId: ".." } } })
			expect(dotsResult).toMatchObject({ tool_use_id: dots?.tool_use_id, is_error: true })
			const reply = replyOf(events)
			expect(reply).toContain("pet=Rex")
			expect(reply).toContain(`id=${petId}`)
			expect(reply).toContain("status=200")
			expect(reply).toContain("dots=refused")
			expect(reply).toContain("[redacted]")

			const everything = JSON.stringify([
				await listAllEvents(session.id),
				(await apiJson(`/v1/sessions/${session.id}`)).body,
				(await apiJson(`/v1/agents/${agent.id}`)).body,
				(await apiJson(`/v1/vaults/${vault}/credentials/${credential}`)).body,
			])
			expect(everything).not.toContain(key)
			expect(stripAnsi(workerLogs.join(""))).not.toContain(key)
		}, 60_000)

		it("puts a key in the query string when its credential says so, and keeps it out of what comes back", async () => {
			const key = "key_api_QUERY_do_not_leak"
			const placement = { in: "query", name: "api_key" } as const
			const api = await httpApi(placement, [key])
			const { vault } = await apiKeyFor(api, key, placement)
			const agent = await agentWithApi(api)
			scriptFromMessage()
			const session = await createResource<ApiSession>("/v1/sessions", {
				agent: agent.id,
				environment_id: environmentId,
				vault_ids: [vault],
			})
			expect(
				(
					await sender(session.id)(
						"const seen = await tools.api__shop__echoRequest({}); return `url=${seen.body.url}`;",
					)
				).status,
			).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)

			expect(api.requests.map((request) => request.target)).toEqual([`/v1/echo?api_key=${key}`])
			const events = await listAllEvents(session.id)
			expect(replyOf(events)).toContain("url=/v1/echo?api_key=[redacted]")
			expect(JSON.stringify(events)).not.toContain(key)
			expect(stripAnsi(workerLogs.join(""))).not.toContain(key)
		}, 60_000)

		it("asks before an operation that writes, refuses it from a script, and runs it when the agent allows it", async () => {
			const api = await httpApi(null, null)
			const agent = await agentWithApi(api)
			const writes = () => api.requests.filter((request) => request.method === "POST")
			fakeOpenAI.setHandler((req) => {
				switch (req.toolOutputs.length) {
					case 0:
						return { kind: "tool_call", name: "tool_search", arguments: { query: "createPet" } }
					case 1:
						return {
							kind: "tool_call",
							name: "api__shop__createPet",
							arguments: { body: { name: req.lastUserText } },
						}
					default:
						return { kind: "reply", text: `Done: ${req.toolOutputs.at(-1)}` }
				}
			})
			const session = await createResource<ApiSession>("/v1/sessions", {
				agent: agent.id,
				environment_id: environmentId,
			})

			expect((await sender(session.id)("Milo")).status).toBe(200)
			const paused = await idle(session.id, 1)
			expect(paused?.type).toBe("requires_action")
			const [waiting] = paused?.event_ids ?? []
			expect(writes()).toEqual([])
			expect(apiCalls(await listAllEvents(session.id))).toEqual([
				expect.objectContaining({
					tool_use_id: waiting,
					api_server_name: "shop",
					name: "createPet",
					input: { body: { name: "Milo" } },
					evaluated_permission: "ask",
				}),
			])

			expect((await confirm(session.id, waiting ?? "", "allow")).status).toBe(200)
			expect((await idle(session.id, 2))?.type).toBe("end_turn")
			expect(writes().map((request) => request.body)).toEqual([JSON.stringify({ name: "Milo" })])
			const allowed = await listAllEvents(session.id)
			expect(apiCalls(allowed)).toHaveLength(1)
			expect(apiResults(allowed)).toEqual([
				expect.objectContaining({ tool_use_id: waiting, is_error: false }),
			])
			expect(replyOf(allowed)).toContain("Milo")

			scriptFromMessage()
			expect(
				(
					await sender(session.id)(
						'return await tools.api__shop__createPet({ body: { name: "Scripted" } });',
					)
				).status,
			).toBe(200)
			expect((await idle(session.id, 3))?.type).toBe("end_turn")
			expect(writes()).toHaveLength(1)
			const blocked = apiResults(await listAllEvents(session.id)).at(-1)
			expect(blocked).toMatchObject({ is_error: true })
			expect(blocked?.content?.[0]?.text).toContain("Call api__shop__createPet directly")

			const trusting = await agentWithApi(api, [
				{
					type: "api_toolset",
					api_server_name: "shop",
					configs: [{ name: "createPet", permission_policy: { type: "always_allow" } }],
				},
			])
			expect(trusting.tools).toEqual([
				{
					type: "api_toolset",
					api_server_name: "shop",
					configs: [{ name: "createPet", permission_policy: { type: "always_allow" } }],
				},
			])
			const trusted = await createResource<ApiSession>("/v1/sessions", {
				agent: trusting.id,
				environment_id: environmentId,
			})
			expect(
				(
					await sender(trusted.id)(
						'const made = await tools.api__shop__createPet({ body: { name: "Trusted" } }); return `made=${made.body.name} status=${made.status}`;',
					)
				).status,
			).toBe(200)
			expect((await idle(trusted.id, 1))?.type).toBe("end_turn")
			expect(writes().map((request) => request.body)).toEqual([
				JSON.stringify({ name: "Milo" }),
				JSON.stringify({ name: "Trusted" }),
			])
			const ran = await listAllEvents(trusted.id)
			expect(apiCalls(ran)).toEqual([
				expect.objectContaining({ name: "createPet", evaluated_permission: "allow" }),
			])
			expect(replyOf(ran)).toContain("made=Trusted status=201")
		}, 120_000)

		it("refuses to choose between two keys for one API and uses the one a session binds", async () => {
			const first = "key_api_FIRST_do_not_leak"
			const second = "key_api_SECOND_do_not_leak"
			const api = await httpApi(HEADER, [first, second])
			const one = await apiKeyFor(api, first, HEADER)
			const two = await apiKeyFor(api, second, HEADER)
			const agent = await agentWithApi(api)
			scriptFromMessage()

			const body = {
				agent: agent.id,
				environment_id: environmentId,
				vault_ids: [one.vault, two.vault],
			}
			const ambiguous = await apiJson<{ readonly error?: { readonly message: string } }>(
				"/v1/sessions",
				{ method: "POST", body },
			)
			expect(ambiguous.status).toBe(400)
			expect(ambiguous.body.error?.message).toContain(
				'API server "shop" matches more than one credential',
			)

			const session = await createResource<ApiSession>("/v1/sessions", {
				...body,
				api_server_credentials: [{ api_server_name: "shop", credential_id: two.credential }],
			})
			expect(session.api_servers).toEqual([
				{ name: "shop", base_url: api.baseUrl, credential_id: two.credential },
			])
			expect(
				(await sender(session.id)("return (await tools.api__shop__echoRequest({})).status;"))
					.status,
			).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)
			expect(api.requests.map((request) => request.headers["x-api-key"])).toEqual([second])
		}, 60_000)

		it("uses a replaced key at once and fails closed once the credential is archived", async () => {
			const original = "key_api_ORIGINAL_do_not_leak"
			const rotated = "key_api_ROTATED_do_not_leak"
			const api = await httpApi(HEADER, [original])
			const { vault, credential } = await apiKeyFor(api, original, HEADER)
			const agent = await agentWithApi(api)
			scriptFromMessage()
			const session = await createResource<ApiSession>("/v1/sessions", {
				agent: agent.id,
				environment_id: environmentId,
				vault_ids: [vault],
			})
			const send = sender(session.id)
			const path = `/v1/vaults/${vault}/credentials/${credential}`
			const script =
				'const pet = await tools.api__shop__getPet({ path: { petId: "7" } }); return `status=${pet.status}`;'

			expect((await send(script)).status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)

			api.accept([rotated])
			expect(
				(
					await apiJson(path, {
						method: "POST",
						body: { auth: { type: "api_key", token: rotated } },
					})
				).status,
			).toBe(200)
			expect((await send(script)).status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 2)
			expect(api.requests.map((request) => request.headers["x-api-key"])).toEqual([
				original,
				rotated,
			])
			expect(replyOf(await listAllEvents(session.id))).toContain("status=200")

			expect((await apiJson(`${path}/archive`, { method: "POST" })).status).toBe(200)
			expect((await send(script)).status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 3)
			expect(api.requests).toHaveLength(2)
			const refused = apiResults(await listAllEvents(session.id)).at(-1)
			expect(refused).toMatchObject({ is_error: true })
			expect(refused?.content?.[0]?.text).toContain("no longer available")

			const logged = stripAnsi(workerLogs.join(""))
			expect(logged).not.toContain(original)
			expect(logged).not.toContain(rotated)
		}, 90_000)

		it("uses an API without a credential, and offers an operation to the model only once it is found", async () => {
			const api = await httpApi(null, null)
			const agent = await agentWithApi(api)
			const offered: Array<ReadonlyArray<string>> = []
			fakeOpenAI.setHandler((req) => {
				offered.push(req.toolNames)
				switch (req.toolOutputs.length) {
					case 0:
						return {
							kind: "tool_call",
							name: "api__shop__getPet",
							arguments: { path: { petId: "early" } },
						}
					case 1:
						return { kind: "tool_call", name: "tool_search", arguments: { query: "getPet" } }
					case 2:
						return {
							kind: "tool_call",
							name: "api__shop__getPet",
							arguments: { path: { petId: "7" } },
						}
					default:
						return { kind: "reply", text: `Done: ${req.toolOutputs.at(-1)}` }
				}
			})

			const session = await createResource<ApiSession>("/v1/sessions", {
				agent: agent.id,
				environment_id: environmentId,
			})
			expect(session.api_servers).toEqual([
				{ name: "shop", base_url: api.baseUrl, credential_id: null },
			])
			expect((await sender(session.id)("go")).status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)

			expect(offered[0]).toEqual(expect.arrayContaining(["codemode", "tool_search"]))
			expect(offered[0]).not.toContain("api__shop__getPet")
			expect(offered[1]).not.toContain("api__shop__getPet")
			expect(offered[2]).toContain("api__shop__getPet")
			expect(api.requests.map((request) => request.target)).toEqual(["/v1/pets/7"])
			expect(api.requests[0]?.headers["authorization"]).toBeUndefined()

			const events = await agentEvents(session.id)
			const calls = apiCalls(events)
			expect(calls).toEqual([
				expect.objectContaining({
					api_server_name: "shop",
					name: "getPet",
					input: { path: { petId: "7" } },
					evaluated_permission: "allow",
				}),
			])
			expect(calls[0]).not.toHaveProperty("parent_tool_use_id")
			const results = apiResults(events)
			expect(results).toEqual([
				expect.objectContaining({ tool_use_id: calls[0]?.tool_use_id, is_error: false }),
			])
			expect(events.indexOf(calls[0] as SessionEventItem)).toBeLessThan(
				events.indexOf(results[0] as SessionEventItem),
			)
			expect(replyOf(events)).toContain("Rex")
		}, 60_000)

		it("reports a refusal with its status and cuts a response that is too long", async () => {
			const api = await httpApi(null, null)
			const agent = await agentWithApi(api)
			scriptFromMessage()
			const session = await createResource<ApiSession>("/v1/sessions", {
				agent: agent.id,
				environment_id: environmentId,
			})
			const script = [
				"const missing = await tools.api__shop__getMissing({});",
				"const big = await tools.api__shop__getBig({});",
				"return `missing=${missing.status} said=${missing.body.error} big=${big.status} length=${big.text.length} cut=${big.text.endsWith('been cut.]')}`;",
			].join("\n")
			expect((await sender(session.id)(script)).status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)

			const events = await listAllEvents(session.id)
			const [missing, big] = apiResults(events)
			expect(missing).toMatchObject({ is_error: true })
			expect(missing?.content?.[0]?.text).toContain("HTTP 404")
			expect(big).toMatchObject({ is_error: false })
			const reply = replyOf(events)
			expect(reply).toContain("missing=404")
			expect(reply).toContain("not found")
			expect(reply).toContain("big=200")
			expect(reply).toContain("cut=true")
			const length = Number(/length=(\d+)/u.exec(reply)?.[1])
			expect(length).toBeGreaterThanOrEqual(100_000)
			expect(length).toBeLessThan(BIG_BODY_BYTES)
		}, 60_000)
	})

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

		const discardDeadline = Date.now() + 10_000
		while (!workerLogs.join("").includes("Workspace discarded") && Date.now() < discardDeadline) {
			await sleep(100)
		}
		const logged = stripAnsi(workerLogs.join(""))
		expect(logged).toContain("Workspace discarded")
		expect(logged).toContain(session.id)
		expect(logged).not.toContain("Workspace not discarded")
	}, 30_000)
})
