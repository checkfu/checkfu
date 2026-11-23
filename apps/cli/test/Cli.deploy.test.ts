import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { providerForKey, readDotEnvValue, setDotEnvValue } from "../src/Commands/Deploy.ts"
import { COMMAND, invocation } from "../src/Invocation.ts"
import { TEST_API_KEY, makeTestServer } from "./helpers/CliHarness.ts"

const DEPLOYED_URL = "https://checkfu.example.workers.dev"
const CONFIG_FILE = "/config/config.json"
const ENV_FILE = "/checkout/.env"
const RECORD_FILE = "/checkout/.checkfu/deployment.json"
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

// What Alchemy really prints on stdout ahead of a result when it takes credentials
// from the environment (captured from alchemy 2.0.0-beta.87).
const ALCHEMY_NOISE =
	"[12:22:22.304] INFO: Cloudflare: using environment variables (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN).\n"

const fakeAlchemy = (
	calls: Array<ReadonlyArray<string>>,
	options: {
		/** The account Alchemy resolves; `null` is a profile with no Cloudflare connection. */
		readonly account?: string | null
		/** The account that becomes connected once the sign-in has run. */
		readonly accountAfterSignIn?: string
		readonly accountError?: string
		readonly output?: "missing" | "error" | "silent"
		readonly url?: string
		/** The MCP Worker's URL, for a stack that deploys one. */
		readonly mcp?: string
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
			expect(files[RECORD_FILE]).toBe(record("live"))
			expect(JSON.parse(files[CONFIG_FILE] ?? "")).toEqual({
				url: DEPLOYED_URL,
				api_key: TEST_API_KEY,
			})
			expect(result.stderr).toContain(`Checkfu is live at ${DEPLOYED_URL}`)
			// The next steps are the plain resource commands, with a model the deployed key can run.
			expect(result.stderr).toContain(
				`${COMMAND} agents create --name Assistant --model claude-sonnet-5-5`,
			)
			expect(result.stderr).toContain(`${COMMAND} sessions connect <session-id>`)
			expect(result.stderr).not.toContain("--base-url")
			expect(result.stderr).not.toContain(TEST_API_KEY)
			expect(result.stderr).not.toContain("MCP")

			const withMcp = yield* cli.run(["deploy"], {
				env: { CHECKFU_CONFIG_DIR: "/config", ANTHROPIC_API_KEY: "sk-ant-from-env" },
				files,
				spawn: fakeAlchemy([], { mcp: "https://checkfu-mcp.example.workers.dev/" }),
			})
			expect(withMcp.errorMessage).toBeUndefined()
			expect(withMcp.stderr).toContain("  MCP        https://checkfu-mcp.example.workers.dev/mcp\n")
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
			// The in-memory API only accepts TEST_API_KEY, so the freshly generated key is rejected.
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
					message: "ANTHROPIC_API_KEY or OPENAI_API_KEY",
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
			expect(files[RECORD_FILE]).toBe(record("live", "work"))

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
			// No .env yet, so the check runs without one; the deploy gets the file that
			// preparing the secrets created, under the same profile.
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

	it.live("records the deployment only once Alchemy has deployed it", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles(checkout)
			const declined = { env: deployEnv, files, spawn: fakeAlchemy([], { deployExitCode: 3 }) }

			const first = yield* cli.run(["deploy", "--stage", "staging"], declined)
			expect(first.exitCode).toBe(3)
			expect(files[RECORD_FILE]).toBeUndefined()
			expect(files[CONFIG_FILE]).toBeUndefined()

			yield* cli.run(["deploy", "--yes"], { env: deployEnv, files, spawn: fakeAlchemy([]) })
			expect(files[RECORD_FILE]).toBe(record("live"))

			yield* cli.run(["deploy", "--stage", "staging"], declined)
			expect(files[RECORD_FILE]).toBe(record("live"))

			const next: Array<ReadonlyArray<string>> = []
			yield* cli.run(["deploy", "--yes"], { env: deployEnv, files, spawn: fakeAlchemy(next) })
			expect(next[1]).toEqual(["deploy", "--stage", "live", "--yes", ...SHARED])
		}),
	)

	it.live("refuses to deploy a recorded stage into a different account, named or not", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const saved = JSON.stringify({ url: DEPLOYED_URL, api_key: TEST_API_KEY })
			const files = virtualFiles({
				...checkout,
				[RECORD_FILE]: record("live"),
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
				expect(files[RECORD_FILE]).toBe(record("live"))
				expect(files[CONFIG_FILE]).toBe(saved)
				// Refused before any secret was written, so "nothing was changed" is true.
				expect(files[ENV_FILE]).toBeUndefined()
			}

			// A stage this checkout has not deployed is a new deployment, wherever it goes.
			const other = yield* cli.run(["deploy", "--yes", "--stage", "staging"], {
				env: deployEnv,
				files,
				spawn: fakeAlchemy([], elsewhere),
			})
			expect(other.errorMessage).toBeUndefined()
			expect(files[RECORD_FILE]).toBe(record("staging", "default", OTHER_ACCOUNT, elsewhere.url))
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
				// The stage is deployed, so it is recorded; only its URL is still unknown.
				expect(files[RECORD_FILE]).toBe(record("live", "default", ACCOUNT, null))
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
				[RECORD_FILE]: record("live"),
				[CONFIG_FILE]: saved,
			})
			yield* cli.run(["deploy", "--yes"], {
				env: deployEnv,
				files,
				spawn: fakeAlchemy([], { output: "error" }),
			})
			expect(files[RECORD_FILE]).toBe(record("live"))

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
					env: { CHECKFU_CONFIG_DIR: "/config", CHECKFU_URL: "https://another.example" },
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
			expect(files[RECORD_FILE]).toBe(record("live"))
			expect(files[CONFIG_FILE]).toBeUndefined()
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
	const liveCheckout = { "/checkout/alchemy.run.ts": "", [RECORD_FILE]: record("live") }
	const env = { CHECKFU_CONFIG_DIR: "/config" }
	const PROFILE = ["--profile", "default"]

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
			expect(files[RECORD_FILE]).toBeUndefined()
		}),
	)

	it.live("never chooses a stage itself and never deletes one this checkout did not record", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			for (const [args, files, message] of [
				[["destroy", "--yes"], liveCheckout, 'This checkout last deployed "live"'],
				[["destroy", "--yes"], { "/checkout/alchemy.run.ts": "" }, "Name the stage to delete"],
				[["destroy", "--yes", "--stage", "staging"], liveCheckout, 'it last deployed "live"'],
				[
					["destroy", "--yes", "--stage", "live"],
					{ "/checkout/alchemy.run.ts": "" },
					"bun run destroy --stage live",
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

	it.live("follows the last successful deploy even when that deploy's URL was never read", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({ ...liveCheckout, [CONFIG_FILE]: savedLive })
			yield* cli.run(["deploy", "--yes", "--stage", "staging"], {
				env: deployEnv,
				files,
				spawn: fakeAlchemy([], { output: "error" }),
			})
			expect(files[RECORD_FILE]).toBe(record("staging", "default", ACCOUNT, null))

			const old: Array<ReadonlyArray<string>> = []
			const refused = yield* cli.run(["destroy", "--yes", "--stage", "live"], {
				env: deployEnv,
				files,
				spawn: fakeAlchemy(old),
			})
			expect(refused.errorMessage).toContain('it last deployed "staging"')
			expect(old).toEqual([])

			const calls: Array<ReadonlyArray<string>> = []
			const result = yield* cli.run(["destroy", "--yes", "--stage", "staging"], {
				env: deployEnv,
				files,
				spawn: fakeAlchemy(calls),
			})
			expect(result.errorMessage).toBeUndefined()
			expect(calls.at(-1)).toEqual(["destroy", "--stage", "staging", "--yes", ...SHARED])
			expect(files[RECORD_FILE]).toBeUndefined()
			// The saved login still belongs to the untouched "live" deployment.
			expect(files[CONFIG_FILE]).toBe(savedLive)
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
			expect(files[RECORD_FILE]).toBe(record("staging", "work"))

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
				expect(files[RECORD_FILE]).toBe(record("live"))
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
			// A host that serves Checkfu under /team/v1, so its API lives at /team/v1/v1/...
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
