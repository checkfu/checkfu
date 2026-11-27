import { execFile, execFileSync } from "node:child_process"
import { once } from "node:events"
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { afterAll, beforeAll, expect, it } from "vitest"
import { makeTestServer, TEST_API_KEY } from "../../apps/mcp/test/helpers/McpHarness.ts"
import {
	BUILD_CREDENTIAL_SENTINEL,
	buildCliPackage,
	buildSdkPackage,
	candidateRecordInput,
	packBuiltPackages,
	integrityOf,
	qualifiedPackages,
	repoRoot,
} from "./Build.ts"

const decodeResourceId = Schema.decodeSync(
	Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
)
const decodeCoverage = Schema.decodeSync(
	Schema.fromJsonString(Schema.Struct({ commands: Schema.Array(Schema.String) })),
)
const execute = promisify(execFile)
const consumerNode = process.env["CHECKFU_TEST_NODE"] ?? process.execPath
let scratch: string
let consumer: string
let cli: string
let cliVersion: string
let sdkVersion: string
let recordPath: string
let recordIntegrity: string
const env = (extra: Readonly<Record<string, string>> = {}) => ({
	...Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				!key.startsWith("CHECKFU_") && !["NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS"].includes(key),
		),
	),
	PATH: [dirname(consumerNode), "/usr/bin", "/bin"].join(process.platform === "win32" ? ";" : ":"),
	...extra,
})

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "checkfu-npm-contract-"))
	consumer = join(scratch, "consumer")
	await mkdir(consumer)
	await writeFile(
		join(consumer, "package.json"),
		'{"name":"checkfu-package-user","private":true,"type":"module"}',
	)
	const candidate = candidateRecordInput()
	if (candidate === undefined) {
		const previous = process.env["CHECKFU_API_KEY"]
		try {
			process.env["CHECKFU_API_KEY"] = BUILD_CREDENTIAL_SENTINEL
			const buildDirectory = join(scratch, "packages")
			const cli = await buildCliPackage(buildDirectory)
			const sdk = await buildSdkPackage(buildDirectory)
			const packed = await packBuiltPackages([cli, sdk], scratch)
			recordPath = packed.recordPath
			recordIntegrity = packed.integrity
		} finally {
			if (previous === undefined) {
				delete process.env["CHECKFU_API_KEY"]
			} else {
				process.env["CHECKFU_API_KEY"] = previous
			}
		}
	} else {
		recordPath = resolve(candidate.recordPath)
		recordIntegrity = candidate.integrity
	}
	const accepted = join(scratch, "accepted")
	await mkdir(accepted)
	const packages = await qualifiedPackages(recordPath, recordIntegrity)
	cliVersion = packages[0].metadata.version
	sdkVersion = packages[1].metadata.version
	const artifacts = await Promise.all(
		packages.map(async ({ bytes, metadata }) => {
			const destination = join(accepted, metadata.filename)
			await writeFile(destination, bytes, { flag: "wx" })
			return destination
		}),
	)
	execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...artifacts], {
		cwd: consumer,
		stdio: "pipe",
		timeout: 60_000,
	})
	cli = join(consumer, "node_modules", "checkfu", "bin", "checkfu.mjs")
	await copyFile(
		fileURLToPath(new URL("fixtures/Types.ts", import.meta.url)),
		join(consumer, "Types.ts"),
	)
	await copyFile(
		fileURLToPath(new URL("fixtures/Consumer.mjs", import.meta.url)),
		join(consumer, "Consumer.mjs"),
	)
	await copyFile(
		fileURLToPath(new URL("fixtures/Cli.mjs", import.meta.url)),
		join(consumer, "Cli.mjs"),
	)
	await writeFile(
		join(consumer, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				noEmit: true,
				module: "NodeNext",
				moduleResolution: "NodeNext",
				target: "ES2022",
				lib: ["ES2024", "DOM"],
				types: [],
				skipLibCheck: false,
			},
			include: ["Types.ts"],
		}),
	)
}, 120_000)

afterAll(async () => {
	if (scratch !== undefined) {
		await rm(scratch, { recursive: true, force: true })
	}
})

it(
	"installs independently of the checkout and exposes working JavaScript and TypeScript entry points",
	{ timeout: 45_000, tags: ["acceptance", "installed-entrypoints"] },
	async () => {
		expect(await readFile(cli, "utf8")).not.toContain(BUILD_CREDENTIAL_SENTINEL)
		expect((await lstat(join(consumer, "node_modules", "@checkfu", "sdk"))).isSymbolicLink()).toBe(
			false,
		)
		const sdk = Schema.decodeSync(
			Schema.fromJsonString(
				Schema.Struct({
					version: Schema.String,
					dependencies: Schema.Record(Schema.String, Schema.String),
				}),
			),
		)(await readFile(join(consumer, "node_modules", "@checkfu", "sdk", "package.json"), "utf8"))
		expect(sdk.version).toBe(sdkVersion)
		expect(
			Object.values(sdk.dependencies).some((value) => /^(workspace|catalog|file):/.test(value)),
		).toBe(false)
		execFileSync("bun", ["x", "effect-tsgo", "tsc", "-p", join(consumer, "tsconfig.json")], {
			cwd: repoRoot,
			stdio: "inherit",
			timeout: 30_000,
		})
		const { stdout } = await execute(join(consumer, "node_modules/.bin/checkfu"), ["--version"], {
			cwd: consumer,
			env: env(),
			timeout: 10_000,
		})
		expect(stdout.trim()).toBe(`checkfu v${cliVersion}`)
	},
)

