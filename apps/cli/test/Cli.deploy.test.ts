import { parseCustomProvidersManifest } from "@checkfu/pi-providers/catalog"
import { describe, expect, it } from "@effect/vitest"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { providerForKey, readDotEnvValue, setDotEnvValue } from "../src/Commands/Deploy.ts"
import { COMMAND, invocation } from "../src/Invocation.ts"
import { TEST_API_KEY, makeTestServer } from "./helpers/CliHarness.ts"

const DEPLOYED_URL = "https://checkfu.example.workers.dev"
const CONFIG_FILE = "/config/config.json"
const ENV_FILE = "/checkout/.env"
const STAGE_FILE = "/checkout/.checkfu/stage"
const recordFile = (stage: string) => `/checkout/.checkfu/deployments/stage-${stage}.json`
const ACCOUNT = "0123456789abcdef0123456789abcdef"
const OTHER_ACCOUNT = "fedcba9876543210fedcba9876543210"
const record = (
	stage: string,
	profile = "default",
	account = ACCOUNT,
	url: string | null = DEPLOYED_URL,
) =>
	`${JSON.stringify({ stage, profile, account_id: account, ...(url === null ? {} : { url }) }, null, "\t")}\n`

interface VirtualFiles {
	[path: string]: string
}

const virtualFiles = (initial: VirtualFiles = {}): VirtualFiles => ({ ...initial })

const deployEnv = {
	CHECKFU_CONFIG_DIR: "/config",
	CHECKFU_API_KEY: TEST_API_KEY,
	OPENAI_API_KEY: "sk-proj-x",
}

const SHARED = ["--env-file", ENV_FILE, "--profile", "default"]
const ASK_ACCOUNT = ["query", "account", "default", ENV_FILE]
const askOutput = (stage: string, profile = "default") => [
	"query",
	"output",
	profile,
	ENV_FILE,
	`Checkfu/${stage}/output`,
]

const ALCHEMY_NOISE =
	"[12:22:22.304] INFO: Cloudflare: using environment variables (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN).\n"

const fakeAlchemy = (
	calls: Array<ReadonlyArray<string>>,
	options: {
		readonly account?: string | null
		readonly accountAfterSignIn?: string
		readonly accountError?: string
		readonly output?: "missing" | "error" | "silent"
		readonly url?: string
		readonly mcp?: string
		readonly app?: string
		readonly deployExitCode?: number
	} = {},
) => {
	let account = options.account === undefined ? ACCOUNT : options.account
	const answer = (value: unknown) => ({
		exitCode: 0,
		stdout: `${ALCHEMY_NOISE}\n@checkfu ${JSON.stringify(value)}\n`,
	})
	return (args: ReadonlyArray<string>) => {
		const command = args.slice(1)
		calls.push(command)
		if (command[0] === "query" && command[1] === "account") {
			if (options.accountError !== undefined) {
				return answer({ status: "error", message: options.accountError })
			}
			return answer(
				account === null
					? {
							status: "not-configured",
							message: "Provider 'Cloudflare' is not configured in profile 'default'.",
						}
					: { status: "connected", account_id: account },
			)
		}
		if (command[0] === "query" && command[1] === "image") {
			return answer({
				status: "found",
				image: `registry.cloudflare.com/${ACCOUNT}/checkfu-sandbox@sha256:${"a".repeat(64)}`,
			})
		}
		if (command[0] === "query") {
			switch (options.output) {
				case "missing":
					return answer({ status: "missing" })
				case "error":
					return answer({ status: "error", message: "StateStoreError: store is out of date" })
				case "silent":
					return { exitCode: 0, stdout: ALCHEMY_NOISE }
				default:
					return answer({
						status: "found",
						value: {
							api: options.url ?? DEPLOYED_URL,
							...(options.mcp === undefined ? {} : { mcp: options.mcp }),
							...(options.app === undefined ? {} : { app: options.app }),
						},
					})
			}
		}
		if (command[0] === "profile") {
			account = options.accountAfterSignIn ?? account
			return { exitCode: 0 }
		}
		return { exitCode: options.deployExitCode ?? 0 }
	}
}

const errorEnvelope = (status: number, type: string) =>
	Response.json({ type: "error", error: { type, message: "simulated" } }, { status })

describe("dotenv helpers", () => {
	it.live("reads values and treats missing or empty entries as unset", () =>
		Effect.gen(function* () {
			const contents = 'A=one\nexport B="two words"\nC=\n'
			expect(yield* readDotEnvValue(contents, "A")).toBe("one")
			expect(yield* readDotEnvValue(contents, "B")).toBe("two words")
			expect(yield* readDotEnvValue(contents, "C")).toBe("")
			expect(yield* readDotEnvValue(contents, "D")).toBe("")
		}),
	)

	it.effect("replaces an existing entry in place and appends a new one", () =>
		Effect.gen(function* () {
			expect(yield* setDotEnvValue("# keep\nA=\nB=2\n", "A", "1")).toBe("# keep\nA=1\nB=2\n")
			expect(yield* setDotEnvValue("B=2", "A", "1")).toBe("B=2\nA=1\n")
			expect(yield* setDotEnvValue("", "A", "1")).toBe("A=1\n")
		}),
	)

	it.effect("stores values that need quoting so they read back unchanged", () =>
		Effect.gen(function* () {
			for (const value of ["abc#def", "$&-$1-$$", "two words", "it's", 'say "hi"', "a`b"]) {
				const contents = yield* setDotEnvValue("A=old\nB=2\n", "A", value)
				expect(yield* readDotEnvValue(contents, "A")).toBe(value)
				expect(yield* readDotEnvValue(contents, "B")).toBe("2")
			}
			const refused = yield* Effect.flip(setDotEnvValue("", "A", "line\nbreak"))
			expect(refused.message).toContain("cannot be stored in .env")
		}),
	)

	it("infers the provider from the key prefix", () => {
		expect(providerForKey("sk-ant-api03-x").env).toBe("ANTHROPIC_API_KEY")
		expect(providerForKey("sk-or-v1-x").env).toBe("OPENROUTER_API_KEY")
		expect(providerForKey("sk-proj-x").env).toBe("OPENAI_API_KEY")
	})
})

describe("what the CLI calls itself in messages", () => {
	it("is the checkout script only when standing in the checkout it runs from", () => {
		expect(invocation("/opt/checkfu", "/opt/checkfu")).toBe("bun checkfu")
		for (const workingDirectory of ["/work/other-checkout", "/opt/checkfu/apps/cli", undefined]) {
			expect(invocation("/opt/checkfu", workingDirectory)).toBe("checkfu")
		}
		expect(invocation(undefined, undefined)).toBe("checkfu")
	})
})

