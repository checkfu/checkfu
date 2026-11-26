import { Checkfu, accumulateSessionEvent } from "@checkfu/sdk"
import type { SessionMessagePreview } from "@checkfu/sdk"
import { spawn } from "node:child_process"
import { createHash, createHmac } from "node:crypto"
import type { ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type * as Schema from "effect/Schema"
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
import { startFakeOpenAIResponsesServer } from "./FakeOpenAIResponsesServer.ts"
import type { FakeOpenAIAction, FakeOpenAIResponsesServer } from "./FakeOpenAIResponsesServer.ts"
import { startFakeMcpServer } from "./FakeMcpServer.ts"
import { startScriptedMcpServer } from "./ScriptedMcpServer.ts"
import { toolUseOf } from "@checkfu/domain/Session/ToolEventBounds"
import { toolUseIdFromEvent } from "@checkfu/domain/Session/Session.id"

const REPO_ROOT = resolve(import.meta.dirname, "../../../..")
const TEST_API_KEY = "ck_workerd_test_key"
const TEST_OPENAI_KEY = "sk-workerd-fake-key"
const TEST_ANTHROPIC_KEY = "sk-ant-workerd-fake-key"
const TEST_OPENROUTER_KEY = "sk-or-v1-workerd-fake-key"
const TEST_CLOUDFLARE_AI_KEY = "cf-ai-workerd-fake-key"
const TEST_CUSTOM_PROVIDER_ID = "custom-local"
const TEST_CUSTOM_API_KEY = "sk-custom-workerd-fake-key"
const TEST_CUSTOM_HEADER_SECRET = "hdr-custom-workerd-secret"
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
	readonly mcp_server_name?: string
	readonly name?: string
	readonly input?: Schema.JsonObject
	readonly model_usage?: { readonly input_tokens: number; readonly output_tokens: number }
	readonly stop_reason?: { readonly type: string; readonly event_ids?: ReadonlyArray<string> }
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

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

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

const boundEnv = (stage: string, worker: (typeof WORKERS)[number]): object => {
	const saved = JSON.parse(
		readFileSync(join(REPO_ROOT, ".alchemy", "state", "Checkfu", stage, `${worker}.json`), "utf8"),
	) as { readonly props?: { readonly env?: object } }
	return saved.props?.env ?? {}
}

const boundNames = (stage: string, worker: (typeof WORKERS)[number]): ReadonlyArray<string> =>
	Object.keys(boundEnv(stage, worker))

const startAlchemyDev = async (openAIBaseUrl: string) => {
	const stage = `wd-${process.pid.toString(36)}-${Date.now().toString(36).slice(-4)}`
	const envDir = mkdtempSync(join(tmpdir(), `checkfu-${stage}-`))
	const envFile = join(envDir, "test.env")
	const customProvidersJson = JSON.stringify({
		[TEST_CUSTOM_PROVIDER_ID]: {
			name: "Custom Local",
			format: "openai-responses",
			base_url: openAIBaseUrl,
			api_key_env: "CHECKFU_PROVIDER_SECRET_CUSTOM_LOCAL_API_KEY",
			headers: { "x-tenant": "acme-tenant-tag" },
			secret_headers: { "x-custom-secret": "CHECKFU_PROVIDER_SECRET_CUSTOM_LOCAL_HEADER_SECRET" },
			default_model: "custom-model-v1",
		},
	})
	try {
		writeFileSync(
			envFile,
			[
				`CHECKFU_API_KEY=${TEST_API_KEY}`,
				`OPENAI_API_KEY=${TEST_OPENAI_KEY}`,
				`ANTHROPIC_API_KEY=${TEST_ANTHROPIC_KEY}`,
				`OPENROUTER_API_KEY=${TEST_OPENROUTER_KEY}`,
				`CLOUDFLARE_AI_API_KEY=${TEST_CLOUDFLARE_AI_KEY}`,
				`CHECKFU_PROVIDER_SECRET_CUSTOM_LOCAL_API_KEY=${TEST_CUSTOM_API_KEY}`,
				`CHECKFU_PROVIDER_SECRET_CUSTOM_LOCAL_HEADER_SECRET=${TEST_CUSTOM_HEADER_SECRET}`,
				`CHECKFU_PROVIDERS='${customProvidersJson}'`,
				`CHECKFU_OPENAI_BASE_URL=${openAIBaseUrl}`,
				"CHECKFU_PUBLISH_DOMAIN=pages.example",
				"CHECKFU_API_DOMAIN=none",
				"CHECKFU_MCP_DOMAIN=none",
				"CHECKFU_MACHINE_IDLE=10 seconds",
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
	delete childEnv.OPENROUTER_API_KEY
	delete childEnv.CLOUDFLARE_AI_API_KEY
	delete childEnv.CLOUDFLARE_API_KEY
	delete childEnv.CLOUDFLARE_GATEWAY_ID
	delete childEnv.CHECKFU_PROVIDERS
	delete childEnv.CHECKFU_PROVIDER_CATALOG
	delete childEnv.CHECKFU_PROVIDER_SECRET_CUSTOM_LOCAL_API_KEY
	delete childEnv.CHECKFU_PROVIDER_SECRET_CUSTOM_LOCAL_HEADER_SECRET
	delete childEnv.CHECKFU_OPENAI_BASE_URL
	delete childEnv.CHECKFU_OPENROUTER_BASE_URL
	delete childEnv.CHECKFU_CLOUDFLARE_AI_GATEWAY_BASE_URL
	delete childEnv.CHECKFU_CLOUDFLARE_WORKERS_AI_BASE_URL
	delete childEnv.CHECKFU_PUBLISH_DOMAIN
	delete childEnv.CHECKFU_API_DOMAIN
	delete childEnv.CHECKFU_MCP_DOMAIN
	delete childEnv.CHECKFU_MACHINE_IDLE
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
	let apiUrl: string | null = null
	let harnessReady = false
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
			apiUrl = match[1].replace(/\/+$/, "")
		}
		harnessReady ||= clean.includes("[PiHarnessWorker] ready at ")
		if (apiUrl !== null && harnessReady && readyUrl === null) {
			readyUrl = apiUrl
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
	}, 180_000)

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

const limitedTo = (allowed_hosts: ReadonlyArray<string>) => ({
	type: "cloud",
	networking: {
		type: "limited",
		allow_mcp_servers: false,
		allow_package_managers: false,
		allowed_hosts,
	},
})

const runsScript = (code: string) => (req: { readonly toolOutputs: ReadonlyArray<unknown> }) =>
	req.toolOutputs.length === 0
		? ({ kind: "tool_call", name: "codemode", arguments: { code } } as const)
		: ({ kind: "reply", text: "Done." } as const)

const userMessage = (text: string) => ({
	type: "user.message",
	content: [{ type: "text", text }],
})

describe("PiSession real Durable Object under workerd", () => {
	let fakeOpenAI: FakeOpenAIResponsesServer
	let baseUrl: string
	let stage: string
	let stopWorker: (() => Promise<void>) | undefined
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
	}, 240_000)

	afterAll(async () => {
		await stopWorker?.()
		await fakeOpenAI?.close()
	}, 30_000)

	const bytesOf = async (artifactId: string, version: number, path: string) => {
		const file = await apiJson<{
			readonly encoding: "utf8" | "base64"
			readonly content: string
		}>(`/v1/artifacts/${artifactId}/versions/${version}/file?file=${encodeURIComponent(path)}`)
		expect(file.status).toBe(200)
		return {
			encoding: file.body.encoding,
			bytes: Buffer.from(file.body.content, file.body.encoding),
		}
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
			apiJson(`${environmentPath}/archive-if-current`, { method: "POST", body: { version: 1 } }),
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
		const cleanup = await apiJson(`${automationPath}/archive-if-current`, {
			method: "POST",
			body: { revision: automation.revision },
		})
		expect([200, 202], JSON.stringify(cleanup.body)).toContain(cleanup.status)
	}, 30_000)

	it("stores uploaded bytes in R2 only when they match their sha256, and serves them raw", async () => {
		const opened = await apiJson<{ readonly id: string; readonly version: number }>(
			"/v1/artifacts",
			{ method: "POST", body: { name: "Bytes" } },
		)
		expect(opened.status).toBe(201)
		expect(opened.body.version).toBe(0)
		const data = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 31 + 7) % 256)
		const sha256 = createHash("sha256").update(data).digest("hex")
		const upload = (hash: string, bytes: Uint8Array<ArrayBuffer> = data) =>
			fetch(`${baseUrl}/v1/artifacts/${opened.body.id}/blobs/${hash}`, {
				method: "PUT",
				headers: {
					...AUTH_HEADERS,
					"content-type": "application/octet-stream",
					"content-length": String(bytes.byteLength),
				},
				body: bytes,
			})
		expect((await upload("0".repeat(64))).status).toBe(400)
		const stored = await upload(sha256)
		expect(stored.status).toBe(200)
		expect((await upload(sha256)).status).toBe(200)
		expect(
			(
				await upload(
					sha256,
					data.map((byte) => 255 - byte),
				)
			).status,
		).toBe(400)
		const empty = new Uint8Array(0)
		const emptySha256 = createHash("sha256").update(empty).digest("hex")
		expect((await upload(emptySha256, empty)).status).toBe(200)
		const version = await apiJson<{ readonly version: number }>(
			`/v1/artifacts/${opened.body.id}/versions`,
			{
				method: "POST",
				body: {
					version: 0,
					files: [
						{ path: "data.bin", sha256 },
						{ path: "empty.txt", sha256: emptySha256 },
					],
				},
			},
		)
		expect(version.status).toBe(201)
		const download = await apiFetch(
			`/v1/artifacts/${opened.body.id}/versions/1/content?file=data.bin`,
		)
		expect(download.status).toBe(200)
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(data)
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

	it("publishes the first output a turn on the machine writes, after a turn that left none", async () => {
		const outputs = "/mnt/session/outputs"
		const steps = new Map<string, ReadonlyArray<FakeOpenAIAction>>(
			Object.entries({
				"Write it on the machine.": [
					{ kind: "tool_call", name: "bash", arguments: { command: "echo up" } },
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: `${outputs}/report.md`, content: "# Late\n" },
					},
				],
			}),
		)
		fakeOpenAI.setHandler(
			(req) =>
				steps.get(req.lastUserText)?.[req.toolOutputs.length] ?? { kind: "reply", text: "Done." },
		)
		const session = await createSession()
		const turn = async (text: string, number: number) => {
			const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [userMessage(text)] },
			})
			expect(sent.status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === number, 240_000)
		}
		const published = () =>
			apiJson<{
				readonly version: number
				readonly files: ReadonlyArray<{ readonly path: string }>
			}>(`/v1/sessions/${session.id}/outputs`)
		await turn("Say hello.", 1)
		await sleep(1000)
		expect((await published()).status).toBe(404)
		await turn("Write it on the machine.", 2)
		const deadline = Date.now() + 30_000
		let current = await published()
		while (current.status !== 200 && Date.now() < deadline) {
			await sleep(100)
			current = await published()
		}
		expect(current.status).toBe(200)
		expect(current.body.files.map(({ path }) => path)).toEqual(["report.md"])
		const archived = await apiFetch(`/v1/sessions/${session.id}/archive`, { method: "POST" })
		expect(archived.status).toBe(200)
	}, 300_000)

	it("publishes what the model leaves in the outputs directory as the session's artifact, byte for byte", async () => {
		const outputs = "/mnt/session/outputs"
		const report = "# Q3\n\nSales rose 12%.\n"
		const totals = "region,total\nEMEA,4217\n"
		const steps = new Map<string, ReadonlyArray<FakeOpenAIAction>>(
			Object.entries({
				"Write the report.": [
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: `${outputs}/report.md`, content: report },
					},
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: `${outputs}/data/totals.csv`, content: totals },
					},
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: "/workspace/notes.md", content: "private" },
					},
				],
				"Add a summary.": [
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: `${outputs}/summary.md`, content: "Up 12%.\n" },
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
		const session = await createSession()
		interface PublishedFile {
			readonly path: string
			readonly sha256: string
			readonly size: number
			readonly content_type: string
		}
		const published = () =>
			apiJson<{
				readonly id: string
				readonly name: string
				readonly version: number
				readonly files: ReadonlyArray<PublishedFile>
			}>(`/v1/sessions/${session.id}/outputs`)
		const publishedAt = async (version: number) => {
			const deadline = Date.now() + 30_000
			for (;;) {
				const current = await published()
				if ((current.status === 200 && current.body.version >= version) || Date.now() > deadline) {
					return current
				}
				await new Promise((resolve) => {
					setTimeout(resolve, 100)
				})
			}
		}
		expect((await published()).status).toBe(404)
		await replyAfterTurn(session.id, "Write the report.", 1)
		const first = await publishedAt(1)
		expect(first.status).toBe(200)
		expect(first.body).toMatchObject({
			name: `Session ${session.id} outputs`,
			version: 1,
			files: [
				{
					path: "data/totals.csv",
					sha256: sha256(Buffer.from(totals)),
					size: Buffer.byteLength(totals),
					content_type: "text/csv",
				},
				{
					path: "report.md",
					sha256: sha256(Buffer.from(report)),
					size: Buffer.byteLength(report),
					content_type: "text/markdown",
				},
			],
		})
		const artifactId = first.body.id
		expect((await bytesOf(artifactId, 1, "report.md")).bytes.toString()).toBe(report)

		await replyAfterTurn(session.id, "Anything else?", 2)
		expect((await published()).body.version).toBe(1)

		await replyAfterTurn(session.id, "Add a summary.", 3)
		const second = await publishedAt(2)
		expect(second.body.version).toBe(2)
		expect(second.body.files.map((file) => file.path)).toEqual([
			"data/totals.csv",
			"report.md",
			"summary.md",
		])
		for (const file of second.body.files) {
			const { bytes } = await bytesOf(artifactId, 2, file.path)
			expect([file.path, bytes.byteLength, sha256(bytes)]).toEqual([
				file.path,
				file.size,
				file.sha256,
			])
		}

		const systemText = fakeOpenAI.requests[startCount]?.messages
			.filter((message) => message.role === "system" || message.role === "developer")
			.map((message) => message.text)
			.join("\n")
		expect(systemText).toContain(
			"Files you leave in /mnt/session/outputs are published as this session's artifact each time your turn ends",
		)
		expect(systemText).toContain("at most 64 files, 1 MiB each and 4 MiB in total")
		expect(systemText).toContain(
			"An empty directory publishes nothing either, so the last version stays.",
		)
	}, 180_000)

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
		const uses = events.filter((e) => e.type === "agent.tool_use")
		const [ran] = uses
		expect(uses.map((e) => e.name)).toEqual(["codemode", "read"])
		expect(ran).toMatchObject({ input: { code: script } })
		const results = events.filter((e) => e.type === "agent.tool_result")
		expect(results.map((e) => e.tool_use_id)).toEqual(uses.map((e) => e.tool_use_id))
		const [ranResult, readResult] = results
		expect(ranResult).toMatchObject({ tool_use_id: ran?.tool_use_id, is_error: false })
		expect(ranResult?.content?.map((block) => block.text).join("")).toContain("MANGO-3")
		expect(readResult?.content?.map((block) => block.text).join("")).toContain("MANGO-3")
		const replies = events.filter((e) => e.type === "agent.message").map((e) => e.content)
		expect(replies[0]?.[0]?.text).toContain("MANGO-3")
		expect(replies[1]?.[0]?.text).toContain("MANGO-3")
	}, 60_000)

	it("saves a script's full output to the workspace when the model sees only part of it", async () => {
		const script = String.raw`text("a".repeat(30000) + "\nMIDDLE-KIWI\n" + "b".repeat(90000))`
		let saved: string | undefined
		fakeOpenAI.setHandler((req) => {
			const [output] = req.toolOutputs
			if (req.lastUserText === "Print a lot.") {
				if (output === undefined) {
					return { kind: "tool_call", name: "codemode", arguments: { code: script } }
				}
				saved = /\[Full output: (\S+) /u.exec(output)?.[1]
				return { kind: "reply", text: `Saved at ${saved ?? "nowhere"}` }
			}
			return output === undefined
				? { kind: "tool_call", name: "read", arguments: { path: saved ?? "/missing" } }
				: { kind: "reply", text: output.includes("MIDDLE-KIWI") ? "Found it." : "Not there." }
		})

		const session = await createSession()
		const send = (text: string) =>
			apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
			})

		expect((await send("Print a lot.")).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)
		expect(saved).toMatch(/^\/workspace\/\.scripts\/pi-codemode-[^/]+\/output\.txt$/u)
		expect((await send("Read it back.")).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 2)

		const events = await listAllEvents(session.id)
		const [scriptResult] = events.filter((e) => e.type === "agent.tool_result")
		expect(scriptResult?.content?.map((block) => block.text).join("")).not.toContain("MIDDLE-KIWI")
		expect(events.filter((e) => e.type === "agent.message").map((e) => e.content)).toEqual([
			[{ type: "text", text: `Saved at ${saved ?? ""}` }],
			[{ type: "text", text: "Found it." }],
		])
	}, 90_000)

	it("settles a turn whose script emits an image past the result budget, with the result-size error", async () => {
		const script = `image("data:image/png;base64,iVBORw0KGgoA" + "A".repeat(${4 * Math.ceil((1.2 * 1024 * 1024) / 3)})); return "drew"`
		fakeOpenAI.setHandler((req) => {
			const [output] = req.toolOutputs
			return output === undefined
				? { kind: "tool_call", name: "codemode", arguments: { code: script } }
				: { kind: "reply", text: "Drawn." }
		})

		const session = await createSession()
		const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: {
				events: [{ type: "user.message", content: [{ type: "text", text: "Draw it." }] }],
			},
		})
		expect(sent.status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 60_000)

		const events = await listAllEvents(session.id)
		const [result] = events.filter((e) => e.type === "agent.tool_result")
		expect(result?.is_error).toBe(true)
		expect(result?.content?.map((block) => block.text).join("")).toContain(
			"Write large output to a file in /workspace",
		)
		expect(events.filter((e) => e.type === "agent.message").map((e) => e.content)).toEqual([
			[{ type: "text", text: "Drawn." }],
		])
	}, 90_000)

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
	it("keeps a credential's secret in its vault's connection object until the credential ends", async () => {
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

		expect((await rotate()).status).toBe(200)

		const prefix = "https://mcp.example.com/"
		const longest = `${prefix}${"a".repeat(2048 - prefix.length)}`
		const long = await apiJson<{ readonly id: string }>(`/v1/vaults/${vault.id}/credentials`, {
			method: "POST",
			body: { auth: { type: "static_bearer", token, mcp_server_url: longest } },
		})
		expect(long.status).toBe(201)
		const repeated = await apiJson(`/v1/vaults/${vault.id}/credentials`, {
			method: "POST",
			body: { auth: { type: "static_bearer", token, mcp_server_url: longest } },
		})
		expect(repeated.status).toBe(409)

		const listed = async () =>
			(
				await apiJson<{ readonly data: ReadonlyArray<{ readonly id: string }> }>(
					`/v1/vaults/${vault.id}/credentials?order=desc`,
					{ method: "GET" },
				)
			).body.data.map(({ id }) => id)
		const listDeadline = Date.now() + 10_000
		while ((await listed()).length < 2 && Date.now() < listDeadline) {
			await sleep(100)
		}
		expect(await listed()).toEqual([long.body.id, credential.id])

		const archived = await apiJson<{
			readonly archived_at: string | null
			readonly custody: string
		}>(`${path}/archive`, { method: "POST" })
		expect(archived.status).toBe(200)
		expect(archived.body.archived_at).not.toBeNull()
		expect(archived.body.custody).toBe("erased")
		const afterArchive = await rotate()
		expect(afterArchive.status).toBe(409)
		expect(afterArchive.body.error?.message).toContain("is archived")

		const deleted = await apiJson<{ readonly type: string }>(path, { method: "DELETE" })
		expect(deleted).toEqual({
			status: 200,
			body: { id: credential.id, type: "vault_credential_deleted", custody: "erased" },
		})

		const ended = await apiJson<{
			readonly custody: { readonly held: number; readonly erasing: number }
		}>(`/v1/vaults/${vault.id}/archive`, { method: "POST" })
		expect(ended.status).toBe(200)
		expect(ended.body.custody.held).toBe(0)
		const owed = async () =>
			(
				await apiJson<{ readonly custody: { readonly erasing: number } }>(
					`/v1/vaults/${vault.id}`,
					{ method: "GET" },
				)
			).body.custody.erasing
		const vaultDeadline = Date.now() + 10_000
		while ((await owed()) !== 0 && Date.now() < vaultDeadline) {
			await sleep(100)
		}
		expect(await owed()).toBe(0)
		const longAfter = await apiJson<{ readonly custody: string }>(
			`/v1/vaults/${vault.id}/credentials/${long.body.id}`,
			{ method: "GET" },
		)
		expect(longAfter.body.custody).toBe("erased")
		expect((await apiFetch(path)).status).toBe(404)
		expect((await rotate()).status).toBe(404)

		const logDeadline = Date.now() + 10_000
		while (
			!stripAnsi(workerLogs.join("")).includes("Vault secrets erased") &&
			Date.now() < logDeadline
		) {
			await sleep(100)
		}
		const logged = stripAnsi(workerLogs.join(""))
		expect(logged).toContain("Credential secret erased")
		expect(logged).toContain("Vault secrets erased")
		expect(logged).toContain(credential.id)
		expect(logged).not.toContain(token)
		expect(logged).not.toContain(replacement)
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

	it("previews model text live and reconciles it to the buffered event", async () => {
		fakeOpenAI.setHandler(async () => {
			await sleep(300)
			return { kind: "reply", text: "Live preview." }
		})
		const session = await createSession()
		const client = new Checkfu({ baseUrl, apiKey: TEST_API_KEY })
		try {
			const stream = await client.sessions.events.stream(session.id, undefined, {
				event_deltas: ["agent.message"],
			})
			await client.sessions.events.send(session.id, {
				events: [
					{ type: "user.message", content: [{ type: "text", text: "Show a live preview" }] },
				],
			})
			let eventId: string | undefined
			let preview: SessionMessagePreview | undefined
			let final:
				| { readonly id: string; readonly content: ReadonlyArray<{ readonly text: string }> }
				| undefined
			for await (const event of stream) {
				if (event.type === "event_start" && event.event.type === "agent.message") {
					eventId = event.event.id
				}
				if (event.type === "event_start" || event.type === "event_delta") {
					expect(final).toBeUndefined()
					preview = accumulateSessionEvent(preview, event)
				}
				if (event.type === "agent.message") {
					final = event
				}
				if (event.type === "session.status_idle") {
					break
				}
			}
			expect(preview?.content[0]?.text).toBe("Live preview.")
			expect(final?.id).toBe(eventId)
			expect(final?.content).toEqual([{ type: "text", text: "Live preview." }])
			const saved = await listAllEvents(session.id)
			expect(
				saved.some((event) => event.type === "event_start" || event.type === "event_delta"),
			).toBe(false)
			expect(saved.find((event) => event.type === "agent.message")?.id).toBe(eventId)
			const filtered: Array<string> = []
			for await (const event of client.sessions.events.list(session.id, {
				types: ["user.message", "agent.message"],
				limit: 1,
			})) {
				filtered.push(event.type)
			}
			expect(filtered).toEqual(["user.message", "agent.message"])
		} finally {
			await client.close()
		}
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

	it("starts a machine at the first command and moves the working directory into it, where only it survives a sleep", async () => {
		const dir = "/workspace/shell"
		const steps = new Map<string, ReadonlyArray<FakeOpenAIAction>>(
			Object.entries({
				"Note it.": [
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: `${dir}/notes.txt`, content: "from the file tool\n" },
					},
				],
				"Run it.": [
					{
						kind: "tool_call",
						name: "bash",
						arguments: {
							command:
								"cat notes.txt && echo built > out.txt && git --version >/dev/null && node --version",
							cwd: dir,
						},
					},
				],
				"Read what it built.": [
					{ kind: "tool_call", name: "read", arguments: { path: `${dir}/out.txt` } },
				],
				"Find the text files.": [
					{ kind: "tool_call", name: "find", arguments: { path: dir, pattern: "*.txt" } },
				],
				"Search for it.": [
					{ kind: "tool_call", name: "grep", arguments: { path: dir, query: "built" } },
				],
				"Write a changelog and see it.": [
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: `${dir}/CHANGELOG.md`, content: "## 2.0.0\n" },
					},
					{ kind: "tool_call", name: "bash", arguments: { command: `cat ${dir}/CHANGELOG.md` } },
				],
				"Leave a mark outside.": [
					{
						kind: "tool_call",
						name: "bash",
						arguments: { command: "touch /tmp/outside ~/.outside && echo left" },
					},
				],
				"Is it still there?": [
					{
						kind: "tool_call",
						name: "bash",
						arguments: {
							command: "cat out.txt CHANGELOG.md; ls /tmp/outside ~/.outside 2>/dev/null | wc -l",
							cwd: dir,
						},
					},
				],
				"Fail.": [
					{ kind: "tool_call", name: "bash", arguments: { command: "echo no >&2; exit 3" } },
				],
				"Take too long.": [
					{ kind: "tool_call", name: "bash", arguments: { command: "sleep 30", timeout: 1 } },
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
		const session = await createSession()
		let number = 0
		const turn = async (text: string) => {
			number += 1
			const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [userMessage(text)] },
			})
			expect(sent.status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === number, 240_000)
			const replies = (await listAllEvents(session.id)).filter((e) => e.type === "agent.message")
			return replies.at(-1)?.content?.[0]?.text ?? ""
		}

		expect(await turn("Note it.")).toContain("Done: ")
		expect(await turn("Run it.")).toContain("from the file tool\nv")
		expect(await turn("Read what it built.")).toContain("built")
		const found = await turn("Find the text files.")
		expect(found).toContain(`${dir}/notes.txt`)
		expect(found).toContain(`${dir}/out.txt`)
		expect(await turn("Search for it.")).toContain(
			`"path":"${dir}/out.txt","line":1,"text":"built"`,
		)
		expect(await turn("Write a changelog and see it.")).toBe("Done: ## 2.0.0")
		expect(await turn("Fail.")).toBe("Done: no\n[Exit code 3.]")
		expect(await turn("Take too long.")).toBe("Done: [Stopped after 1 seconds.]")

		expect(await turn("Leave a mark outside.")).toBe("Done: left")
		const logged = (line: string) =>
			stripAnsi(workerLogs.join(""))
				.split("\n")
				.some((entry) => entry.includes(line) && entry.includes(session.id))
		const within = async (ms: number, line: string) => {
			const deadline = Date.now() + ms
			while (!logged(line) && Date.now() < deadline) {
				await sleep(250)
			}
			return logged(line)
		}
		expect(await within(120_000, "Machine asleep")).toBe(true)
		expect(await turn("Is it still there?")).toBe("Done: built\n## 2.0.0\n0")

		const archived = await apiFetch(`/v1/sessions/${session.id}/archive`, { method: "POST" })
		expect(archived.status).toBe(200)
		expect(await within(60_000, "Machine removed")).toBe(true)
	}, 900_000)

	it("holds a machine to the hosts its environment allows", async () => {
		fakeOpenAI.setHandler((req) =>
			req.toolOutputs.length === 0
				? {
						kind: "tool_call",
						name: "bash",
						arguments: {
							command:
								"curl -fsS -m 5 -o /dev/null https://example.org 2>/dev/null && echo reached || echo refused",
						},
					}
				: { kind: "reply", text: `Done: ${req.toolOutputs.at(-1) ?? ""}` },
		)
		const limited = await createResource<{ readonly id: string }>("/v1/environments", {
			name: "Workerd Limited Env",
			config: {
				type: "cloud",
				networking: {
					type: "limited",
					allowed_hosts: ["github.com"],
					allow_mcp_servers: false,
					allow_package_managers: false,
				},
			},
		})
		const session = await createResource<SessionResource>("/v1/sessions", {
			agent: agentId,
			environment_id: limited.id,
		})
		const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: { events: [userMessage("Reach out.")] },
		})
		expect(sent.status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 240_000)
		const reply = (await listAllEvents(session.id)).findLast((e) => e.type === "agent.message")
		expect(reply?.content?.[0]?.text).toBe("Done: refused")
		const archived = await apiFetch(`/v1/sessions/${session.id}/archive`, { method: "POST" })
		expect(archived.status).toBe(200)
	}, 300_000)

	it("holds the machine already running to a network its environment tightens, from the next request", async () => {
		fakeOpenAI.setHandler((req) => {
			const command = { "Start it.": "echo alive > /tmp/alive && echo up" }[req.lastUserText]
			const reach =
				"cat /tmp/alive; curl -fsS -m 5 -o /dev/null https://example.org 2>/dev/null && echo reached || echo refused"
			return req.toolOutputs.length > 0
				? { kind: "reply", text: `Done: ${req.toolOutputs.at(-1) ?? ""}` }
				: command !== undefined
					? { kind: "tool_call", name: "bash", arguments: { command } }
					: req.lastUserText === "Reach out."
						? { kind: "tool_call", name: "bash", arguments: { command: reach } }
						: { kind: "reply", text: "Nothing to run." }
		})
		const environment = await createResource<{ readonly id: string; readonly version: number }>(
			"/v1/environments",
			{ name: "Workerd Tightened Env" },
		)
		const session = await createResource<SessionResource>("/v1/sessions", {
			agent: agentId,
			environment_id: environment.id,
		})
		let number = 0
		const turn = async (text: string) => {
			number += 1
			const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
			})
			expect(sent.status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === number, 240_000)
			return (await listAllEvents(session.id)).findLast((e) => e.type === "agent.message")
				?.content?.[0]?.text
		}
		expect(await turn("Start it.")).toBe("Done: up")
		const tightened = await apiJson(`/v1/environments/${environment.id}`, {
			method: "POST",
			body: {
				version: environment.version,
				config: {
					type: "cloud",
					networking: {
						type: "limited",
						allowed_hosts: [],
						allow_mcp_servers: false,
						allow_package_managers: false,
					},
				},
			},
		})
		expect(tightened.status).toBe(200)
		const started = Date.now()
		expect(await turn("Reach out.")).toBe("Done: alive\nrefused")
		expect(Date.now() - started).toBeLessThan(60_000)
		const archived = await apiFetch(`/v1/sessions/${session.id}/archive`, { method: "POST" })
		expect(archived.status).toBe(200)
	}, 600_000)

	it("stops a command when its turn is interrupted, so the next turn is not kept waiting", async () => {
		const counting = "while true; do date >> /workspace/ticks; sleep 0.2; done"
		fakeOpenAI.setHandler((req) =>
			req.toolOutputs.length > 0
				? { kind: "reply", text: `Done: ${req.toolOutputs.at(-1) ?? ""}` }
				: req.lastUserText === "Start the machine."
					? { kind: "tool_call", name: "bash", arguments: { command: "echo up" } }
					: req.lastUserText === "Count."
						? { kind: "tool_call", name: "bash", arguments: { command: counting, timeout: 600 } }
						: {
								kind: "tool_call",
								name: "bash",
								arguments: {
									command:
										'a=$(wc -l < /workspace/ticks); sleep 1; b=$(wc -l < /workspace/ticks); [ "$a" -gt 0 ] && [ "$a" = "$b" ] && echo stopped',
								},
							},
		)
		const session = await createSession()
		const send = (events: ReadonlyArray<unknown>) =>
			apiJson(`/v1/sessions/${session.id}/events`, { method: "POST", body: { events } })
		expect((await send([userMessage("Start the machine.")])).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 240_000)
		expect((await send([userMessage("Count.")])).status).toBe(200)
		await fakeOpenAI.waitForRequest((req) => req.lastUserText === "Count.")
		await sleep(3000)
		const interruptedAt = Date.now()
		expect((await send([{ type: "user.interrupt" }])).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 2, 60_000)
		expect((await send([userMessage("Is it still counting?")])).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 3, 60_000)
		expect(Date.now() - interruptedAt).toBeLessThan(60_000)
		const reply = (await listAllEvents(session.id)).findLast((e) => e.type === "agent.message")
		expect(reply?.content?.[0]?.text).toBe("Done: stopped")
		const archived = await apiFetch(`/v1/sessions/${session.id}/archive`, { method: "POST" })
		expect(archived.status).toBe(200)
	}, 300_000)

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
				`/v1/artifacts/${id}/versions/${version}/file?file=${encodeURIComponent(path)}`,
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

	it("calls MCP servers from scripts and, once found, directly, keeping the credential in its connection", async () => {
		const token = "tok/mcp+SECRET&workerd=1"
		const secure = await startFakeMcpServer([token], { stateful: true })
		const open = await startFakeMcpServer(null, { modern: true })
		try {
			const agent = await createResource<{ readonly id: string }>("/v1/agents", {
				name: "MCP Agent",
				model: "gpt-4o-mini",
				mcp_servers: [
					{ type: "url", name: "secure", url: secure.url },
					{ type: "url", name: "open", url: open.url },
				],
				tools: ["secure", "open"].map((mcp_server_name) => ({
					type: "mcp_toolset",
					mcp_server_name,
					default_config: { permission_policy: { type: "always_allow" } },
				})),
			})
			const vaults = await Promise.all(
				[0, 1].map(() =>
					createResource<{ readonly id: string }>("/v1/vaults", { display_name: "mcp" }),
				),
			)
			const credentials = await Promise.all(
				vaults.map((vault) =>
					createResource<{ readonly id: string }>(`/v1/vaults/${vault.id}/credentials`, {
						auth: { type: "static_bearer", token, mcp_server_url: secure.url },
					}),
				),
			)
			const vault_ids = vaults.map((vault) => vault.id)
			const ambiguous = await apiFetch("/v1/sessions", {
				method: "POST",
				body: { agent: agent.id, environment_id: environmentId, vault_ids },
			})
			expect(ambiguous.status).toBe(400)
			expect(await ambiguous.text()).toContain(String.raw`\"secure\"`)

			const script =
				'const leaked = await tools.mcp__secure__leak({}); const echoed = await tools.mcp__open__echo({ text: "from-script" }); return [JSON.stringify(leaked), echoed].join(" ");'
			fakeOpenAI.setHandler((req) => {
				switch (req.toolOutputs.length) {
					case 0:
						return { kind: "tool_call", name: "mcp__open__echo", arguments: { text: "too-early" } }
					case 1:
						return { kind: "tool_call", name: "codemode", arguments: { code: script } }
					case 2:
						return { kind: "tool_call", name: "tool_search", arguments: { query: "echo" } }
					case 3:
						return { kind: "tool_call", name: "mcp__open__echo", arguments: { text: "direct" } }
					default:
						return { kind: "reply", text: "Done." }
				}
			})
			const run = async () => {
				const session = await createResource<SessionResource & { mcp_server_credentials: unknown }>(
					"/v1/sessions",
					{
						agent: agent.id,
						environment_id: environmentId,
						vault_ids,
						mcp_server_credentials: [
							{ mcp_server_name: "secure", credential_id: credentials[1]?.id },
						],
					},
				)
				expect(session.mcp_server_credentials).toEqual([
					{
						mcp_server_name: "secure",
						credential_id: credentials[1]?.id,
						vault_id: vaults[1]?.id,
					},
				])
				const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
					method: "POST",
					body: {
						events: [{ type: "user.message", content: [{ type: "text", text: "Use the tools." }] }],
					},
				})
				expect(sent.status).toBe(200)
				await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 60_000)
				return { session, events: await listAllEvents(session.id) }
			}

			const first = await run()
			const second = await run()

			expect(secure.calls.map((call) => [call.tool, call.token])).toEqual([
				["leak", token],
				["leak", token],
			])
			const upstreamSessions = secure.calls.map((call) => call.session)
			expect(new Set(upstreamSessions).size).toBe(2)
			expect(open.calls.map((call) => [call.arguments, call.token])).toEqual([
				[{ text: "from-script" }, undefined],
				[{ text: "direct" }, undefined],
				[{ text: "from-script" }, undefined],
				[{ text: "direct" }, undefined],
			])

			const { events } = first
			const mcpUses = events.filter((e) => e.type === "agent.mcp_tool_use")
			expect(mcpUses.map((e) => [e.mcp_server_name, e.name])).toEqual([
				["open", "echo"],
				["open", "echo"],
			])
			expect(mcpUses.map((e) => e.input)).toEqual([{ text: "too-early" }, { text: "direct" }])
			for (const use of mcpUses) {
				expect(toolUseOf(toolUseIdFromEvent(first.session.id, use.tool_use_id ?? ""))).toBeDefined()
			}
			const mcpResults = events.filter((e) => e.type === "agent.mcp_tool_result")
			expect(
				mcpResults.map((e) => e.tool_use_id).toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
			).toEqual(
				mcpUses.map((e) => e.tool_use_id).toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
			)
			expect(mcpResults.find((e) => e.tool_use_id === mcpUses[0]?.tool_use_id)?.is_error).toBe(true)
			expect(mcpResults.find((e) => e.tool_use_id === mcpUses[1]?.tool_use_id)?.is_error).toBe(
				false,
			)

			const visible = JSON.stringify([first, second, workerLogs])
			for (const form of [
				token,
				encodeURIComponent(token),
				new URLSearchParams({ s: token }).toString().slice(2),
				JSON.stringify(token).slice(1, -1),
			]) {
				expect(visible).not.toContain(form)
			}
			expect(visible).toContain("[redacted]")
		} finally {
			await secure.close()
			await open.close()
		}
	}, 120_000)

	it("sends a session's server nothing with a credential once its archive, its delete or its vault's archive has answered", async () => {
		const token = "tok-revoked-workerd-secret-1"
		const secure = await startFakeMcpServer([token])
		try {
			const agent = await createResource<{ readonly id: string }>("/v1/agents", {
				name: "Revoked MCP Agent",
				model: "gpt-4o-mini",
				mcp_servers: [{ type: "url", name: "secure", url: secure.url }],
				tools: [
					{
						type: "mcp_toolset",
						mcp_server_name: "secure",
						default_config: { permission_policy: { type: "always_allow" } },
					},
				],
			})
			const script =
				'try { return await tools.mcp__secure__echo({ text: "hi" }) } catch (e) { return String(e) }'
			const revocations: ReadonlyArray<
				(vaultId: string, credentialId: string) => readonly [string, string]
			> = [
				(vaultId, credentialId) => [
					"POST",
					`/v1/vaults/${vaultId}/credentials/${credentialId}/archive`,
				],
				(vaultId, credentialId) => ["DELETE", `/v1/vaults/${vaultId}/credentials/${credentialId}`],
				(vaultId) => ["POST", `/v1/vaults/${vaultId}/archive`],
			]
			for (const revoke of revocations) {
				const vault = await createResource<{ readonly id: string }>("/v1/vaults", {
					display_name: "revoked",
				})
				const credential = await createResource<{ readonly id: string }>(
					`/v1/vaults/${vault.id}/credentials`,
					{ auth: { type: "static_bearer", token, mcp_server_url: secure.url } },
				)
				const session = await createResource<SessionResource>("/v1/sessions", {
					agent: agent.id,
					environment_id: environmentId,
					vault_ids: [vault.id],
				})
				const turn = async (number: number) => {
					fakeOpenAI.setHandler(runsScript(script))
					const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
						method: "POST",
						body: {
							events: [{ type: "user.message", content: [{ type: "text", text: "Call it." }] }],
						},
					})
					expect(sent.status).toBe(200)
					await waitForSession(session.id, (s) => s.status === "idle" && s.turn === number, 60_000)
					const events = await listAllEvents(session.id)
					const use = events.filter((e) => e.type === "agent.tool_use" && e.name === "codemode")[
						number - 1
					]
					return (
						events
							.find((e) => e.type === "agent.tool_result" && e.tool_use_id === use?.tool_use_id)
							?.content?.map((block) => block.text)
							.join("") ?? ""
					)
				}

				expect(await turn(1)).toContain("echo:hi")
				const authenticated = secure.tokens.filter((sent) => sent === token).length
				expect(authenticated).toBeGreaterThan(0)

				const [method, path] = revoke(vault.id, credential.id)
				expect((await apiJson(path, { method })).status).toBe(200)
				const after = await turn(2)
				expect(after).toContain("archived or deleted")
				expect(after).not.toContain("echo:hi")
				expect(secure.tokens.filter((sent) => sent === token).length).toBe(authenticated)
			}
		} finally {
			await secure.close()
		}
	}, 240_000)

	it("refuses at the session object what changed since admission, keeps one server's trouble to itself, and sends nothing once interrupted", async () => {
		const raw = await startScriptedMcpServer()
		const huge = await startScriptedMcpServer({ pages: 40, pageBytes: 64 * 1024 })
		try {
			const hosts = [raw, huge].map((server) => new URL(server.url).host)
			const environment = await createResource<{ readonly id: string }>("/v1/environments", {
				name: "MCP rules",
				config: limitedTo(hosts),
			})
			const agent = await createResource<{ readonly id: string }>("/v1/agents", {
				name: "Scripted MCP Agent",
				model: "gpt-4o-mini",
				mcp_servers: [
					{ type: "url", name: "raw", url: raw.url },
					{ type: "url", name: "huge", url: huge.url },
				],
				tools: ["raw", "huge"].map((mcp_server_name) => ({
					type: "mcp_toolset",
					mcp_server_name,
					default_config: { permission_policy: { type: "always_allow" } },
				})),
			})
			const session = await createResource<SessionResource>("/v1/sessions", {
				agent: agent.id,
				environment_id: environment.id,
			})
			const say = async (text: string) => {
				const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
					method: "POST",
					body: { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
				})
				expect(sent.status).toBe(200)
			}
			const rules = async (version: number, allowed: ReadonlyArray<string>) => {
				const updated = await apiJson(`/v1/environments/${environment.id}`, {
					method: "POST",
					body: { version, config: limitedTo(allowed) },
				})
				expect(updated.status).toBe(200)
			}
			const scriptResult = async (nth: number) => {
				const events = await listAllEvents(session.id)
				const use = events.filter((e) => e.type === "agent.tool_use" && e.name === "codemode")[nth]
				const result = events.find(
					(e) => e.type === "agent.tool_result" && e.tool_use_id === use?.tool_use_id,
				)
				return result?.content?.map((block) => block.text).join("") ?? ""
			}

			const together = [
				"const settled = await Promise.allSettled([",
				"  tools.mcp__raw__boom({}),",
				'  tools.mcp__raw__echo({ text: "beside", delay_ms: 100 }),',
				"]);",
				"return JSON.stringify(settled.map((one) => one.status === 'fulfilled' ? one.value : String(one.reason)));",
			].join("\n")
			fakeOpenAI.setHandler(runsScript(together))
			await say("Call both.")
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 60_000)
			const both = await scriptResult(0)
			expect(both).toContain("boom failed")
			expect(both).toContain("echo:beside:scripted-1")
			expect(raw.methods.filter((method) => method === "initialize")).toHaveLength(1)
			const pages = huge.methods.filter((method) => method === "tools/list").length
			expect(pages).toBeGreaterThan(1)
			expect(pages).toBeLessThanOrEqual(5)
			expect(huge.methods).not.toContain("tools/call")

			await rules(1, [])
			const before = raw.methods.length
			fakeOpenAI.setHandler(
				runsScript(
					'try { return await tools.mcp__raw__echo({ text: "after" }) } catch (e) { return String(e) }',
				),
			)
			await say("Call again.")
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 2, 60_000)
			expect(await scriptResult(1)).toContain("network rules do not allow")
			expect(raw.methods.length).toBe(before)

			await rules(2, hosts)
			raw.expireSessions()
			const release = raw.holdHandshakes()
			fakeOpenAI.setHandler((req) => {
				switch (req.toolOutputs.length) {
					case 0:
						return { kind: "tool_call", name: "tool_search", arguments: { query: "echo" } }
					case 1:
						return { kind: "tool_call", name: "mcp__raw__echo", arguments: { text: "expired" } }
					case 2:
						return { kind: "tool_call", name: "mcp__raw__echo", arguments: { text: "never" } }
					default:
						return { kind: "reply", text: "Done." }
				}
			})
			await say("Call once more.")
			const deadline = Date.now() + 30_000
			while (!raw.methods.slice(before).includes("initialize")) {
				expect(Date.now(), raw.methods.slice(before).join()).toBeLessThan(deadline)
				await sleep(20)
			}
			const interrupted = await apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [{ type: "user.interrupt" }] },
			})
			expect(interrupted.status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 3, 60_000)
			release()
			await sleep(500)
			expect(raw.methods.slice(before)).toEqual(["tools/call", "server/discover", "initialize"])
		} finally {
			await raw.close()
			await huge.close()
		}
	}, 180_000)

	it("pauses a turn on a call that asks and on a custom tool, and goes on once each is answered", async () => {
		const open = await startFakeMcpServer(null, { modern: true })
		try {
			const agent = await createResource<{ readonly id: string }>("/v1/agents", {
				name: "Asking Agent",
				model: "gpt-4o-mini",
				mcp_servers: [{ type: "url", name: "open", url: open.url }],
				tools: [
					{
						type: "custom",
						name: "lookup_order",
						description: "Looks an order up",
						input_schema: {
							type: "object",
							properties: { order: { type: "integer" } },
							required: ["order"],
						},
					},
				],
			})
			fakeOpenAI.setHandler((req) => {
				switch (req.toolOutputs.length) {
					case 0:
						return { kind: "tool_call", name: "tool_search", arguments: { query: "echo" } }
					case 1:
						return { kind: "tool_call", name: "mcp__open__echo", arguments: { text: "approved" } }
					case 2:
						return { kind: "tool_call", name: "lookup_order", arguments: { order: "42" } }
					default:
						return { kind: "reply", text: "Done." }
				}
			})
			const session = await createResource<SessionResource>("/v1/sessions", {
				agent: agent.id,
				environment_id: environmentId,
			})
			const send = (event: unknown) =>
				apiJson(`/v1/sessions/${session.id}/events`, { method: "POST", body: { events: [event] } })
			expect(
				(await send({ type: "user.message", content: [{ type: "text", text: "Go." }] })).status,
			).toBe(200)
			const waitingOn = async (count: number) => {
				for (let attempt = 0; attempt < 600; attempt++) {
					const events = await listAllEvents(session.id)
					const pauses = events.filter(
						(e) => e.type === "session.status_idle" && e.stop_reason?.type === "requires_action",
					)
					if (pauses.length >= count) {
						return { events, ids: pauses.at(-1)?.stop_reason?.event_ids ?? [] }
					}
					await sleep(100)
				}
				throw new Error(`the turn did not pause ${count} times`)
			}
			const first = await waitingOn(1)
			const asked = first.events.find((e) => e.type === "agent.mcp_tool_use")
			expect(asked).toMatchObject({
				name: "echo",
				evaluated_permission: "ask",
				input: { text: "approved" },
			})
			expect(first.ids).toEqual([asked?.tool_use_id])
			expect(open.calls).toEqual([])
			expect(
				(
					await send({
						type: "user.tool_confirmation",
						tool_use_id: asked?.tool_use_id,
						result: "allow",
					})
				).status,
			).toBe(200)
			const second = await waitingOn(2)
			const custom = second.events.find((e) => e.type === "agent.custom_tool_use")
			expect(custom).toMatchObject({ name: "lookup_order", input: { order: 42 } })
			expect(open.calls.map((call) => call.arguments)).toEqual([{ text: "approved" }])
			expect(
				(
					await send({
						type: "user.custom_tool_result",
						custom_tool_use_id: custom?.tool_use_id,
						content: [{ type: "text", text: "shipped" }],
					})
				).status,
			).toBe(200)
			let events = await listAllEvents(session.id)
			for (
				let attempt = 0;
				attempt < 600 && !events.some((e) => e.type === "agent.message");
				attempt++
			) {
				await sleep(100)
				events = await listAllEvents(session.id)
			}
			const last = events.filter((e) => e.type === "session.status_idle").at(-1)
			expect(last?.stop_reason?.type).toBe("end_turn")
			expect(events.find((e) => e.type === "agent.message")?.content?.[0]?.text).toBe("Done.")
			expect(events.filter((e) => e.type === "agent.mcp_tool_use")).toHaveLength(1)
		} finally {
			await open.close()
		}
	}, 120_000)
})