it(
	"refuses candidates whose bytes, names, or versions disagree with the record",
	{ timeout: 30_000, tags: ["acceptance", "package-integrity"] },
	async () => {
		const { commit } = Schema.decodeSync(
			Schema.fromJsonString(Schema.Struct({ commit: Schema.String })),
		)(await readFile(recordPath, "utf8"))
		const [cli, sdk] = await qualifiedPackages(recordPath, recordIntegrity)
		const altered = join(scratch, "altered")
		await mkdir(altered)
		const alteredRecord = join(altered, "candidates.json")
		const writeRecord = (packages = [cli.metadata, sdk.metadata]) =>
			writeFile(alteredRecord, JSON.stringify({ commit, packages }))
		await writeRecord()
		const pinned = integrityOf(await readFile(alteredRecord))
		await expect(qualifiedPackages(alteredRecord, pinned)).rejects.toMatchObject({ code: "ENOENT" })
		await writeFile(join(altered, cli.metadata.filename), cli.bytes)
		await writeFile(join(altered, sdk.metadata.filename), sdk.bytes)
		await expect(qualifiedPackages(alteredRecord, pinned)).resolves.toHaveLength(2)
		const replacement = Uint8Array.from(cli.bytes)
		replacement[4] = (replacement[4] ?? 0) ^ 1
		await writeFile(join(altered, cli.metadata.filename), replacement)
		await writeRecord([{ ...cli.metadata, integrity: integrityOf(replacement) }, sdk.metadata])
		await expect(qualifiedPackages(alteredRecord)).resolves.toHaveLength(2)
		await expect(qualifiedPackages(alteredRecord, pinned)).rejects.toThrow(
			"The candidate record changed during qualification.",
		)
		await writeRecord()
		await writeFile(join(altered, cli.metadata.filename), sdk.bytes)
		await expect(qualifiedPackages(alteredRecord)).rejects.toThrow("Integrity mismatch")
		const modified = Uint8Array.from(cli.bytes)
		modified[0] = 0
		await writeFile(join(altered, cli.metadata.filename), modified)
		await expect(qualifiedPackages(alteredRecord)).rejects.toThrow("Integrity mismatch")
		const changed = { ...cli.metadata, filename: "checkfu-0.0.999.tgz", version: "0.0.999" }
		await writeFile(join(altered, changed.filename), cli.bytes)
		await writeRecord([changed, sdk.metadata])
		await expect(qualifiedPackages(alteredRecord)).rejects.toThrow("Package identity mismatch")
		await writeRecord([sdk.metadata, cli.metadata])
		await expect(qualifiedPackages(alteredRecord)).rejects.toThrow("unambiguous checkfu tarball")
		const originals = await qualifiedPackages(recordPath, recordIntegrity)
		expect(originals.map(({ metadata }) => metadata)).toEqual([cli.metadata, sdk.metadata])
	},
)