describe("checkfu deploy", () => {
	const checkout = { "/checkout/alchemy.run.ts": "" }

	it.live(
		"updates an exported provider key in managed deployment settings while retaining the API key",
		() =>
			Effect.gen(function* () {
				const cli = yield* makeTestServer()
				const files = virtualFiles({
					...checkout,
					[ENV_FILE]: `CHECKFU_API_KEY=${TEST_API_KEY}\nOPENAI_API_KEY=revoked-key\n`,
				})
				const result = yield* cli.run(["deploy", "--yes"], {
					checkout: { managed: true },
					env: deployEnv,
					files,
					spawn: fakeAlchemy([]),
				})
				expect(result.exitCode).toBe(0)
				expect(files[ENV_FILE]).toBe(`CHECKFU_API_KEY=${TEST_API_KEY}\nOPENAI_API_KEY=sk-proj-x\n`)
				expect(result.stderr).not.toContain("revoked-key")
				expect(result.stderr).not.toContain("sk-proj-x")
			}),
	)

	it.live("prepares secrets, deploys, records the deployment, and saves the connection", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const calls: Array<ReadonlyArray<string>> = []
			const files = virtualFiles({
				...checkout,
				[ENV_FILE]: `CHECKFU_API_KEY=${TEST_API_KEY}\nOPENAI_API_KEY=\nANTHROPIC_API_KEY=\n`,
			})

			const result = yield* cli.run(["deploy"], {
				env: { CHECKFU_CONFIG_DIR: "/config", ANTHROPIC_API_KEY: "sk-ant-from-env" },
				files,
				spawn: fakeAlchemy(calls),
			})

			expect(result.errorMessage).toBeUndefined()
			expect(calls).toEqual([
				ASK_ACCOUNT,
				["deploy", "--stage", "live", ...SHARED],
				askOutput("live"),
			])
			expect(files[ENV_FILE]).toBe(
				`CHECKFU_API_KEY=${TEST_API_KEY}\nOPENAI_API_KEY=\nANTHROPIC_API_KEY=sk-ant-from-env\n`,
			)
			expect(files[recordFile("live")]).toBe(record("live"))
			expect(JSON.parse(files[CONFIG_FILE] ?? "")).toEqual({
				url: DEPLOYED_URL,
				api_key: TEST_API_KEY,
			})
			expect(result.stderr).toContain(`Checkfu is live at ${DEPLOYED_URL}`)
			expect(result.stderr).toContain(
				`${COMMAND} agents create --name Assistant --model claude-sonnet-5-5`,
			)
			expect(result.stderr).toContain(`${COMMAND} sessions connect <session-id>`)
			expect(result.stderr).not.toContain("--base-url")
			expect(result.stderr).not.toContain(TEST_API_KEY)
			expect(result.stderr).not.toContain("MCP")
			expect(result.stderr).not.toContain("Dashboard")

			const withMcp = yield* cli.run(["deploy"], {
				env: { CHECKFU_CONFIG_DIR: "/config", ANTHROPIC_API_KEY: "sk-ant-from-env" },
				files,
				spawn: fakeAlchemy([], {
					mcp: "https://checkfu-mcp.example.workers.dev/",
					app: "https://checkfu-app.example.workers.dev/",
				}),
			})
			expect(withMcp.errorMessage).toBeUndefined()
			expect(withMcp.stderr).toContain("  MCP        https://checkfu-mcp.example.workers.dev/mcp\n")
			expect(withMcp.stderr).toContain("  Dashboard  https://checkfu-app.example.workers.dev\n")
		}),
	)

	it.live("generates an API key at a terminal and keeps an exported one otherwise", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const generated = virtualFiles(checkout)
			const rejected = yield* cli.run(["deploy", "--yes"], {
				env: { CHECKFU_CONFIG_DIR: "/config", OPENAI_API_KEY: "sk-proj-from-env" },
				files: generated,
				stdinIsTerminal: true,
				spawn: fakeAlchemy([]),
			})
			expect(generated[ENV_FILE]).toMatch(
				/^CHECKFU_API_KEY=ck_[0-9a-f]{64}\nOPENAI_API_KEY=sk-proj-from-env\n$/,
			)
			expect(rejected.errorMessage).toContain("rejected the API key")
			expect(generated[CONFIG_FILE]).toBeUndefined()

			const exported = virtualFiles(checkout)
			const kept = yield* cli.run(["deploy", "--yes"], {
				env: deployEnv,
				files: exported,
				spawn: fakeAlchemy([]),
			})
			expect(kept.errorMessage).toBeUndefined()
			expect(exported[ENV_FILE]).toBe(`CHECKFU_API_KEY=${TEST_API_KEY}\nOPENAI_API_KEY=sk-proj-x\n`)

			const calls: Array<ReadonlyArray<string>> = []
			const noTerminal = virtualFiles(checkout)
			const refused = yield* cli.run(["deploy", "--yes"], {
				env: { CHECKFU_CONFIG_DIR: "/config", OPENAI_API_KEY: "sk-proj-from-env" },
				files: noTerminal,
				spawn: fakeAlchemy(calls),
			})
			expect(refused.errorMessage).toContain("export a persistent CHECKFU_API_KEY")
			expect(calls.map((call) => call[0])).toEqual(["query"])
			expect(noTerminal[ENV_FILE]).toBeUndefined()
		}),
	)

	it.live("stops before deploying on secrets it cannot use as written", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const cases = [
				{
					files: { ...checkout, [ENV_FILE]: Stream.empty },
					env: deployEnv,
					message: `Could not read ${ENV_FILE}`,
				},
				{
					files: {
						...checkout,
						[ENV_FILE]: `CHECKFU_API_KEY="${TEST_API_KEY} "\nOPENAI_API_KEY=sk-proj-x\n`,
					},
					env: { CHECKFU_CONFIG_DIR: "/config" },
					message: "CHECKFU_API_KEY in .env has leading or trailing whitespace",
				},
				{
					files: {
						...checkout,
						[ENV_FILE]: `CHECKFU_API_KEY=${TEST_API_KEY}\nOPENAI_API_KEY=sk-proj-x\n`,
					},
					env: { CHECKFU_CONFIG_DIR: "/config", CHECKFU_API_KEY: "shell-key" },
					message: "differs from the one in .env",
				},
				{
					files: checkout,
					env: { CHECKFU_CONFIG_DIR: "/config", CHECKFU_API_KEY: TEST_API_KEY },
					message:
						"ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, or CLOUDFLARE_GATEWAY_ID",
				},
				{
					files: {
						...checkout,
						[ENV_FILE]: 'CHECKFU_API_KEY="two\\nlines"\nOPENAI_API_KEY=sk-proj-x\n',
					},
					env: { CHECKFU_CONFIG_DIR: "/config" },
					message: "cannot be sent in an HTTP header",
				},
			]
			for (const { files, env, message } of cases) {
				const calls: Array<ReadonlyArray<string>> = []
				const result = yield* cli.run(["deploy", "--yes"], {
					env,
					files: { ...files },
					spawn: fakeAlchemy(calls),
				})
				expect(result.exitCode).toBe(1)
				expect(result.errorMessage).toContain(message)
				expect(result.errorMessage).not.toContain("shell-key")
				expect(calls.filter((call) => call[0] !== "query")).toEqual([])
			}
		}),
	)

	it.live("deploys the exact exported key even when it needs quoting", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles(checkout)
			yield* cli.run(["deploy", "--yes"], {
				env: { ...deployEnv, CHECKFU_API_KEY: "key#with$&" },
				files,
				spawn: fakeAlchemy([]),
			})
			expect(yield* readDotEnvValue(files[ENV_FILE] ?? "", "CHECKFU_API_KEY")).toBe("key#with$&")
		}),
	)

	it.live(
		"reports Alchemy's answer when Cloudflare is not connected and there is no terminal",
		() =>
			Effect.gen(function* () {
				const cli = yield* makeTestServer()
				const calls: Array<ReadonlyArray<string>> = []
				const result = yield* cli.run(["deploy", "--yes"], {
					env: deployEnv,
					files: checkout,
					spawn: fakeAlchemy(calls, { account: null }),
				})
				expect(result.exitCode).toBe(1)
				expect(result.errorMessage).toContain("is not configured in profile 'default'")
				expect(calls.map((call) => call[0])).toEqual(["query"])
			}),
	)

	it.live("signs in at a terminal, then deploys with the profile the checkout selects", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const work = ["--env-file", ENV_FILE, "--profile", "work"]
			const askWork = ["query", "account", "work", ENV_FILE]
			const calls: Array<ReadonlyArray<string>> = []
			const files = virtualFiles({
				...checkout,
				[ENV_FILE]: `CHECKFU_API_KEY=${TEST_API_KEY}\nOPENAI_API_KEY=sk-x\nALCHEMY_PROFILE=work\n`,
			})
			const result = yield* cli.run(["deploy"], {
				env: { CHECKFU_CONFIG_DIR: "/config", ALCHEMY_PROFILE: "shell" },
				stdinIsTerminal: true,
				files,
				spawn: fakeAlchemy(calls, { account: null, accountAfterSignIn: ACCOUNT }),
			})
			expect(result.errorMessage).toBeUndefined()
			expect(calls).toEqual([
				askWork,
				["profile", "edit", "--add", "Cloudflare", ...work],
				askWork,
				["deploy", "--stage", "live", ...work],
				askOutput("live", "work"),
			])
			expect(files[recordFile("live")]).toBe(record("live", "work"))

			const cancelled: Array<ReadonlyArray<string>> = []
			const stopped = yield* cli.run(["deploy"], {
				env: deployEnv,
				stdinIsTerminal: true,
				files: checkout,
				spawn: fakeAlchemy(cancelled, { account: null }),
			})
			expect(stopped.errorMessage).toContain("sign-in did not finish")
			expect(cancelled.map((call) => call[0])).toEqual(["query", "profile", "query"])
		}),
	)

	it.live("does not deploy when the account in use cannot be determined", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const calls: Array<ReadonlyArray<string>> = []
			const result = yield* cli.run(["deploy", "--yes"], {
				env: deployEnv,
				files: checkout,
				spawn: fakeAlchemy(calls, { accountError: "AuthError: Cloudflare OAuth refresh failed" }),
			})
			expect(result.exitCode).toBe(1)
			expect(result.errorMessage).toContain("Cloudflare OAuth refresh failed")
			expect(result.errorMessage).toContain("Nothing was changed")
			expect(calls.map((call) => call[0])).toEqual(["query"])
		}),
	)

	it.live("deploys with the profile it checked, without consulting the env file again", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const calls: Array<ReadonlyArray<string>> = []
			const files = virtualFiles(checkout)
			yield* cli.run(["deploy", "--yes"], {
				env: { ...deployEnv, ALCHEMY_PROFILE: "work" },
				files,
				spawn: fakeAlchemy(calls),
			})
			expect(calls.slice(0, 2)).toEqual([
				["query", "account", "work", ""],
				["deploy", "--stage", "live", "--yes", "--env-file", ENV_FILE, "--profile", "work"],
			])
		}),
	)

	it.live("refuses a stage name Alchemy would not accept before doing anything", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			for (const args of [
				["deploy", "--yes", "--stage", "two words"],
				["deploy", "--yes", "--stage", "$(reboot)"],
				["destroy", "--yes", "--stage", "../live"],
			]) {
				const calls: Array<ReadonlyArray<string>> = []
				const files = virtualFiles(checkout)
				const result = yield* cli.run(args, { env: deployEnv, files, spawn: fakeAlchemy(calls) })
				expect(result.exitCode).toBe(1)
				expect(calls).toEqual([])
				expect(files[ENV_FILE]).toBeUndefined()
			}
		}),
	)

	it.live("records an attempted deployment so partial failures can be retried or destroyed", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles(checkout)
			const declined = { env: deployEnv, files, spawn: fakeAlchemy([], { deployExitCode: 3 }) }

			const first = yield* cli.run(["deploy", "--stage", "staging"], declined)
			expect(first.exitCode).toBe(3)
			expect(files[recordFile("staging")]).toBe(record("staging", "default", ACCOUNT, null))
			expect(files[CONFIG_FILE]).toBeUndefined()

			yield* cli.run(["deploy", "--yes"], { env: deployEnv, files, spawn: fakeAlchemy([]) })
			expect(files[recordFile("staging")]).toBe(record("staging"))

			yield* cli.run(["deploy", "--stage", "staging"], declined)
			expect(files[recordFile("staging")]).toBe(record("staging"))

			const next: Array<ReadonlyArray<string>> = []
			yield* cli.run(["deploy", "--yes"], { env: deployEnv, files, spawn: fakeAlchemy(next) })
			expect(next[1]).toEqual(["deploy", "--stage", "staging", "--yes", ...SHARED])

			const cleanup = yield* cli.run(["destroy", "--stage", "staging", "--yes"], {
				env: deployEnv,
				files,
				spawn: fakeAlchemy([]),
			})
			expect(cleanup.exitCode).toBe(0)
			expect(files[recordFile("staging")]).toBeUndefined()
		}),
	)

	it.live("refuses to deploy a recorded stage into a different account, named or not", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const saved = JSON.stringify({ url: DEPLOYED_URL, api_key: TEST_API_KEY })
			const files = virtualFiles({
				...checkout,
				[STAGE_FILE]: "live\n",
				[recordFile("live")]: record("live"),
				[CONFIG_FILE]: saved,
			})
			const elsewhere = { account: OTHER_ACCOUNT, url: "https://checkfu.other.workers.dev" }

			for (const args of [
				["deploy", "--yes"],
				["deploy", "--yes", "--stage", "live"],
			]) {
				const calls: Array<ReadonlyArray<string>> = []
				const result = yield* cli.run(args, {
					env: deployEnv,
					files,
					spawn: fakeAlchemy(calls, elsewhere),
				})
				expect(result.exitCode).toBe(1)
				expect(result.errorMessage).toContain(`act on account ${OTHER_ACCOUNT}`)
				expect(result.errorMessage).toContain("Nothing was changed")
				expect(calls).toEqual([["query", "account", "default", ""]])
				expect(files[recordFile("live")]).toBe(record("live"))
				expect(files[CONFIG_FILE]).toBe(saved)
				expect(files[ENV_FILE]).toBeUndefined()
			}

			const other = yield* cli.run(["deploy", "--yes", "--stage", "staging"], {
				env: deployEnv,
				files,
				spawn: fakeAlchemy([], elsewhere),
			})
			expect(other.errorMessage).toBeUndefined()
			expect(files[recordFile("staging")]).toBe(
				record("staging", "default", OTHER_ACCOUNT, elsewhere.url),
			)
		}),
	)

	it.live("names the stage in the command it suggests for trying again", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const named = yield* cli.run(["deploy", "--yes", "--stage", "staging"], {
				env: deployEnv,
				files: virtualFiles(checkout),
				spawn: fakeAlchemy([], { output: "error" }),
			})
			expect(named.errorMessage).toContain(`Run \`${COMMAND} deploy --stage staging\` again`)

			const declined = yield* cli.run(["deploy", "--stage", "staging"], {
				env: deployEnv,
				files: virtualFiles(checkout),
				spawn: fakeAlchemy([], { deployExitCode: 1 }),
			})
			expect(declined.errorMessage).toContain(`Run \`${COMMAND} deploy --stage staging\` again`)

			const bare = yield* cli.run(["deploy", "--yes"], {
				env: deployEnv,
				files: virtualFiles(checkout),
				spawn: fakeAlchemy([], { output: "missing" }),
			})
			expect(bare.errorMessage).toContain(`Run \`${COMMAND} deploy\` again`)
		}),
	)

	it.live("separates a deployed stage whose URL could not be read from a finished deploy", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			for (const [output, message] of [
				["error", "its URL could not be read: StateStoreError: store is out of date"],
				["missing", "recorded no API URL"],
				["silent", "its URL could not be read: Alchemy gave no usable answer"],
			] as const) {
				const files = virtualFiles(checkout)
				const result = yield* cli.run(["deploy", "--yes"], {
					env: deployEnv,
					files,
					spawn: fakeAlchemy([], { output }),
				})
				expect(result.exitCode).toBe(1)
				expect(result.errorMessage).toContain(message)
				expect(files[recordFile("live")]).toBe(record("live", "default", ACCOUNT, null))
				expect(files[CONFIG_FILE]).toBeUndefined()
			}
		}),
	)

	it.live("keeps a redeployed stage's known URL until the new one has been read", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const saved = JSON.stringify({ url: DEPLOYED_URL, api_key: TEST_API_KEY })
			const files = virtualFiles({
				...checkout,
				[STAGE_FILE]: "live\n",
				[recordFile("live")]: record("live"),
				[CONFIG_FILE]: saved,
			})
			yield* cli.run(["deploy", "--yes"], {
				env: deployEnv,
				files,
				spawn: fakeAlchemy([], { output: "error" }),
			})
			expect(files[recordFile("live")]).toBe(record("live"))

			const destroyed = yield* cli.run(["destroy", "--yes", "--stage", "live"], {
				env: deployEnv,
				files,
				spawn: fakeAlchemy([]),
			})
			expect(destroyed.errorMessage).toBeUndefined()
			expect(files[CONFIG_FILE]).toBeUndefined()
		}),
	)

	it.live(
		"tightens a world-readable .env and warns when the shell points at another deployment",
		() =>
			Effect.gen(function* () {
				const cli = yield* makeTestServer()
				const chmods: Array<readonly [string, number]> = []
				const dotenv = `CHECKFU_API_KEY=${TEST_API_KEY}\nOPENAI_API_KEY=sk-proj-x\n`
				const files = virtualFiles({ ...checkout, [ENV_FILE]: dotenv })
				const result = yield* cli.run(["deploy", "--yes"], {
					env: { CHECKFU_CONFIG_DIR: "/config", CHECKFU_BASE_URL: "https://another.example" },
					files,
					spawn: fakeAlchemy([]),
					onChmod: (filePath, mode) => chmods.push([filePath, mode]),
				})
				expect(result.errorMessage).toBeUndefined()
				expect(files[ENV_FILE]).toBe(dotenv)
				expect(chmods).toContainEqual([ENV_FILE, 0o600])
				expect(result.stderr).toContain(`add \`--base-url ${DEPLOYED_URL}\` after \`${COMMAND}\``)
			}),
	)

	it.live("waits for the new key to be accepted when the old version is still answering", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles(checkout)
			let stale = true
			const result = yield* cli.run(["deploy", "--yes"], {
				env: deployEnv,
				files,
				readyWithin: "10 seconds",
				spawn: fakeAlchemy([]),
				interceptFetch: (next, request) => {
					if (stale && request.headers.has("authorization")) {
						stale = false
						return Promise.resolve(errorEnvelope(401, "authentication_error"))
					}
					return next(request)
				},
			})
			expect(result.errorMessage).toBeUndefined()
			expect(JSON.parse(files[CONFIG_FILE] ?? "").url).toBe(DEPLOYED_URL)
		}),
	)

	it.live("gives up on a deployment that accepts connections but never answers", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles(checkout)
			const result = yield* cli.run(["deploy", "--yes"], {
				env: deployEnv,
				files,
				spawn: fakeAlchemy([]),
				interceptFetch: () => Promise.withResolvers<Response>().promise,
			})
			expect(result.exitCode).toBe(1)
			expect(result.errorMessage).toContain("did not accept its API key within")
			expect(files[recordFile("live")]).toBe(record("live"))
			expect(files[CONFIG_FILE]).toBeUndefined()
		}),
	)

	it.live("deploys with OpenRouter or Cloudflare AI Gateway credentials", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()

			// 1. OpenRouter key exported in shell
			const orFiles = virtualFiles(checkout)
			const orResult = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					OPENROUTER_API_KEY: "sk-or-v1-test",
				},
				files: orFiles,
				spawn: fakeAlchemy([]),
			})
			expect(orResult.errorMessage).toBeUndefined()
			expect(orFiles[ENV_FILE]).toBe(
				`CHECKFU_API_KEY=${TEST_API_KEY}\nOPENROUTER_API_KEY=sk-or-v1-test\n`,
			)
			expect(orResult.stderr).toContain(
				`${COMMAND} agents create --name Assistant --model openrouter/anthropic/claude-sonnet-5.5`,
			)

			// 2. Cloudflare AI Gateway with zero-token native AI binding (CLOUDFLARE_GATEWAY_ID only)
			const gwFiles = virtualFiles(checkout)
			const gwResult = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CLOUDFLARE_GATEWAY_ID: "my-gateway",
				},
				files: gwFiles,
				spawn: fakeAlchemy([]),
			})
			expect(gwResult.errorMessage).toBeUndefined()
			expect(gwFiles[ENV_FILE]).toBe(
				`CHECKFU_API_KEY=${TEST_API_KEY}\nCLOUDFLARE_GATEWAY_ID=my-gateway\n`,
			)
			expect(gwResult.stderr).toContain(
				`${COMMAND} agents create --name Assistant --model cloudflare-ai-gateway/claude-sonnet-5-5`,
			)

			// 3. Deployment credentials (CLOUDFLARE_API_KEY) are never copied into .env as inference tokens
			const globalKeyFiles = virtualFiles(checkout)
			const globalKeyResult = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					OPENAI_API_KEY: "sk-proj-x",
					CLOUDFLARE_API_KEY: "global-deploy-secret",
					CLOUDFLARE_EMAIL: "ops@example.com",
					CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
				},
				files: globalKeyFiles,
				spawn: fakeAlchemy([]),
			})
			expect(globalKeyResult.errorMessage).toBeUndefined()
			expect(globalKeyFiles[ENV_FILE]).toBe(
				`CHECKFU_API_KEY=${TEST_API_KEY}\nOPENAI_API_KEY=sk-proj-x\n`,
			)
			expect(globalKeyFiles[ENV_FILE]).not.toContain("global-deploy-secret")

			// 4. CLOUDFLARE_GATEWAY_ID + CLOUDFLARE_AI_API_KEY without CLOUDFLARE_ACCOUNT_ID fails fast
			//    because neither HTTPS transport nor native AI binding can run on the harness.
			const brokenGwCalls: Array<ReadonlyArray<string>> = []
			const brokenGwResult = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CLOUDFLARE_GATEWAY_ID: "my-gateway",
					CLOUDFLARE_AI_API_KEY: "cf-ai-token",
				},
				files: virtualFiles(checkout),
				spawn: fakeAlchemy(brokenGwCalls),
			})
			expect(brokenGwResult.exitCode).toBe(1)
			expect(brokenGwResult.errorMessage).toContain("CLOUDFLARE_ACCOUNT_ID")
			expect(brokenGwCalls.filter((call) => call[0] !== "query")).toEqual([])

			// 5. CLOUDFLARE_GATEWAY_ID + CLOUDFLARE_AI_API_KEY + CLOUDFLARE_ACCOUNT_ID deploys HTTPS gateway
			const httpsGwFiles = virtualFiles(checkout)
			const httpsGwResult = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CLOUDFLARE_GATEWAY_ID: "my-gateway",
					CLOUDFLARE_AI_API_KEY: "cf-ai-token",
					CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
				},
				files: httpsGwFiles,
				spawn: fakeAlchemy([]),
			})
			expect(httpsGwResult.errorMessage).toBeUndefined()
			expect(httpsGwResult.stderr).toContain(
				`${COMMAND} agents create --name Assistant --model cloudflare-ai-gateway/claude-sonnet-5-5`,
			)

			// 6. Custom format-compatible provider declared via CHECKFU_PROVIDERS
			const customManifest = JSON.stringify({
				xai: {
					name: "xAI",
					format: "openai-responses",
					base_url: "https://api.x.ai/v1",
					api_key_env: "CHECKFU_PROVIDER_SECRET_XAI_API_KEY",
					default_model: "grok-4",
				},
			})
			const customFiles = virtualFiles(checkout)
			const customResult = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: customManifest,
					CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "xai-secret-1",
				},
				files: customFiles,
				spawn: fakeAlchemy([]),
			})
			expect(customResult.errorMessage).toBeUndefined()
			expect(yield* readDotEnvValue(customFiles[ENV_FILE] ?? "", "CHECKFU_PROVIDERS")).toBe(
				customManifest,
			)
			expect(
				yield* readDotEnvValue(customFiles[ENV_FILE] ?? "", "CHECKFU_PROVIDER_SECRET_XAI_API_KEY"),
			).toBe("xai-secret-1")
			expect(customResult.stderr).toContain(
				`${COMMAND} agents create --name Assistant --model xai/grok-4`,
			)

			// 7. Exported pretty-printed multiline CHECKFU_PROVIDERS compacts into .env and
			//    shell-quotes custom default_model IDs containing glob/shell metacharacters.
			const prettyCustomManifest = JSON.stringify(
				{
					acme: {
						name: "Acme",
						format: "openai-completions",
						base_url: "https://api.acme.example/v1",
						api_key_env: "CHECKFU_PROVIDER_SECRET_ACME_API_KEY",
						default_model: "model[v1];id",
					},
				},
				null,
				2,
			)
			const compactCustomManifest = JSON.stringify(JSON.parse(prettyCustomManifest))
			const prettyFiles = virtualFiles(checkout)
			const prettyResult = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: prettyCustomManifest,
					CHECKFU_PROVIDER_SECRET_ACME_API_KEY: "acme-secret-1",
				},
				files: prettyFiles,
				spawn: fakeAlchemy([]),
			})
			expect(prettyResult.errorMessage).toBeUndefined()
			expect(yield* readDotEnvValue(prettyFiles[ENV_FILE] ?? "", "CHECKFU_PROVIDERS")).toBe(
				compactCustomManifest,
			)
			expect(prettyResult.stderr).toContain(
				`${COMMAND} agents create --name Assistant --model 'acme/model[v1];id'`,
			)

			// 7b. Exported CHECKFU_PROVIDERS with both apostrophes and backticks inside strings
			//     escapes cleanly into .env and round-trips back to identical strings.
			const quotedCustomManifest = JSON.stringify({
				acme: {
					name: "Acme's `prod` LLM",
					format: "openai-completions",
					base_url: "https://api.acme.example/v1",
					api_key_env: "CHECKFU_PROVIDER_SECRET_ACME_API_KEY",
					headers: { "x-note": 'it\'s `ok` "yes"' },
				},
			})
			const quotedFiles = virtualFiles(checkout)
			const quotedResult = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: quotedCustomManifest,
					CHECKFU_PROVIDER_SECRET_ACME_API_KEY: "acme-secret-1",
				},
				files: quotedFiles,
				spawn: fakeAlchemy([]),
			})
			expect(quotedResult.errorMessage).toBeUndefined()
			const storedQuotedManifest = yield* readDotEnvValue(
				quotedFiles[ENV_FILE] ?? "",
				"CHECKFU_PROVIDERS",
			)
			const parsedQuotedProviders = parseCustomProvidersManifest(storedQuotedManifest)
			expect(parsedQuotedProviders[0]?.name).toBe("Acme's `prod` LLM")
			expect(parsedQuotedProviders[0]?.headers).toEqual({ "x-note": 'it\'s `ok` "yes"' })

			// 8. Missing custom-provider secret_headers variable reports the exact missing env var
			const missingCustomCalls: Array<ReadonlyArray<string>> = []
			const missingCustom = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: JSON.stringify({
						xai: {
							name: "xAI",
							format: "openai-responses",
							base_url: "https://api.x.ai/v1",
							api_key_env: "CHECKFU_PROVIDER_SECRET_XAI_API_KEY",
							secret_headers: { "x-gateway-token": "CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN" },
						},
					}),
					CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "xai-secret-1",
				},
				files: virtualFiles(checkout),
				spawn: fakeAlchemy(missingCustomCalls),
			})
			expect(missingCustom.exitCode).toBe(1)
			expect(missingCustom.errorMessage).toContain("CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN")
			expect(missingCustomCalls.filter((call) => call[0] !== "query")).toEqual([])

			// 8b. Missing custom-provider credentials still block deploy when a built-in key or
			//     another custom provider is already configured.
			const mixedBuiltinCalls: Array<ReadonlyArray<string>> = []
			const mixedBuiltin = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					ANTHROPIC_API_KEY: "sk-ant-from-env",
					CHECKFU_PROVIDERS: JSON.stringify({
						xai: {
							name: "xAI",
							format: "openai-responses",
							base_url: "https://api.x.ai/v1",
							api_key_env: "CHECKFU_PROVIDER_SECRET_XAI_API_KEY",
						},
					}),
				},
				files: virtualFiles(checkout),
				spawn: fakeAlchemy(mixedBuiltinCalls),
			})
			expect(mixedBuiltin.exitCode).toBe(1)
			expect(mixedBuiltin.errorMessage).toContain("CHECKFU_PROVIDER_SECRET_XAI_API_KEY")
			expect(mixedBuiltinCalls.filter((call) => call[0] !== "query")).toEqual([])

			const mixedMultiCustomCalls: Array<ReadonlyArray<string>> = []
			const mixedMultiCustom = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: JSON.stringify({
						acme: {
							name: "Acme",
							format: "openai-completions",
							base_url: "https://api.acme.example/v1",
							api_key_env: "CHECKFU_PROVIDER_SECRET_ACME_API_KEY",
						},
						xai: {
							name: "xAI",
							format: "openai-responses",
							base_url: "https://api.x.ai/v1",
							api_key_env: "CHECKFU_PROVIDER_SECRET_XAI_API_KEY",
							secret_headers: { "x-gateway-token": "CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN" },
						},
					}),
					CHECKFU_PROVIDER_SECRET_ACME_API_KEY: "acme-secret-1",
					CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "xai-secret-1",
				},
				files: virtualFiles(checkout),
				spawn: fakeAlchemy(mixedMultiCustomCalls),
			})
			expect(mixedMultiCustom.exitCode).toBe(1)
			expect(mixedMultiCustom.errorMessage).toContain("CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN")
			expect(mixedMultiCustomCalls.filter((call) => call[0] !== "query")).toEqual([])

			// 9. Custom provider omitting default_model uses declared model (including empty overrides
			//    and namespaced wire IDs) when present, or a placeholder instead of fabricating `<provider>/default`.
			const declaredOnlyResult = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: JSON.stringify({
						acme: {
							format: "openai-completions",
							base_url: "https://api.acme.example/v1",
							api_key_env: "CHECKFU_PROVIDER_SECRET_ACME_API_KEY",
							models: { "acme/chat": {} },
						},
					}),
					CHECKFU_PROVIDER_SECRET_ACME_API_KEY: "acme-secret-1",
				},
				files: virtualFiles(checkout),
				spawn: fakeAlchemy([]),
			})
			expect(declaredOnlyResult.errorMessage).toBeUndefined()
			expect(declaredOnlyResult.stderr).toContain(
				`${COMMAND} agents create --name Assistant --model acme/acme/chat`,
			)

			const noDefaultResult = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: JSON.stringify({
						acme: {
							format: "openai-completions",
							base_url: "https://api.acme.example/v1",
							api_key_env: "CHECKFU_PROVIDER_SECRET_ACME_API_KEY",
						},
					}),
					CHECKFU_PROVIDER_SECRET_ACME_API_KEY: "acme-secret-1",
				},
				files: virtualFiles(checkout),
				spawn: fakeAlchemy([]),
			})
			expect(noDefaultResult.errorMessage).toBeUndefined()
			expect(noDefaultResult.stderr).toContain(
				`${COMMAND} agents create --name Assistant --model acme/<model-id>`,
			)
			expect(noDefaultResult.stderr).not.toContain("acme/default")

			// 10. Invalid CHECKFU_PROVIDERS (inline secret, non-namespaced secret env, or non-ASCII
			//     header value) stops before deploying.
			const badCalls: Array<ReadonlyArray<string>> = []
			const badCustom = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: JSON.stringify({
						bad: {
							format: "openai-responses",
							base_url: "https://api.example.com/v1",
							api_key: "sk-inline-leak",
						},
					}),
				},
				files: virtualFiles(checkout),
				spawn: fakeAlchemy(badCalls),
			})
			expect(badCustom.exitCode).toBe(1)
			expect(badCustom.errorMessage).toContain("inline secret")
			expect(badCalls.filter((call) => call[0] !== "query")).toEqual([])

			const disallowedEnvCalls: Array<ReadonlyArray<string>> = []
			const disallowedEnvCustom = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					GH_ENTERPRISE_TOKEN: "ghp_unrelated_deploy_secret",
					CHECKFU_PROVIDERS: JSON.stringify({
						bad: {
							format: "openai-responses",
							base_url: "https://api.example.com/v1",
							api_key_env: "GH_ENTERPRISE_TOKEN",
						},
					}),
				},
				files: virtualFiles(checkout),
				spawn: fakeAlchemy(disallowedEnvCalls),
			})
			expect(disallowedEnvCustom.exitCode).toBe(1)
			expect(disallowedEnvCustom.errorMessage).toContain("CHECKFU_PROVIDER_SECRET_")
			expect(disallowedEnvCustom.errorMessage).not.toContain("ghp_unrelated_deploy_secret")
			expect(disallowedEnvCalls.filter((call) => call[0] !== "query")).toEqual([])

			const badHeaderCalls: Array<ReadonlyArray<string>> = []
			const badHeaderCustom = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: JSON.stringify({
						bad: {
							format: "openai-responses",
							base_url: "https://api.example.com/v1",
							api_key_env: "CHECKFU_PROVIDER_SECRET_BAD_API_KEY",
							headers: { "x-tenant": "東京" },
						},
					}),
					CHECKFU_PROVIDER_SECRET_BAD_API_KEY: "bad-key",
				},
				files: virtualFiles(checkout),
				spawn: fakeAlchemy(badHeaderCalls),
			})
			expect(badHeaderCustom.exitCode).toBe(1)
			expect(badHeaderCustom.errorMessage).toContain('Custom provider "bad" header "x-tenant"')
			expect(badHeaderCalls.filter((call) => call[0] !== "query")).toEqual([])

			// 11. Malformed CHECKFU_PROVIDERS JSON never echoes unquoted credentials into CLI errors
			const leakedSecret = "sk_unquoted_ci_secret_4242"
			const badJsonCalls: Array<ReadonlyArray<string>> = []
			const badJsonCustom = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: `{"bad":{"api_key":${leakedSecret}}}`,
				},
				files: virtualFiles(checkout),
				spawn: fakeAlchemy(badJsonCalls),
			})
			expect(badJsonCustom.exitCode).toBe(1)
			expect(badJsonCustom.errorMessage).toContain("Invalid CHECKFU_PROVIDERS JSON")
			expect(badJsonCustom.errorMessage).not.toContain(leakedSecret)
			expect(badJsonCustom.stderr).not.toContain(leakedSecret)
			expect(badJsonCalls.filter((call) => call[0] !== "query")).toEqual([])

			// 12. Pasted credential in auth.type never leaks into CLI errors, and duplicate
			//     object-form provider IDs stop before deploying.
			const pastedBearer = "Bearer sk_accidental_auth_type_secret"
			const badAuthTypeCustom = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: JSON.stringify({
						bad: {
							format: "openai-completions",
							base_url: "https://api.example.com/v1",
							auth: { type: pastedBearer, env: "CHECKFU_PROVIDER_SECRET_BAD_KEY" },
						},
					}),
				},
				files: virtualFiles(checkout),
				spawn: fakeAlchemy([]),
			})
			expect(badAuthTypeCustom.exitCode).toBe(1)
			expect(badAuthTypeCustom.errorMessage).toContain("auth.type")
			expect(badAuthTypeCustom.errorMessage).not.toContain(pastedBearer)
			expect(badAuthTypeCustom.stderr).not.toContain(pastedBearer)

			const dupObjectCustom = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS:
						'{"acme":{"format":"openai-completions","base_url":"https://a.example/v1","api_key_env":"CHECKFU_PROVIDER_SECRET_A_KEY"},"acme":{"format":"openai-completions","base_url":"https://b.example/v1","api_key_env":"CHECKFU_PROVIDER_SECRET_B_KEY"}}',
					CHECKFU_PROVIDER_SECRET_A_KEY: "a",
					CHECKFU_PROVIDER_SECRET_B_KEY: "b",
				},
				files: virtualFiles(checkout),
				spawn: fakeAlchemy([]),
			})
			expect(dupObjectCustom.exitCode).toBe(1)
			expect(dupObjectCustom.errorMessage).toContain('Duplicate custom provider id "acme"')

			// 13. Oversized CHECKFU_PROVIDERS (including Alchemy-packed Redacted encoding) or
			//     serialized CHECKFU_PROVIDER_CATALOG (> 5,120 UTF-8 bytes) stops before writing
			//     .env or invoking Alchemy.
			const packedOverflowCalls: Array<ReadonlyArray<string>> = []
			const packedOverflowFiles = virtualFiles(checkout)
			const packedOverflow = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: JSON.stringify({
						acme: {
							format: "openai-responses",
							base_url: "https://api.acme.example/v1",
							auth: { type: "none" },
							headers: Object.fromEntries(
								Array.from({ length: 300 }, (_, index) => [
									`x-h-${String(index).padStart(3, "0")}`,
									"v",
								]),
							),
						},
					}),
				},
				files: packedOverflowFiles,
				spawn: fakeAlchemy(packedOverflowCalls),
			})
			expect(packedOverflow.exitCode).toBe(1)
			expect(packedOverflow.errorMessage).toContain("CHECKFU_PROVIDERS")
			expect(packedOverflow.errorMessage).toContain("5120")
			expect(packedOverflowFiles[ENV_FILE]).toBeUndefined()
			expect(packedOverflowCalls.filter((call) => call[0] !== "query")).toEqual([])

			const oversizedRawCalls: Array<ReadonlyArray<string>> = []
			const oversizedRawFiles = virtualFiles(checkout)
			const oversizedRaw = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: JSON.stringify({
						acme: {
							name: "東".repeat(1750),
							format: "openai-responses",
							base_url: "https://api.acme.example/v1",
							auth: { type: "none" },
						},
					}),
				},
				files: oversizedRawFiles,
				spawn: fakeAlchemy(oversizedRawCalls),
			})
			expect(oversizedRaw.exitCode).toBe(1)
			expect(oversizedRaw.errorMessage).toContain("CHECKFU_PROVIDERS")
			expect(oversizedRaw.errorMessage).toContain("5120")
			expect(oversizedRawFiles[ENV_FILE]).toBeUndefined()
			expect(oversizedRawCalls.filter((call) => call[0] !== "query")).toEqual([])

			const oversizedCatalogCalls: Array<ReadonlyArray<string>> = []
			const oversizedCatalogFiles = virtualFiles(checkout)
			const oversizedCatalog = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: JSON.stringify(
						Object.fromEntries(
							Array.from({ length: 31 }, (_, index) => [
								`provider-${String(index).padStart(2, "0")}-${"x".repeat(46)}`,
								{
									format: "openai-responses",
									base_url: "https://a.co",
									auth: { type: "none" },
								},
							]),
						),
					),
				},
				files: oversizedCatalogFiles,
				spawn: fakeAlchemy(oversizedCatalogCalls),
			})
			expect(oversizedCatalog.exitCode).toBe(1)
			expect(oversizedCatalog.errorMessage).toContain("CHECKFU_PROVIDER_CATALOG")
			expect(oversizedCatalog.errorMessage).toContain("5120")
			expect(oversizedCatalogFiles[ENV_FILE]).toBeUndefined()
			expect(oversizedCatalogCalls.filter((call) => call[0] !== "query")).toEqual([])

			// 14. Custom credentials that cannot be sent as HTTP headers (embedded newlines,
			//     non-ASCII, or whitespace in bearer tokens) fail before deploy and report
			//     only the env var name; interior spaces remain allowed in api_key_header / secret_headers.
			const customSecretManifest = JSON.stringify({
				xai: {
					name: "xAI",
					format: "openai-responses",
					base_url: "https://api.x.ai/v1",
					api_key_env: "CHECKFU_PROVIDER_SECRET_XAI_API_KEY",
					secret_headers: { "x-gateway-token": "CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN" },
				},
			})
			const newlinePrimaryCalls: Array<ReadonlyArray<string>> = []
			const newlinePrimary = yield* cli.run(["deploy", "--yes"], {
				env: { CHECKFU_CONFIG_DIR: "/config" },
				files: virtualFiles({
					...checkout,
					[ENV_FILE]: [
						`CHECKFU_API_KEY=${TEST_API_KEY}`,
						`CHECKFU_PROVIDERS='${customSecretManifest}'`,
						String.raw`CHECKFU_PROVIDER_SECRET_XAI_API_KEY="sk-primary-line1\nsk-primary-line2"`,
						"CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN=gw-ok-token",
					].join("\n"),
				}),
				spawn: fakeAlchemy(newlinePrimaryCalls),
			})
			expect(newlinePrimary.exitCode).toBe(1)
			expect(newlinePrimary.errorMessage).toContain("CHECKFU_PROVIDER_SECRET_XAI_API_KEY")
			expect(newlinePrimary.errorMessage).toContain("HTTP header")
			expect(newlinePrimary.errorMessage).not.toContain("sk-primary-line1")
			expect(newlinePrimary.stderr).not.toContain("sk-primary-line1")
			expect(newlinePrimaryCalls.filter((call) => call[0] !== "query")).toEqual([])

			const newlineHeaderCalls: Array<ReadonlyArray<string>> = []
			const newlineHeader = yield* cli.run(["deploy", "--yes"], {
				env: { CHECKFU_CONFIG_DIR: "/config" },
				files: virtualFiles({
					...checkout,
					[ENV_FILE]: [
						`CHECKFU_API_KEY=${TEST_API_KEY}`,
						`CHECKFU_PROVIDERS='${customSecretManifest}'`,
						"CHECKFU_PROVIDER_SECRET_XAI_API_KEY=sk-primary-ok",
						String.raw`CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN="gw-secret-line1\ngw-secret-line2"`,
					].join("\n"),
				}),
				spawn: fakeAlchemy(newlineHeaderCalls),
			})
			expect(newlineHeader.exitCode).toBe(1)
			expect(newlineHeader.errorMessage).toContain("CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN")
			expect(newlineHeader.errorMessage).toContain("HTTP header")
			expect(newlineHeader.errorMessage).not.toContain("gw-secret-line1")
			expect(newlineHeader.stderr).not.toContain("gw-secret-line1")
			expect(newlineHeaderCalls.filter((call) => call[0] !== "query")).toEqual([])

			const nonAsciiSecretFiles = virtualFiles(checkout)
			const nonAsciiSecretCalls: Array<ReadonlyArray<string>> = []
			const nonAsciiSecret = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: customSecretManifest,
					CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "sk-primary-ok",
					CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN: "gw-東京-secret",
				},
				files: nonAsciiSecretFiles,
				spawn: fakeAlchemy(nonAsciiSecretCalls),
			})
			expect(nonAsciiSecret.exitCode).toBe(1)
			expect(nonAsciiSecret.errorMessage).toContain("CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN")
			expect(nonAsciiSecret.errorMessage).toContain("HTTP header")
			expect(nonAsciiSecret.errorMessage).not.toContain("東京")
			expect(nonAsciiSecret.stderr).not.toContain("東京")
			expect(nonAsciiSecretFiles[ENV_FILE]).toBeUndefined()
			expect(nonAsciiSecretCalls.filter((call) => call[0] !== "query")).toEqual([])

			const spacedBearerFiles = virtualFiles(checkout)
			const spacedBearer = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: customSecretManifest,
					CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "Bearer sk-accidental-prefix",
					CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN: "gw-ok-token",
				},
				files: spacedBearerFiles,
				spawn: fakeAlchemy([]),
			})
			expect(spacedBearer.exitCode).toBe(1)
			expect(spacedBearer.errorMessage).toContain("CHECKFU_PROVIDER_SECRET_XAI_API_KEY")
			expect(spacedBearer.errorMessage).toContain("HTTP header")
			expect(spacedBearer.errorMessage).not.toContain("sk-accidental-prefix")
			expect(spacedBearerFiles[ENV_FILE]).toBeUndefined()

			// Exported shell secrets with trailing newlines or surrounding spaces are rejected
			// before trimming or writing .env (matching quoted .env validation).
			const trailingNewlineShellFiles = virtualFiles(checkout)
			const trailingNewlineShellCalls: Array<ReadonlyArray<string>> = []
			const trailingNewlineShell = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: customSecretManifest,
					CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "sk-shell-trailing-nl\n",
					CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN: "gw-ok-token",
				},
				files: trailingNewlineShellFiles,
				spawn: fakeAlchemy(trailingNewlineShellCalls),
			})
			expect(trailingNewlineShell.exitCode).toBe(1)
			expect(trailingNewlineShell.errorMessage).toContain("CHECKFU_PROVIDER_SECRET_XAI_API_KEY")
			expect(trailingNewlineShell.errorMessage).toContain("HTTP header")
			expect(trailingNewlineShell.errorMessage).not.toContain("sk-shell-trailing-nl")
			expect(trailingNewlineShell.stderr).not.toContain("sk-shell-trailing-nl")
			expect(trailingNewlineShellFiles[ENV_FILE]).toBeUndefined()
			expect(trailingNewlineShellCalls.filter((call) => call[0] !== "query")).toEqual([])

			const surroundingSpaceHeaderFiles = virtualFiles(checkout)
			const surroundingSpaceHeaderCalls: Array<ReadonlyArray<string>> = []
			const surroundingSpaceHeader = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: customSecretManifest,
					CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "sk-primary-ok",
					CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN: " gw-shell-surrounded ",
				},
				files: surroundingSpaceHeaderFiles,
				spawn: fakeAlchemy(surroundingSpaceHeaderCalls),
			})
			expect(surroundingSpaceHeader.exitCode).toBe(1)
			expect(surroundingSpaceHeader.errorMessage).toContain("CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN")
			expect(surroundingSpaceHeader.errorMessage).toContain("HTTP header")
			expect(surroundingSpaceHeader.errorMessage).not.toContain("gw-shell-surrounded")
			expect(surroundingSpaceHeader.stderr).not.toContain("gw-shell-surrounded")
			expect(surroundingSpaceHeaderFiles[ENV_FILE]).toBeUndefined()
			expect(surroundingSpaceHeaderCalls.filter((call) => call[0] !== "query")).toEqual([])

			// Printable custom secrets whose Alchemy-packed binding exceeds 5,120 UTF-8 bytes fail
			// before writing .env or deploying, reporting only the variable name and size.
			const oversizedSecretFiles = virtualFiles(checkout)
			const oversizedSecretCalls: Array<ReadonlyArray<string>> = []
			const oversizedSecret = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: customSecretManifest,
					CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "k".repeat(5091),
					CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN: "gw-ok-token",
				},
				files: oversizedSecretFiles,
				spawn: fakeAlchemy(oversizedSecretCalls),
			})
			expect(oversizedSecret.exitCode).toBe(1)
			expect(oversizedSecret.errorMessage).toContain("CHECKFU_PROVIDER_SECRET_XAI_API_KEY")
			expect(oversizedSecret.errorMessage).toContain("5121")
			expect(oversizedSecret.errorMessage).toContain("5120")
			expect(oversizedSecret.errorMessage).not.toContain("kkkkkk")
			expect(oversizedSecret.stderr).not.toContain("kkkkkk")
			expect(oversizedSecretFiles[ENV_FILE]).toBeUndefined()
			expect(oversizedSecretCalls.filter((call) => call[0] !== "query")).toEqual([])

			const oversizedHeaderSecretFiles = virtualFiles(checkout)
			const oversizedHeaderSecretCalls: Array<ReadonlyArray<string>> = []
			const oversizedHeaderSecret = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: customSecretManifest,
					CHECKFU_PROVIDER_SECRET_XAI_API_KEY: "sk-primary-ok",
					CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN: "t".repeat(5091),
				},
				files: oversizedHeaderSecretFiles,
				spawn: fakeAlchemy(oversizedHeaderSecretCalls),
			})
			expect(oversizedHeaderSecret.exitCode).toBe(1)
			expect(oversizedHeaderSecret.errorMessage).toContain("CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN")
			expect(oversizedHeaderSecret.errorMessage).toContain("5121")
			expect(oversizedHeaderSecret.errorMessage).toContain("5120")
			expect(oversizedHeaderSecret.errorMessage).not.toContain("tttttt")
			expect(oversizedHeaderSecret.stderr).not.toContain("tttttt")
			expect(oversizedHeaderSecretFiles[ENV_FILE]).toBeUndefined()
			expect(oversizedHeaderSecretCalls.filter((call) => call[0] !== "query")).toEqual([])

			const spacedHeaderAuthResult = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: JSON.stringify({
						corp: {
							name: "Corp",
							format: "openai-completions",
							base_url: "https://corp.example/v1",
							auth: {
								type: "api_key_header",
								header: "X-Corp-Auth",
								env: "CHECKFU_PROVIDER_SECRET_CORP_AUTH",
							},
							secret_headers: { "CF-AIG-Authorization": "CHECKFU_PROVIDER_SECRET_CORP_GW_AUTH" },
						},
					}),
					CHECKFU_PROVIDER_SECRET_CORP_AUTH: "Basic dXNlcjpwYXNz",
					CHECKFU_PROVIDER_SECRET_CORP_GW_AUTH: "Bearer gw-token-ok",
				},
				files: virtualFiles(checkout),
				spawn: fakeAlchemy([]),
			})
			expect(spacedHeaderAuthResult.errorMessage).toBeUndefined()

			// 15. Valid exported custom secrets containing all three quote characters (', ", `)
			//     pass validation and deploy via Alchemy's inherited shell ConfigProvider fallback
			//     without corrupting .env (even when .env holds an empty placeholder line).
			const allQuotesSecret = "sk-'single'-\"double\"-`backtick`"
			for (const initialEnvContents of [
				undefined,
				`CHECKFU_API_KEY=${TEST_API_KEY}\nCHECKFU_PROVIDER_SECRET_XAI_API_KEY=\n`,
			]) {
				const allQuotesFiles = virtualFiles(
					initialEnvContents === undefined
						? checkout
						: { ...checkout, [ENV_FILE]: initialEnvContents },
				)
				const allQuotesEnv = {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					CHECKFU_PROVIDERS: customSecretManifest,
					CHECKFU_PROVIDER_SECRET_XAI_API_KEY: allQuotesSecret,
					CHECKFU_PROVIDER_SECRET_XAI_GW_TOKEN: "gw-ok-token",
				}
				const allQuotesResult = yield* cli.run(["deploy", "--yes"], {
					env: allQuotesEnv,
					files: allQuotesFiles,
					spawn: fakeAlchemy([]),
				})
				expect(allQuotesResult.errorMessage).toBeUndefined()
				expect(allQuotesResult.stderr).toContain("CHECKFU_PROVIDER_SECRET_XAI_API_KEY")
				expect(allQuotesResult.stderr).toContain("not saved to .env")
				expect(allQuotesResult.stderr).not.toContain(allQuotesSecret)
				const envText = allQuotesFiles[ENV_FILE] ?? ""
				expect(envText).not.toContain(allQuotesSecret)
				// Verify Alchemy's `--env-file` ConfigProvider (`orElse(dotEnv, shell)`) resolves the
				// exact lossless secret from the inherited shell environment.
				const alchemyProvider = ConfigProvider.orElse(
					ConfigProvider.fromDotEnvContents(envText),
					ConfigProvider.fromEnvRecord(allQuotesEnv),
				)
				const resolvedSecret = yield* Config.String("CHECKFU_PROVIDER_SECRET_XAI_API_KEY").parse(
					alchemyProvider,
				)
				expect(resolvedSecret).toBe(allQuotesSecret)
			}
		}),
	)

	it.live("refuses to run outside a source checkout", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const result = yield* cli.run(["deploy"], { env: deployEnv, spawn: fakeAlchemy([]) })
			expect(result.exitCode).toBe(1)
			expect(result.errorMessage).toContain("source checkout")
		}),
	)
})

