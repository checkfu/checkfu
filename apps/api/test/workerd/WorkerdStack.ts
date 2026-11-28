import { execFileSync, spawn } from "node:child_process"
import { createHash, createHmac } from "node:crypto"
import type { ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type * as Schema from "effect/Schema"
import { removeStage } from "./StageCleanup.ts"

export const REPO_ROOT = resolve(import.meta.dirname, "../../../..")
export const TEST_API_KEY = "ck_workerd_test_key"
export const TEST_OPENAI_KEY = "sk-workerd-fake-key"
const TEST_ANTHROPIC_KEY = "sk-ant-workerd-fake-key"
const TEST_OPENROUTER_KEY = "sk-or-v1-workerd-fake-key"
const TEST_CLOUDFLARE_AI_KEY = "cf-ai-workerd-fake-key"
export const TEST_CUSTOM_PROVIDER_ID = "custom-local"
export const TEST_CUSTOM_API_KEY = "sk-custom-workerd-fake-key"
export const TEST_CUSTOM_HEADER_SECRET = "hdr-custom-workerd-secret"
export const TEST_GITHUB_TOKEN = "ghp_workerd_fake_token"
export const AUTH_HEADERS = {
	authorization: `Bearer ${TEST_API_KEY}`,
}

export interface SessionResource {
	readonly id: string
	readonly status: string
	readonly turn: number
	readonly archived_at: string | null
}

export interface SessionEventItem {
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

interface ApiRequestOptions {
	readonly method?: string
	readonly body?: unknown
	readonly headers?: Readonly<Record<string, string>>
}

const LOCAL_R2_ACCESS_KEY = "alchemy-local-r2"
const LOCAL_R2_SECRET_KEY = "alchemy-local-r2-secret"

export const sha256Hex = (data: string) => createHash("sha256").update(data).digest("hex")
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest()

export const localR2 = (
	baseUrl: string,
	method: string,
	bucket: string,
	key: string,
	body = "",
) => {
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

export const artifactBucketName = (stage: string): string => {
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

export const sha256 = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex")

export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms)
	})

export const parseResponseJson = <T>(
	method: string,
	path: string,
	status: number,
	raw: string,
): T => {
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

export const stripAnsi = (text: string): string => text.replaceAll(ANSI_ESCAPE_RE, "")

const WORKERS = ["ApiWorker", "PiHarnessWorker"] as const

export const boundEnv = (stage: string, worker: (typeof WORKERS)[number]): object => {
	const saved = JSON.parse(
		readFileSync(join(REPO_ROOT, ".alchemy", "state", "Checkfu", stage, `${worker}.json`), "utf8"),
	) as { readonly props?: { readonly env?: object } }
	return saved.props?.env ?? {}
}

export const boundNames = (
	stage: string,
	worker: (typeof WORKERS)[number],
): ReadonlyArray<string> => Object.keys(boundEnv(stage, worker))

export const webhookFanoutFixture = {
	config: "apps/api/test/workerd/WebhookFanoutFixture.stack.ts",
	stack: "WebhookFanoutFixture",
	worker: "FanoutTestWorker",
}

const dockerStartupLimitMs = 15_000
const dockerAttemptLimitMs = 2000
const dockerRetryDelayMs = 250

export const dockerServerVersion = (
	timeout: number,
	executable = "docker",
	args: ReadonlyArray<string> = ["version", "--format", "{{.Server.Version}}"],
) =>
	execFileSync(executable, args, {
		encoding: "utf8",
		timeout,
		killSignal: "SIGKILL",
		stdio: "pipe",
	}).trim()

const dockerStarting = (error: unknown): boolean => {
	if (!(error instanceof Error)) {
		return false
	}
	if ("code" in error && error.code === "ETIMEDOUT") {
		return true
	}
	const stderr =
		"stderr" in error && typeof error.stderr === "string" ? error.stderr : error.message
	return (
		!/permission denied|access is denied/iu.test(stderr) &&
		/cannot connect|connection refused|daemon is starting|no such file or directory|the system cannot find the file specified/iu.test(
			stderr,
		)
	)
}

export const waitForDocker = async (
	probe: (timeout: number) => string = dockerServerVersion,
	budgetMs = dockerStartupLimitMs,
): Promise<string> => {
	const deadline = performance.now() + budgetMs
	let cause: Error | undefined
	while (true) {
		const remaining = Math.floor(deadline - performance.now())
		if (remaining < 1) {
			break
		}
		try {
			const version = probe(Math.min(remaining, dockerAttemptLimitMs))
			if (version !== "" && version !== "<no value>") {
				return version
			}
			cause = new Error("Docker did not return a daemon version.")
		} catch (error) {
			cause = error instanceof Error ? error : new Error(String(error))
			if (!dockerStarting(error)) {
				break
			}
		}
		const delay = Math.min(dockerRetryDelayMs, Math.floor(deadline - performance.now()))
		if (delay > 0) {
			await sleep(delay)
		}
	}
	throw new Error("The local sandbox tests need a running Docker daemon.", { cause })
}

interface WorkerdDevOptions {
	readonly fixture?: typeof webhookFanoutFixture
	readonly webhookEgressUrl?: string
}

export const startAlchemyDev = async (
	openAIBaseUrl: string,
	gitHubBaseUrl: string,
	stage = `wd-${process.pid.toString(36)}-${Date.now().toString(36).slice(-4)}`,
	options?: WorkerdDevOptions,
) => {
	const fixture = options?.fixture
	if (fixture === undefined) {
		const start = performance.now()
		const version = await waitForDocker()
		if (process.env["CHECKFU_LOG_DOCKER_READINESS"] === "1") {
			process.stderr.write(
				`Docker daemon ${version} ready after ${Math.round(performance.now() - start)} ms.\n`,
			)
		}
	}
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
				`CHECKFU_GITHUB_BASE_URL=${gitHubBaseUrl}`,
				"CHECKFU_MACHINE_IDLE=10 seconds",
				...(options?.webhookEgressUrl === undefined
					? []
					: [`CHECKFU_WEBHOOK_EGRESS_URL=${options.webhookEgressUrl}`]),
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
	delete childEnv.CHECKFU_GITHUB_BASE_URL
	delete childEnv.CHECKFU_MACHINE_IDLE
	delete childEnv.CHECKFU_LOCAL_DEV
	delete childEnv.CHECKFU_WEBHOOK_LOCAL_RUNTIME
	delete childEnv.CHECKFU_WEBHOOK_EGRESS_URL
	delete childEnv.CHECKFU_WEBHOOK_EGRESS_TOKEN
	delete childEnv.ALCHEMY_STAGE
	delete childEnv.ALCHEMY_PROFILE

	const alchemyBin = join(REPO_ROOT, "node_modules", ".bin", "alchemy")
	let child: ChildProcess
	try {
		child = spawn(
			alchemyBin,
			[
				"dev",
				"--stage",
				stage,
				"--no-input",
				"--env-file",
				envFile,
				...(fixture === undefined ? [] : ["--config", fixture.config]),
			],
			{
				cwd: REPO_ROOT,
				env: childEnv,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			},
		)
	} catch (error) {
		rmSync(envDir, { recursive: true, force: true })
		throw error
	}

	const logs: Array<string> = []
	let readyUrl: string | null = null
	let apiUrl: string | null = null
	let harnessUrl: string | null = null
	let startupError: Error | null = null
	let harnessReady = fixture !== undefined
	let resolveReady!: (url: string) => void
	let rejectReady!: (err: Error) => void
	const ready = new Promise<string>((res, rej) => {
		resolveReady = res
		rejectReady = rej
	})

	const inspectLine = (line: string) => {
		const clean = stripAnsi(line)
		if (clean.includes("ERROR:") && clean.includes("[PiHarnessWorker]")) {
			startupError = new Error(`PiHarnessWorker failed during startup: ${clean}`)
			rejectReady(startupError)
			return
		}
		if (readyUrl !== null) {
			return
		}
		const readyMessage = `[${fixture?.worker ?? "ApiWorker"}] ready at `
		const url = clean.split(readyMessage)[1]?.match(/^http:\/\/[^\s]+/)?.[0]
		if (url !== undefined) {
			apiUrl = url.replace(/\/+$/, "")
		}
		const harness = clean.split("[PiHarnessWorker] ready at ")[1]?.match(/^http:\/\/[^\s]+/)?.[0]
		if (harness !== undefined) {
			harnessUrl = harness
			harnessReady = true
		}
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

	const halt = async () => {
		clearTimeout(startupTimer)
		await stopProcessByPid(child)
		rmSync(envDir, { recursive: true, force: true })
	}
	const stop = async () => {
		await halt()
		removeStage(join(REPO_ROOT, ".alchemy"), fixture?.stack ?? "Checkfu", stage)
	}

	try {
		const baseUrl = await ready
		clearTimeout(startupTimer)
		const healthDeadline = Date.now() + 10_000
		while (Date.now() < healthDeadline) {
			if (startupError !== null) {
				throw new Error("PiHarnessWorker failed during startup", { cause: startupError })
			}
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
					if (fixture === undefined) {
						const auth = await fetch(`${baseUrl}/v1/agents`, {
							headers: AUTH_HEADERS,
							signal: AbortSignal.timeout(2000),
						})
						void auth.body?.cancel().catch(() => undefined)
						if (auth.status !== 200 || harnessUrl === null) {
							continue
						}
						// The production harness returns 404 without a sandbox egress
						// context. This reaches its fetch handler, unlike a ready log.
						const harness = await fetch(harnessUrl, { signal: AbortSignal.timeout(2000) })
						void harness.body?.cancel().catch(() => undefined)
						if (harness.status !== 404) {
							continue
						}
					}
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

export const limitedTo = (allowed_hosts: ReadonlyArray<string>) => ({
	type: "cloud",
	networking: {
		type: "limited",
		allow_mcp_servers: false,
		allow_package_managers: false,
		allowed_hosts,
	},
})

export const runsScript =
	(code: string) => (req: { readonly toolOutputs: ReadonlyArray<unknown> }) =>
		req.toolOutputs.length === 0
			? ({ kind: "tool_call", name: "codemode", arguments: { code } } as const)
			: ({ kind: "reply", text: "Done." } as const)

export const userMessage = (text: string) => ({
	type: "user.message",
	content: [{ type: "text", text }],
})

export const apiAt = (baseUrl: () => string) => {
	const apiFetch = async (path: string, init?: ApiRequestOptions): Promise<Response> => {
		const headers = {
			...AUTH_HEADERS,
			...(init?.body === undefined ? {} : { "content-type": "application/json" }),
			...init?.headers,
		}
		return fetch(`${baseUrl()}${path}`, {
			method: init?.method ?? "GET",
			headers,
			...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		})
	}

	const apiJson = async <T>(
		path: string,
		init?: ApiRequestOptions,
	): Promise<{ readonly status: number; readonly body: T }> => {
		const res = await apiFetch(path, init)
		const body = (await res.json()) as T
		return { status: res.status, body }
	}

	return { apiFetch, apiJson }
}