it(
	"drives installed CLI login and CRUD, and installed Promise/Effect SDK retry, history, errors and event streams against the domain backend",
	{ timeout: 120_000, tags: ["acceptance", "installed-journeys"] },
	async ({ task }) => {
		Object.assign(task.meta, {
			candidateRecord: JSON.parse(await readFile(recordPath, "utf8")),
			candidateIntegrity: recordIntegrity,
		})
		await Effect.runPromise(
			Effect.gen(function* () {
				const api = yield* makeTestServer
				const listener = createServer((request, response) => {
					const abort = new AbortController()
					response.on("close", () => abort.abort())
					const dispatch = async () => {
						const chunks: Array<Buffer> = []
						for await (const chunk of request) {
							chunks.push(Buffer.from(chunk))
						}
						const headers = new Headers()
						for (const [key, value] of Object.entries(request.headers)) {
							if (value !== undefined) {
								headers.set(key, Array.isArray(value) ? value.join(", ") : value)
							}
						}
						const result = await api.apiFetch(
							new Request(`http://127.0.0.1${request.url}`, {
								method: request.method ?? "GET",
								headers,
								signal: abort.signal,
								...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
							}),
						)
						response.writeHead(result.status, Object.fromEntries(result.headers))
						const reader = result.body?.getReader()
						if (reader !== undefined) {
							for (;;) {
								const next = await reader.read()
								if (next.done) {
									break
								}
								response.write(next.value)
							}
						}
						response.end()
					}
					void dispatch().catch((error: unknown) =>
						response.destroy(error instanceof Error ? error : new Error(String(error))),
					)
				})
				yield* Effect.promise(async () => {
					listener.listen(0, "127.0.0.1")
					await once(listener, "listening")
				})
				yield* Effect.addFinalizer(() =>
					Effect.promise(async () => {
						listener.closeAllConnections()
						await new Promise<void>((resolve, reject) => {
							listener.close((error) => {
								if (error) {
									reject(error)
								} else {
									resolve()
								}
							})
						})
					}),
				)
				const address = listener.address()
				if (address === null || typeof address === "string") {
					throw new Error("No HTTP listener")
				}
				const url = `http://127.0.0.1:${address.port}`
				yield* Effect.promise(async () => {
					const config = join(scratch, "config")
					const hostile = join(scratch, "hostile")
					await mkdir(hostile)
					await writeFile(
						join(hostile, ".env"),
						"CHECKFU_API_KEY=planted\nCHECKFU_BASE_URL=https://planted.invalid\n",
					)
					await writeFile(join(hostile, "bunfig.toml"), 'preload = ["./preload.js"]')
					await writeFile(
						join(hostile, "preload.js"),
						'require("node:fs").writeFileSync("PRELOAD_RAN", "yes")',
					)
					const run = (args: ReadonlyArray<string>, extra = {}, stdin = "") => {
						const child = execute(consumerNode, ["--no-experimental-strip-types", cli, ...args], {
							cwd: hostile,
							env: env({ CHECKFU_CONFIG_DIR: config, ...extra }),
							timeout: 20_000,
						})
						child.child.stdin?.end(stdin)
						return child
					}
					await expect(run(["agents", "list"])).rejects.toMatchObject({
						code: 1,
						stderr: expect.stringContaining("Missing CHECKFU_API_KEY"),
					})
					await expect(
						run(["--base-url", url, "login"], { CHECKFU_API_KEY: "invalid" }),
					).rejects.toMatchObject({ code: 1 })
					await expect(readFile(join(config, "config.json"))).rejects.toMatchObject({
						code: "ENOENT",
					})
					const logged = await run(["--base-url", url, "login"], { CHECKFU_API_KEY: TEST_API_KEY })
					expect(logged.stderr).toContain("Connected to")
					expect(logged.stderr).not.toContain(TEST_API_KEY)
					if (process.platform !== "win32") {
						expect((await stat(join(config, "config.json"))).mode & 0o777).toBe(0o600)
					}
					const created = await run([
						"--format",
						"json",
						"agents",
						"create",
						"--name",
						"Installed CLI",
						"--model",
						"gpt-4o-mini",
					])
					const agent = decodeResourceId(created.stdout)
					const read = await run(["--format", "json", "agents", "retrieve", "--agent-id", agent.id])
					expect(JSON.parse(read.stdout)).toMatchObject({
						id: agent.id,
						name: "Installed CLI",
						version: 1,
					})
					const environment = decodeResourceId(
						(await run(["--format", "json", "environments", "create", "--name", "CLI pipes"]))
							.stdout,
					)
					const session = decodeResourceId(
						(
							await run([
								"--format",
								"json",
								"sessions",
								"create",
								"--agent",
								agent.id,
								"--environment-id",
								environment.id,
							])
						).stdout,
					)
					const connected = await run(
						["sessions", "connect", session.id],
						{},
						"First piped message\nLast message without newline",
					)
					expect(connected.stdout).toContain("Echo: First piped message")
					expect(connected.stdout.trim().endsWith("Last message without newline")).toBe(true)
					await run(["sessions", "archive", "--session-id", session.id])
					const sdk = await execute(
						consumerNode,
						[
							"--no-experimental-strip-types",
							join(consumer, "Consumer.mjs"),
							url,
							TEST_API_KEY,
							agent.id,
							session.id,
						],
						{ cwd: consumer, env: env(), timeout: 30_000 },
					)
					expect(JSON.parse(sdk.stdout)).toMatchObject({ versions: [2, 1] })
					const journey = await execute(
						consumerNode,
						[
							"--no-experimental-strip-types",
							join(consumer, "Cli.mjs"),
							cli,
							url,
							TEST_API_KEY,
							hostile,
						],
						{
							cwd: hostile,
							env: env({ CHECKFU_CONFIG_DIR: config }),
							timeout: 90_000,
							maxBuffer: 4 * 1024 * 1024,
						},
					)
					const coverage = decodeCoverage(journey.stdout)
					const generated = [
						...(
							await readFile(join(repoRoot, "apps/cli/src/generated/Commands.ts"), "utf8")
						).matchAll(/cliLabel: "([^"]+)"/g),
					].map((match) => match[1])
					expect(generated.filter((command) => !coverage.commands.includes(command ?? ""))).toEqual(
						[],
					)
					await expect(readFile(join(hostile, "PRELOAD_RAN"))).rejects.toMatchObject({
						code: "ENOENT",
					})
					await run(["logout"])
					await expect(run(["agents", "list"])).rejects.toMatchObject({ code: 1 })
				})
			}).pipe(Effect.scoped),
		)
	},
)