describe("checkfu destroy", () => {
	const savedLive = JSON.stringify({ url: DEPLOYED_URL, api_key: TEST_API_KEY })
	const liveCheckout = {
		"/checkout/alchemy.run.ts": "",
		[STAGE_FILE]: "live\n",
		[recordFile("live")]: record("live"),
	}
	const env = { CHECKFU_CONFIG_DIR: "/config" }
	const PROFILE = ["--profile", "default"]

	it.live(
		"refuses unconfirmed headless destruction before account lookup and preserves the connection",
		() =>
			Effect.gen(function* () {
				const cli = yield* makeTestServer()
				const files = virtualFiles({ ...liveCheckout, [CONFIG_FILE]: savedLive })
				const calls: Array<ReadonlyArray<string>> = []
				const result = yield* cli.run(["destroy", "--stage", "live"], {
					env,
					files,
					stdinIsTerminal: false,
					spawn: fakeAlchemy(calls),
				})
				expect(result.exitCode).toBe(1)
				expect(result.errorMessage).toContain("--yes")
				expect(calls).toEqual([])
				expect(files[CONFIG_FILE]).toBe(savedLive)
				expect(files[recordFile("live")]).toBe(record("live"))
			}),
	)

	it.live("deletes the deployment that is both named and recorded, then forgets it", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({ ...liveCheckout, [CONFIG_FILE]: savedLive })
			const calls: Array<ReadonlyArray<string>> = []
			const result = yield* cli.run(["destroy", "--yes", "--stage", "live"], {
				env,
				files,
				spawn: fakeAlchemy(calls),
			})
			expect(result.errorMessage).toBeUndefined()
			expect(calls).toEqual([
				["query", "account", "default", ""],
				["destroy", "--stage", "live", "--yes", ...PROFILE],
			])
			expect(files[CONFIG_FILE]).toBeUndefined()
			expect(files[recordFile("live")]).toBeUndefined()
		}),
	)

	it.live("never chooses a stage itself and never deletes one this checkout did not record", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			for (const [args, files, message] of [
				[["destroy", "--yes"], liveCheckout, 'This CLI last deployed "live"'],
				[["destroy", "--yes"], { "/checkout/alchemy.run.ts": "" }, "Name the stage to delete"],
				[["destroy", "--yes", "--stage", "staging"], liveCheckout, 'it last deployed "live"'],
				[
					["destroy", "--yes", "--stage", "live"],
					{ "/checkout/alchemy.run.ts": "" },
					"Use the configuration directory that originally deployed this stage",
				],
			] as const) {
				const calls: Array<ReadonlyArray<string>> = []
				const result = yield* cli.run(args, {
					env,
					files: { ...files, [CONFIG_FILE]: savedLive },
					spawn: fakeAlchemy(calls),
				})
				expect(result.exitCode).toBe(1)
				expect(result.errorMessage).toContain(message)
				expect(calls).toEqual([])
			}
		}),
	)

	it.live("keeps each stage destroyable after selecting another stage", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles(liveCheckout)
			const options = { env: deployEnv, files }
			const stagingUrl = "https://staging.example.workers.dev"
			const staging = yield* cli.run(["deploy", "--yes", "--stage", "staging"], {
				...options,
				spawn: fakeAlchemy([], { url: stagingUrl }),
			})
			expect(staging.exitCode).toBe(0)
			expect(files[recordFile("live")]).toBe(record("live"))
			expect(files[recordFile("staging")]).toBe(record("staging", "default", ACCOUNT, stagingUrl))
			expect(files[STAGE_FILE]).toBe("staging\n")

			const before = { ...files }
			const invalid = yield* cli.run(["deploy", "--yes", "--stage", "../other"], {
				...options,
				spawn: fakeAlchemy([]),
			})
			expect(invalid.exitCode).toBe(1)
			expect(files).toEqual(before)

			const calls: Array<ReadonlyArray<string>> = []
			const destroyed = yield* cli.run(["destroy", "--yes", "--stage", "live"], {
				...options,
				spawn: fakeAlchemy(calls),
			})
			expect(destroyed.exitCode).toBe(0)
			expect(calls.at(-1)).toEqual(["destroy", "--stage", "live", "--yes", ...SHARED])
			expect(files[recordFile("live")]).toBeUndefined()
			expect(files[recordFile("staging")]).toBe(before[recordFile("staging")])
			expect(files[CONFIG_FILE]).toBe(before[CONFIG_FILE])

			const defaultCalls: Array<ReadonlyArray<string>> = []
			const redeployed = yield* cli.run(["deploy", "--yes"], {
				...options,
				spawn: fakeAlchemy(defaultCalls, { url: stagingUrl }),
			})
			expect(redeployed.exitCode).toBe(0)
			expect(defaultCalls[1]).toEqual(["deploy", "--stage", "staging", "--yes", ...SHARED])

			const last = yield* cli.run(["destroy", "--yes", "--stage", "staging"], {
				...options,
				spawn: fakeAlchemy([]),
			})
			expect(last.exitCode).toBe(0)
			expect(files[recordFile("staging")]).toBeUndefined()
			defaultCalls.length = 0
			yield* cli.run(["deploy", "--yes"], { ...options, spawn: fakeAlchemy(defaultCalls) })
			expect(defaultCalls[1]).toEqual(["deploy", "--stage", "live", "--yes", ...SHARED])
		}),
	)

	it.live("keeps stages that differ only by case in distinct checkout records", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({ "/checkout/alchemy.run.ts": "" })
			for (const stage of ["QA", "qa"]) {
				const deploy = yield* cli.run(["deploy", "--yes", "--stage", stage], {
					env: deployEnv,
					files,
					spawn: fakeAlchemy([], { url: `https://${stage === "QA" ? "upper" : "lower"}.example` }),
				})
				expect(deploy.exitCode).toBe(0)
			}
			const upper = recordFile("~q~a")
			const lower = recordFile("qa")
			expect(upper.toLowerCase()).not.toBe(lower.toLowerCase())
			expect(files[upper]).toBe(record("QA", "default", ACCOUNT, "https://upper.example"))
			expect(files[lower]).toBe(record("qa", "default", ACCOUNT, "https://lower.example"))

			const cleared = yield* cli.run(["destroy", "--yes", "--stage", "QA"], {
				env: deployEnv,
				files,
				spawn: fakeAlchemy([]),
			})
			expect(cleared.exitCode).toBe(0)
			expect(files[upper]).toBeUndefined()
			expect(files[lower]).toBe(record("qa", "default", ACCOUNT, "https://lower.example"))
		}),
	)

	it.live("refuses a record that does not own the stage named by its file", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({ ...liveCheckout, [recordFile("staging")]: record("live") })
			for (const operation of ["deploy", "destroy"]) {
				const calls: Array<ReadonlyArray<string>> = []
				const result = yield* cli.run([operation, "--yes", "--stage", "staging"], {
					env: deployEnv,
					files,
					spawn: fakeAlchemy(calls),
				})
				expect(result.errorMessage).toContain('records "live", but "staging" was requested')
				expect(calls).toEqual([])
				expect(files[recordFile("staging")]).toBe(record("live"))
			}
		}),
	)

	it.live("uses the recorded profile whatever the login or shell profile is now", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({ "/checkout/alchemy.run.ts": "" })
			yield* cli.run(["deploy", "--yes", "--stage", "staging"], {
				env: { ...deployEnv, ALCHEMY_PROFILE: "work" },
				files,
				spawn: fakeAlchemy([]),
			})
			expect(files[recordFile("staging")]).toBe(record("staging", "work"))

			yield* cli.run(["--base-url", "https://another.example", "login"], { env: deployEnv, files })
			yield* cli.run(["logout"], { env: deployEnv, files })

			const calls: Array<ReadonlyArray<string>> = []
			yield* cli.run(["destroy", "--yes", "--stage", "staging"], {
				env: deployEnv,
				files,
				spawn: fakeAlchemy(calls),
			})
			expect(calls).toEqual([
				["query", "account", "work", ENV_FILE],
				["destroy", "--stage", "staging", "--yes", "--env-file", ENV_FILE, "--profile", "work"],
			])
		}),
	)

	it.live("refuses when the credentials act on a different or undetermined account", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			for (const [options, message] of [
				[{ account: OTHER_ACCOUNT }, `act on account ${OTHER_ACCOUNT}`],
				[
					{ accountError: "StateStoreError: unreachable" },
					"Could not determine which Cloudflare account",
				],
				[{ account: null }, "is not configured in profile"],
			] as const) {
				const files = virtualFiles({ ...liveCheckout, [CONFIG_FILE]: savedLive })
				const calls: Array<ReadonlyArray<string>> = []
				const result = yield* cli.run(["destroy", "--yes", "--stage", "live"], {
					env,
					files,
					stdinIsTerminal: true,
					spawn: fakeAlchemy(calls, options),
				})
				expect(result.exitCode).toBe(1)
				expect(result.errorMessage).toContain(message)
				expect(calls.map((call) => call[0])).toEqual(["query"])
				expect(files[recordFile("live")]).toBe(record("live"))
				expect(files[CONFIG_FILE]).toBe(savedLive)
			}
		}),
	)
})

describe("saved connection", () => {
	const saved = (extra: Record<string, string> = {}) =>
		JSON.stringify({ url: DEPLOYED_URL, api_key: TEST_API_KEY, ...extra })

	it.live("is used when no URL or key is exported", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const result = yield* cli.run(["environments", "create", "--name", "default"], {
				env: { CHECKFU_CONFIG_DIR: "/config" },
				files: { [CONFIG_FILE]: saved() },
			})
			expect(result.errorMessage).toBeUndefined()
			expect(result.stdout).toContain('"name":"default"')
		}),
	)

	it.live("is not read at all when the URL and key are both given explicitly", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			for (const broken of ["{ not json", Stream.empty]) {
				const result = yield* cli.run(
					["--base-url", DEPLOYED_URL, "environments", "create", "--name", "default"],
					{
						env: { CHECKFU_CONFIG_DIR: "/config", CHECKFU_API_KEY: TEST_API_KEY },
						files: { [CONFIG_FILE]: broken },
					},
				)
				expect(result.errorMessage).toBeUndefined()

				const needed = yield* cli.run(["environments", "create", "--name", "default"], {
					env: { CHECKFU_CONFIG_DIR: "/config", CHECKFU_API_KEY: TEST_API_KEY },
					files: { [CONFIG_FILE]: broken },
				})
				expect(needed.exitCode).toBe(1)
				expect(needed.errorMessage).toContain(CONFIG_FILE)
			}
		}),
	)

	it.live("is used at exactly the URL the key was verified against", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles()
			const requested: Array<string> = []
			const underPrefix = (next: (request: Request) => Promise<Response>, request: Request) => {
				requested.push(request.url)
				const url = new URL(request.url)
				if (!url.pathname.startsWith("/team/v1/")) {
					return Promise.resolve(new Response("another service", { status: 200 }))
				}
				url.pathname = url.pathname.slice("/team/v1".length)
				return next(new Request(url, request))
			}
			const env = { CHECKFU_CONFIG_DIR: "/config" }

			const login = yield* cli.run(["--base-url", "https://host.example/team/v1/v1", "login"], {
				env: { ...env, CHECKFU_API_KEY: TEST_API_KEY },
				files,
				interceptFetch: underPrefix,
			})
			expect(login.errorMessage).toBeUndefined()
			expect(JSON.parse(files[CONFIG_FILE] ?? "").url).toBe("https://host.example/team/v1")

			requested.length = 0
			const later = yield* cli.run(["environments", "create", "--name", "default"], {
				env,
				files,
				interceptFetch: underPrefix,
			})
			expect(later.errorMessage).toBeUndefined()
			expect(requested).toEqual(["https://host.example/team/v1/v1/environments"])

			const edited = yield* cli.run(["environments", "create", "--name", "default"], {
				env,
				files: { [CONFIG_FILE]: saved({ url: "https://host.example/team/v1/" }) },
				interceptFetch: underPrefix,
			})
			expect(edited.errorMessage).toContain("not in the form it is saved in")
		}),
	)

	it.live("never sends the saved key to a different URL", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			let requests = 0
			const result = yield* cli.run(
				["--base-url", "https://elsewhere.example", "environments", "create", "--name", "x"],
				{
					env: { CHECKFU_CONFIG_DIR: "/config" },
					files: { [CONFIG_FILE]: saved() },
					interceptFetch: (next, request) => {
						requests++
						return next(request)
					},
				},
			)
			expect(result.exitCode).toBe(1)
			expect(result.errorMessage).toContain("is not sent to https://elsewhere.example")
			expect(requests).toBe(0)
		}),
	)

	it.live("login refuses to save when the URL does not answer like Checkfu", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const working = saved()
			for (const response of [
				new Response("<html>Not Found</html>", { status: 404 }),
				new Response(null, { status: 301, headers: { location: "https://elsewhere.example" } }),
				new Response("Forbidden", { status: 403 }),
			]) {
				const files = virtualFiles({ [CONFIG_FILE]: working })
				const result = yield* cli.run(["--base-url", "https://proxy.example", "login"], {
					env: { CHECKFU_CONFIG_DIR: "/config", CHECKFU_API_KEY: TEST_API_KEY },
					files,
					interceptFetch: () => Promise.resolve(response),
				})
				expect(result.errorMessage).toContain("did not answer like a Checkfu API")
				expect(files[CONFIG_FILE]).toBe(working)
			}
		}),
	)

	it.live("login only sends the key to a route that has just asked for one", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			for (const [status, type] of [
				[429, "rate_limit_error"],
				[500, "internal_error"],
				[404, "not_found_error"],
			] as const) {
				const authorized: Array<string | null> = []
				const files = virtualFiles()
				const result = yield* cli.run(["--base-url", "https://proxy.example", "login"], {
					env: { CHECKFU_CONFIG_DIR: "/config", CHECKFU_API_KEY: TEST_API_KEY },
					files,
					interceptFetch: (_next, request) => {
						authorized.push(request.headers.get("authorization"))
						return Promise.resolve(errorEnvelope(status, type))
					},
				})
				expect(result.errorMessage).toContain("did not answer like a Checkfu API")
				expect(authorized).toEqual([null])
				expect(files[CONFIG_FILE]).toBeUndefined()
			}
		}),
	)

	it.live("login accepts only the API's own confirmation that the key is valid", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			for (const confirmation of [
				Response.json({}),
				Response.json({ type: "agent" }),
				new Response("<html>ok</html>"),
				errorEnvelope(404, "not_found_error"),
			]) {
				const files = virtualFiles()
				const result = yield* cli.run(["--base-url", "https://proxy.example", "login"], {
					env: { CHECKFU_CONFIG_DIR: "/config", CHECKFU_API_KEY: TEST_API_KEY },
					files,
					interceptFetch: (_next, request) =>
						Promise.resolve(
							request.headers.has("authorization")
								? confirmation.clone()
								: errorEnvelope(401, "authentication_error"),
						),
				})
				expect(result.exitCode).toBe(1)
				expect(files[CONFIG_FILE]).toBeUndefined()
			}

			const files = virtualFiles()
			const accepted = yield* cli.run(["--base-url", "https://proxy.example", "login"], {
				env: { CHECKFU_CONFIG_DIR: "/config", CHECKFU_API_KEY: TEST_API_KEY },
				files,
				interceptFetch: (_next, request) =>
					Promise.resolve(
						request.headers.has("authorization")
							? Response.json({ type: "authentication_verified" })
							: errorEnvelope(401, "authentication_error"),
					),
			})
			expect(accepted.errorMessage).toBeUndefined()
			expect(JSON.parse(files[CONFIG_FILE] ?? "")).toMatchObject({ url: "https://proxy.example" })
		}),
	)

	it.live("login rejects a mistyped path prefix even though unknown routes answer 404", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const working = saved()
			for (const key of ["wrong", TEST_API_KEY]) {
				const files = virtualFiles({ [CONFIG_FILE]: working })
				const result = yield* cli.run(["--base-url", `${DEPLOYED_URL}/typo`, "login"], {
					env: { CHECKFU_CONFIG_DIR: "/config", CHECKFU_API_KEY: key },
					files,
				})
				expect(result.errorMessage).toContain("did not answer like a Checkfu API")
				expect(files[CONFIG_FILE]).toBe(working)
			}
		}),
	)

	it.live("login gives up on an endpoint whose body never ends", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles()
			const result = yield* cli.run(["--base-url", "https://slow.example", "login"], {
				env: { CHECKFU_CONFIG_DIR: "/config", CHECKFU_API_KEY: TEST_API_KEY },
				files,
				interceptFetch: () =>
					Promise.resolve(
						new Response(
							new ReadableStream({
								pull: (controller) => {
									controller.enqueue(new Uint8Array(64 * 1024))
								},
							}),
							{ status: 404 },
						),
					),
			})
			expect(result.errorMessage).toContain("did not answer like a Checkfu API")
			expect(files[CONFIG_FILE]).toBeUndefined()
		}),
	)

	it.live("logout reports a credential file it could not remove", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const result = yield* cli.run(["logout"], {
				env: { CHECKFU_CONFIG_DIR: "/config" },
				files: { [CONFIG_FILE]: Stream.empty },
			})
			expect(result.exitCode).toBe(1)
			expect(result.errorMessage).toContain(`Could not remove ${CONFIG_FILE}`)

			const nothing = yield* cli.run(["logout"], { env: { CHECKFU_CONFIG_DIR: "/config" } })
			expect(nothing.exitCode).toBe(0)
			expect(nothing.stderr).toContain("No saved deployment")
		}),
	)

	it.live("refuses a relative config directory", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({ "config/config.json": saved() })
			const read = yield* cli.run(["environments", "create", "--name", "x"], {
				env: { CHECKFU_CONFIG_DIR: "config", CHECKFU_API_KEY: TEST_API_KEY },
				files,
			})
			expect(read.errorMessage).toContain("CHECKFU_CONFIG_DIR must be an absolute path")

			const ignored = yield* cli.run(["environments", "create", "--name", "x"], {
				env: { XDG_CONFIG_HOME: ".", HOME: "relative-home" },
				files: {
					"checkfu/config.json": saved(),
					"relative-home/.config/checkfu/config.json": saved(),
				},
			})
			expect(ignored.errorMessage).toContain("Missing CHECKFU_API_KEY")
		}),
	)

	it.live("login verifies the key before saving and logout removes it", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles()

			const rejected = yield* cli.run(["--base-url", DEPLOYED_URL, "login"], {
				env: { CHECKFU_CONFIG_DIR: "/config", CHECKFU_API_KEY: "wrong" },
				files,
			})
			expect(rejected.errorMessage).toContain("rejected the API key")
			expect(files[CONFIG_FILE]).toBeUndefined()

			const accepted = yield* cli.run(["--base-url", DEPLOYED_URL, "login"], {
				env: { CHECKFU_CONFIG_DIR: "/config", CHECKFU_API_KEY: TEST_API_KEY },
				files,
			})
			expect(accepted.errorMessage).toBeUndefined()
			expect(JSON.parse(files[CONFIG_FILE] ?? "")).toEqual({
				url: DEPLOYED_URL,
				api_key: TEST_API_KEY,
			})

			yield* cli.run(["logout"], { env: { CHECKFU_CONFIG_DIR: "/config" }, files })
			expect(files[CONFIG_FILE]).toBeUndefined()
		}),
	)
})
