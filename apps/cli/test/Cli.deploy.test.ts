import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { providerForKey, readDotEnvValue, setDotEnvValue } from "../src/Commands/Deploy.ts"
import { ChatDefaults } from "../src/SavedConnection.ts"
import { TEST_API_KEY, makeTestServer } from "./helpers/CliHarness.ts"

const DEPLOYED_URL = "https://checkfu.example.workers.dev"
const CONFIG_FILE = "/config/config.json"
const CHAT_FILE = "/config/chat.json"
const ENV_FILE = "/checkout/.env"
const RECORD_FILE = "/checkout/.checkfu/deployment.json"
const record = (stage: string, profile = "default", url = DEPLOYED_URL) =>
	`${JSON.stringify({ stage, profile, url }, null, "\t")}\n`

interface VirtualFiles {
	[path: string]: string
}

const virtualFiles = (initial: VirtualFiles = {}): VirtualFiles => ({ ...initial })

const deployEnv = {
	CHECKFU_CONFIG_DIR: "/config",
	CLOUDFLARE_API_TOKEN: "cf-token",
	CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
}

const SHARED = ["--env-file", ENV_FILE, "--profile", "default"]

const fakeAlchemy = (
	calls: Array<ReadonlyArray<string>>,
	options: {
		readonly deployExitCode?: number
		readonly url?: string
		readonly checkEnvExitCode?: number
		readonly onSignIn?: () => void
	} = {},
) => {
	return (args: ReadonlyArray<string>) => {
		const command = args.slice(1)
		calls.push(command)
		switch (command[0]) {
			case "state":
				return { exitCode: 0, stdout: JSON.stringify({ api: options.url ?? DEPLOYED_URL }) }
			case "provider":
				return { exitCode: options.checkEnvExitCode ?? 1 }
			case "profile":
				options.onSignIn?.()
				return { exitCode: 0 }
			default:
				return { exitCode: options.deployExitCode ?? 0 }
		}
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

describe("checkfu deploy", () => {
	it.live("generates the API key, deploys, verifies, and saves the connection", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const calls: Array<ReadonlyArray<string>> = []
			const files = virtualFiles({
				"/checkout/alchemy.run.ts": "",
				[ENV_FILE]: `CHECKFU_API_KEY=${TEST_API_KEY}\nOPENAI_API_KEY=\nANTHROPIC_API_KEY=\n`,
			})

			const result = yield* cli.run(["deploy"], {
				env: { ...deployEnv, ANTHROPIC_API_KEY: "sk-ant-from-env" },
				files,
				spawn: fakeAlchemy(calls),
			})

			expect(result.errorMessage).toBeUndefined()
			expect(calls).toEqual([
				["deploy", "--stage", "live", ...SHARED],
				["state", "read", "Checkfu/live/output", "--no-input", ...SHARED],
			])
			expect(files[ENV_FILE]).toBe(
				`CHECKFU_API_KEY=${TEST_API_KEY}\nOPENAI_API_KEY=\nANTHROPIC_API_KEY=sk-ant-from-env\n`,
			)
			expect(files[RECORD_FILE]).toBe(record("live"))
			expect(JSON.parse(files[CONFIG_FILE] ?? "")).toEqual({
				url: DEPLOYED_URL,
				api_key: TEST_API_KEY,
				model: "claude-sonnet-5-5",
			})
			expect(result.stderr).toContain(`Checkfu is live at ${DEPLOYED_URL}`)
			expect(result.stderr).toContain("bun checkfu chat")
			expect(result.stderr).not.toContain(TEST_API_KEY)
		}),
	)

	it.live("writes a generated API key into .env when none is set", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({ "/checkout/alchemy.run.ts": "" })

			const result = yield* cli.run(["deploy", "--yes", "--stage", "staging"], {
				env: { ...deployEnv, OPENAI_API_KEY: "sk-proj-from-env" },
				files,
				stdinIsTerminal: true,
				cloudflareProfiles: ["default"],
				spawn: fakeAlchemy([]),
			})

			expect(files[ENV_FILE]).toMatch(
				/^CHECKFU_API_KEY=ck_[0-9a-f]{64}\nOPENAI_API_KEY=sk-proj-from-env\n$/,
			)
			// The in-memory API only accepts TEST_API_KEY, so the freshly generated key is rejected.
			expect(result.errorMessage).toContain("rejected the API key")
			expect(files[CONFIG_FILE]).toBeUndefined()
		}),
	)

	it.live("keeps an exported API key instead of rotating it on a clean checkout", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({ "/checkout/alchemy.run.ts": "" })

			const result = yield* cli.run(["deploy", "--yes"], {
				env: { ...deployEnv, CHECKFU_API_KEY: TEST_API_KEY, OPENAI_API_KEY: "sk-proj-from-env" },
				files,
				spawn: fakeAlchemy([]),
			})

			expect(result.errorMessage).toBeUndefined()
			expect(files[ENV_FILE]).toBe(
				`CHECKFU_API_KEY=${TEST_API_KEY}\nOPENAI_API_KEY=sk-proj-from-env\n`,
			)
			expect(JSON.parse(files[CONFIG_FILE] ?? "").api_key).toBe(TEST_API_KEY)
		}),
	)

	it.live("leaves an unreadable .env untouched and does not deploy", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const calls: Array<ReadonlyArray<string>> = []
			const result = yield* cli.run(["deploy"], {
				env: { ...deployEnv, OPENAI_API_KEY: "sk-proj-from-env" },
				files: { "/checkout/alchemy.run.ts": "", [ENV_FILE]: Stream.empty },
				spawn: fakeAlchemy(calls),
			})
			expect(result.exitCode).toBe(1)
			expect(result.errorMessage).toContain(`Could not read ${ENV_FILE}`)
			expect(calls).toEqual([])
		}),
	)

	it.live("leaves the credential decision to Alchemy when no terminal is attached", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const calls: Array<ReadonlyArray<string>> = []
			const result = yield* cli.run(["deploy", "--yes"], {
				env: {
					CHECKFU_CONFIG_DIR: "/config",
					CHECKFU_API_KEY: TEST_API_KEY,
					OPENAI_API_KEY: "sk-proj-x",
					CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
					CLOUDFLARE_API_KEY: "global-key",
					CLOUDFLARE_EMAIL: "ops@example.com",
				},
				files: { "/checkout/alchemy.run.ts": "" },
				spawn: fakeAlchemy(calls),
			})
			expect(result.errorMessage).toBeUndefined()
			expect(calls.map((call) => call[0])).toEqual(["deploy", "state"])
		}),
	)

	const terminalDeploy = {
		env: { CHECKFU_CONFIG_DIR: "/config", CHECKFU_API_KEY: TEST_API_KEY, OPENAI_API_KEY: "sk-x" },
		stdinIsTerminal: true,
	}

	it.live("skips the sign-in when Alchemy accepts the environment credentials", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const calls: Array<ReadonlyArray<string>> = []
			const result = yield* cli.run(["deploy"], {
				...terminalDeploy,
				files: { "/checkout/alchemy.run.ts": "" },
				spawn: fakeAlchemy(calls, { checkEnvExitCode: 0 }),
			})
			expect(result.errorMessage).toBeUndefined()
			expect(calls.slice(0, 2)).toEqual([
				["provider", "check-env", "--provider", "Cloudflare", ...SHARED],
				["deploy", "--stage", "live", ...SHARED],
			])
		}),
	)

	it.live("checks, signs in to, and deploys with the profile the checkout selects", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const work = ["--env-file", ENV_FILE, "--profile", "work"]
			const dotenv = `CHECKFU_API_KEY=${TEST_API_KEY}\nOPENAI_API_KEY=sk-x\nALCHEMY_PROFILE=work\n`

			const connected: Array<ReadonlyArray<string>> = []
			yield* cli.run(["deploy"], {
				env: { CHECKFU_CONFIG_DIR: "/config", ALCHEMY_PROFILE: "shell" },
				stdinIsTerminal: true,
				cloudflareProfiles: ["work"],
				files: { "/checkout/alchemy.run.ts": "", [ENV_FILE]: dotenv },
				spawn: fakeAlchemy(connected),
			})
			expect(connected[0]).toEqual(["deploy", "--stage", "live", ...work])

			const profiles: Array<string> = ["shell"]
			const signedIn: Array<ReadonlyArray<string>> = []
			const result = yield* cli.run(["deploy"], {
				env: { CHECKFU_CONFIG_DIR: "/config", ALCHEMY_PROFILE: "shell" },
				stdinIsTerminal: true,
				cloudflareProfiles: profiles,
				files: { "/checkout/alchemy.run.ts": "", [ENV_FILE]: dotenv },
				spawn: fakeAlchemy(signedIn, { onSignIn: () => profiles.push("work") }),
			})
			expect(result.errorMessage).toBeUndefined()
			expect(signedIn.slice(0, 3)).toEqual([
				["provider", "check-env", "--provider", "Cloudflare", ...work],
				["profile", "edit", "--add", "Cloudflare", ...work],
				["deploy", "--stage", "live", ...work],
			])
		}),
	)

	it.live("stops when the sign-in is cancelled", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const calls: Array<ReadonlyArray<string>> = []
			const result = yield* cli.run(["deploy"], {
				...terminalDeploy,
				files: { "/checkout/alchemy.run.ts": "" },
				spawn: fakeAlchemy(calls),
			})
			expect(result.exitCode).toBe(1)
			expect(result.errorMessage).toContain("sign-in did not finish")
			expect(calls.map((call) => call[0])).toEqual(["provider", "profile"])
		}),
	)

	it.live("saves nothing when the deploy fails", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({
				"/checkout/alchemy.run.ts": "",
				[ENV_FILE]: `CHECKFU_API_KEY=${TEST_API_KEY}\nOPENAI_API_KEY=sk-proj-x\n`,
			})

			const result = yield* cli.run(["deploy"], {
				env: deployEnv,
				files,
				spawn: fakeAlchemy([], { deployExitCode: 3 }),
			})

			expect(result.exitCode).toBe(3)
			expect(files[CONFIG_FILE]).toBeUndefined()
		}),
	)

	it.live("asks for a provider key only when a terminal is attached", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const result = yield* cli.run(["deploy"], {
				env: { ...deployEnv, CHECKFU_API_KEY: TEST_API_KEY },
				files: { "/checkout/alchemy.run.ts": "" },
				spawn: fakeAlchemy([]),
			})
			expect(result.exitCode).toBe(1)
			expect(result.errorMessage).toContain("ANTHROPIC_API_KEY or OPENAI_API_KEY")
		}),
	)

	it.live("refuses to invent an API key without a terminal", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const calls: Array<ReadonlyArray<string>> = []
			const files = virtualFiles({ "/checkout/alchemy.run.ts": "" })
			const result = yield* cli.run(["deploy", "--yes"], {
				env: { ...deployEnv, OPENAI_API_KEY: "sk-proj-from-env" },
				files,
				spawn: fakeAlchemy(calls),
			})
			expect(result.exitCode).toBe(1)
			expect(result.errorMessage).toContain("export a persistent CHECKFU_API_KEY")
			expect(calls).toEqual([])
			expect(files[ENV_FILE]).toBeUndefined()
		}),
	)

	it.live("deploys the exact exported key even when it needs quoting", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({ "/checkout/alchemy.run.ts": "" })
			yield* cli.run(["deploy", "--yes"], {
				env: { ...deployEnv, CHECKFU_API_KEY: "key#with$&", OPENAI_API_KEY: "sk-proj-x" },
				files,
				spawn: fakeAlchemy([]),
			})
			expect(yield* readDotEnvValue(files[ENV_FILE] ?? "", "CHECKFU_API_KEY")).toBe("key#with$&")
		}),
	)

	it.live("refuses a padded key in .env rather than verifying a different value", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const calls: Array<ReadonlyArray<string>> = []
			const dotenv = `CHECKFU_API_KEY="${TEST_API_KEY} "\nOPENAI_API_KEY=sk-proj-x\n`
			const files = virtualFiles({ "/checkout/alchemy.run.ts": "", [ENV_FILE]: dotenv })
			const result = yield* cli.run(["deploy", "--yes"], {
				env: deployEnv,
				files,
				spawn: fakeAlchemy(calls),
			})
			expect(result.exitCode).toBe(1)
			expect(result.errorMessage).toContain(
				"CHECKFU_API_KEY in .env has leading or trailing whitespace",
			)
			expect(calls).toEqual([])
			expect(files[ENV_FILE]).toBe(dotenv)
		}),
	)

	it.live("records the stage only once Alchemy has deployed it", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const env = { ...deployEnv, CHECKFU_API_KEY: TEST_API_KEY, OPENAI_API_KEY: "sk-proj-x" }
			const files = virtualFiles({ "/checkout/alchemy.run.ts": "" })

			yield* cli.run(["deploy", "--stage", "staging"], {
				env,
				files,
				spawn: fakeAlchemy([], { deployExitCode: 1 }),
			})
			expect(files[RECORD_FILE]).toBeUndefined()

			yield* cli.run(["deploy", "--yes"], { env, files, spawn: fakeAlchemy([]) })
			expect(files[RECORD_FILE]).toBe(record("live"))

			yield* cli.run(["deploy", "--stage", "staging"], {
				env,
				files,
				spawn: fakeAlchemy([], { deployExitCode: 1 }),
			})
			expect(files[RECORD_FILE]).toBe(record("live"))

			const next: Array<ReadonlyArray<string>> = []
			yield* cli.run(["deploy", "--yes"], { env, files, spawn: fakeAlchemy(next) })
			expect(next.slice(0, 2)).toEqual([
				["state", "read", "Checkfu/live/output", "--no-input", ...SHARED],
				["deploy", "--stage", "live", "--yes", ...SHARED],
			])
		}),
	)

	it.live("refuses an implicit upgrade when the account in use holds a different deployment", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const env = { ...deployEnv, CHECKFU_API_KEY: TEST_API_KEY, OPENAI_API_KEY: "sk-proj-x" }
			const saved = JSON.stringify({ url: DEPLOYED_URL, api_key: TEST_API_KEY })
			const elsewhere = { url: "https://checkfu.other-account.workers.dev" }
			const files = virtualFiles({
				"/checkout/alchemy.run.ts": "",
				[RECORD_FILE]: record("live"),
				[CONFIG_FILE]: saved,
			})

			const calls: Array<ReadonlyArray<string>> = []
			const result = yield* cli.run(["deploy", "--yes"], {
				env,
				files,
				spawn: fakeAlchemy(calls, elsewhere),
			})
			expect(result.exitCode).toBe(1)
			expect(result.errorMessage).toContain("Nothing was deployed")
			expect(calls.map((call) => call[0])).toEqual(["state"])
			expect(files[RECORD_FILE]).toBe(record("live"))
			expect(files[CONFIG_FILE]).toBe(saved)

			const explicit: Array<ReadonlyArray<string>> = []
			const onPurpose = yield* cli.run(["deploy", "--yes", "--stage", "live"], {
				env,
				files,
				spawn: fakeAlchemy(explicit, elsewhere),
			})
			expect(onPurpose.errorMessage).toBeUndefined()
			expect(explicit[0]?.[0]).toBe("deploy")
			expect(files[RECORD_FILE]).toBe(record("live", "default", elsewhere.url))
		}),
	)

	it.live("stops when the shell exports a different API key than the one being deployed", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const calls: Array<ReadonlyArray<string>> = []
			const result = yield* cli.run(["deploy", "--yes"], {
				env: { ...deployEnv, CHECKFU_API_KEY: "shell-key" },
				files: {
					"/checkout/alchemy.run.ts": "",
					[ENV_FILE]: `CHECKFU_API_KEY=${TEST_API_KEY}\nOPENAI_API_KEY=sk-proj-x\n`,
				},
				spawn: fakeAlchemy(calls),
			})
			expect(result.exitCode).toBe(1)
			expect(result.errorMessage).toContain("differs from the one in .env")
			expect(result.errorMessage).not.toContain("shell-key")
			expect(result.errorMessage).not.toContain(TEST_API_KEY)
			expect(calls).toEqual([])
		}),
	)

	it.live("gives up on a deployment that accepts connections but never answers", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({ "/checkout/alchemy.run.ts": "" })
			const result = yield* cli.run(["deploy", "--yes"], {
				env: { ...deployEnv, CHECKFU_API_KEY: TEST_API_KEY, OPENAI_API_KEY: "sk-proj-x" },
				files,
				spawn: fakeAlchemy([]),
				interceptFetch: () => Promise.withResolvers<Response>().promise,
			})
			expect(result.exitCode).toBe(1)
			expect(result.errorMessage).toContain("did not start answering within")
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
	const PROFILE = ["--profile", "default"]

	it.live("forgets the record and the saved connection of the deployment it destroyed", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({ ...liveCheckout, [CONFIG_FILE]: savedLive })
			const calls: Array<ReadonlyArray<string>> = []
			const result = yield* cli.run(["destroy", "--yes"], {
				env: deployEnv,
				files,
				spawn: fakeAlchemy(calls),
			})
			expect(result.errorMessage).toBeUndefined()
			expect(calls).toEqual([
				["state", "read", "Checkfu/live/output", "--no-input", ...PROFILE],
				["destroy", "--stage", "live", "--yes", ...PROFILE],
			])
			expect(files[CONFIG_FILE]).toBeUndefined()
			expect(files[RECORD_FILE]).toBeUndefined()
		}),
	)

	it.live("targets what this checkout deployed whatever the login or shell profile is now", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({ "/checkout/alchemy.run.ts": "" })
			const env = { ...deployEnv, CHECKFU_API_KEY: TEST_API_KEY, OPENAI_API_KEY: "sk-proj-x" }
			const work = ["--env-file", ENV_FILE, "--profile", "work"]
			yield* cli.run(["deploy", "--yes", "--stage", "staging"], {
				env: { ...env, ALCHEMY_PROFILE: "work" },
				files,
				spawn: fakeAlchemy([]),
			})
			expect(files[RECORD_FILE]).toBe(record("staging", "work"))

			yield* cli.run(["--base-url", "https://another.example", "login"], { env, files })
			yield* cli.run(["logout"], { env, files })

			const calls: Array<ReadonlyArray<string>> = []
			yield* cli.run(["destroy", "--yes"], { env, files, spawn: fakeAlchemy(calls) })
			expect(calls).toEqual([
				["state", "read", "Checkfu/staging/output", "--no-input", ...work],
				["destroy", "--stage", "staging", "--yes", ...work],
			])
		}),
	)

	it.live("refuses an implicit destroy when the account in use holds a different deployment", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({ ...liveCheckout, [CONFIG_FILE]: savedLive })
			const calls: Array<ReadonlyArray<string>> = []
			const result = yield* cli.run(["destroy", "--yes"], {
				env: deployEnv,
				files,
				spawn: fakeAlchemy(calls, { url: "https://checkfu.other-account.workers.dev" }),
			})
			expect(result.exitCode).toBe(1)
			expect(result.errorMessage).toContain("Nothing was deleted")
			expect(calls.map((call) => call[0])).toEqual(["state"])
			expect(files[RECORD_FILE]).toBe(record("live"))
			expect(files[CONFIG_FILE]).toBe(savedLive)

			const explicit: Array<ReadonlyArray<string>> = []
			const forced = yield* cli.run(["destroy", "--yes", "--stage", "live"], {
				env: deployEnv,
				files,
				spawn: fakeAlchemy(explicit, { url: "https://checkfu.other-account.workers.dev" }),
			})
			expect(forced.errorMessage).toBeUndefined()
			expect(explicit.at(-1)).toEqual(["destroy", "--stage", "live", "--yes", ...PROFILE])
			expect(files[RECORD_FILE]).toBe(record("live"))
			expect(files[CONFIG_FILE]).toBe(savedLive)
		}),
	)

	it.live("refuses to guess a stage when the checkout has no record of a deployment", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const calls: Array<ReadonlyArray<string>> = []
			const result = yield* cli.run(["destroy", "--yes"], {
				env: deployEnv,
				files: { "/checkout/alchemy.run.ts": "", [CONFIG_FILE]: savedLive },
				spawn: fakeAlchemy(calls),
			})
			expect(result.exitCode).toBe(1)
			expect(result.errorMessage).toContain("Pass --stage")
			expect(calls).toEqual([])
		}),
	)

	it.live("passes --env-file only when the checkout has a .env", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const withEnv: Array<ReadonlyArray<string>> = []
			yield* cli.run(["destroy", "--yes"], {
				env: deployEnv,
				files: { ...liveCheckout, [ENV_FILE]: "A=1\n" },
				spawn: fakeAlchemy(withEnv),
			})
			expect(withEnv).toEqual([
				["state", "read", "Checkfu/live/output", "--no-input", ...SHARED],
				["destroy", "--stage", "live", "--yes", ...SHARED],
			])
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

	it.live("login keeps the default model of the same deployment", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const metadata = { model: "claude-sonnet-5-5" }
			const files = virtualFiles({ [CONFIG_FILE]: saved({ ...metadata, api_key: "stale" }) })

			const result = yield* cli.run(["--base-url", `${DEPLOYED_URL}/v1/`, "login"], {
				env: { CHECKFU_CONFIG_DIR: "/config", CHECKFU_API_KEY: TEST_API_KEY },
				files,
			})

			expect(result.errorMessage).toBeUndefined()
			expect(JSON.parse(files[CONFIG_FILE] ?? "")).toEqual({
				url: DEPLOYED_URL,
				api_key: TEST_API_KEY,
				...metadata,
			})
		}),
	)

	it.live("login refuses to save when the URL does not answer like Checkfu", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const working = saved({ model: "gpt-6.2-sol" })
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

	it.live("login rejects a mistyped path prefix even though unknown routes answer 404", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const working = saved({ model: "gpt-6.2-sol" })
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

describe("checkfu chat", () => {
	const env = { CHECKFU_CONFIG_DIR: "/config" }
	const connection = (model?: string, url = DEPLOYED_URL) =>
		JSON.stringify({ url, api_key: TEST_API_KEY, ...(model ? { model } : {}) })
	const defaults = (files: VirtualFiles) =>
		Schema.decodeUnknownSync(Schema.fromJsonString(ChatDefaults))(files[CHAT_FILE])

	it.live("creates an agent, environment, and session, then reuses them", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({ [CONFIG_FILE]: connection("claude-sonnet-5-5") })

			const first = yield* cli.run(["chat"], { env, files, stdin: "Hello\n" })
			expect(first.errorMessage).toBeUndefined()
			expect(first.stdout).toContain("Echo: Hello")
			const remembered = defaults(files)
			expect(remembered).toMatchObject({ url: DEPLOYED_URL, model: "claude-sonnet-5-5" })
			expect(remembered.agents["claude-sonnet-5-5"]).toMatch(/^agent_/)
			expect(remembered.environment_id).toMatch(/^env_/)

			const second = yield* cli.run(["chat"], { env, files, stdin: "Again\n" })
			expect(second.stdout).toContain("Echo: Again")
			expect(defaults(files)).toEqual(remembered)
			expect(files[CONFIG_FILE]).toBe(connection("claude-sonnet-5-5"))
		}),
	)

	it.live("stays on the deployment it started with when the saved login changes mid-setup", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			for (const replacement of [undefined, connection("gpt-6.2-sol", "https://another.example")]) {
				const files = virtualFiles({ [CONFIG_FILE]: connection("gpt-6.2-sol") })
				const hosts = new Set<string>()
				const result = yield* cli.run(["chat"], {
					env,
					files,
					stdin: "Hello\n",
					interceptFetch: (next, request) => {
						hosts.add(new URL(request.url).origin)
						if (replacement === undefined) {
							delete files[CONFIG_FILE]
						} else {
							files[CONFIG_FILE] = replacement
						}
						return next(request)
					},
				})

				expect(result.errorMessage).toBeUndefined()
				expect(result.stdout).toContain("Echo: Hello")
				expect([...hosts]).toEqual([DEPLOYED_URL])
				expect(files[CONFIG_FILE]).toBe(replacement)
				expect(files[CHAT_FILE]).not.toContain(TEST_API_KEY)
			}
		}),
	)

	it.live("keeps one agent per model and never reuses one whose model differs", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({ [CONFIG_FILE]: connection("gpt-6.2-sol") })
			yield* cli.run(["chat"], { env, files, stdin: "Hello\n" })
			const gptAgent = defaults(files).agents["gpt-6.2-sol"]

			yield* cli.run(["chat", "--model", "claude-sonnet-5-5"], { env, files, stdin: "Hello\n" })
			const claudeAgent = defaults(files).agents["claude-sonnet-5-5"]
			expect(claudeAgent).not.toBe(gptAgent)
			expect(defaults(files).agents["gpt-6.2-sol"]).toBe(gptAgent)

			const plain = yield* cli.run(["chat"], { env, files, stdin: "Hello\n" })
			expect(plain.stderr).toContain(`agent ${gptAgent}@`)

			files[CONFIG_FILE] = connection("claude-sonnet-5-5")
			const switched = yield* cli.run(["chat"], { env, files, stdin: "Hello\n" })
			expect(switched.stderr).toContain(`agent ${claudeAgent}@`)

			files[CHAT_FILE] = JSON.stringify({
				...defaults(files),
				agents: { "claude-sonnet-5-5": gptAgent },
			})
			const mismatched = yield* cli.run(["chat"], { env, files, stdin: "Hello\n" })
			expect(mismatched.errorMessage).toBeUndefined()
			const replaced = defaults(files).agents["claude-sonnet-5-5"] ?? ""
			expect(replaced).not.toBe(gptAgent)
			const agent = yield* cli.run(["agents", "retrieve", "--agent-id", replaced], { env, files })
			expect(agent.stdout).toContain('"model":{"id":"claude-sonnet-5-5"}')
		}),
	)

	it.live("still chats when its defaults cannot be saved, and says how to resume", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const creates: Array<string> = []
			const result = yield* cli.run(
				["--base-url", DEPLOYED_URL, "chat", "--model", "gpt-6.2-sol"],
				{
					env: { CHECKFU_API_KEY: TEST_API_KEY },
					stdin: "Hello\n",
					interceptFetch: (next, request) => {
						if (request.method === "POST") {
							creates.push(new URL(request.url).pathname)
						}
						return next(request)
					},
				},
			)
			expect(result.errorMessage).toBeUndefined()
			expect(result.stdout).toContain("Echo: Hello")
			expect(result.stderr).toContain("This agent will not be reused next time")
			expect(creates.slice(0, 3)).toEqual(["/v1/agents", "/v1/environments", "/v1/sessions"])
			expect(result.stderr).toMatch(
				new RegExp(`checkfu --base-url ${DEPLOYED_URL} sessions connect sess_`),
			)

			const unreadable = yield* cli.run(["chat"], {
				env: { CHECKFU_CONFIG_DIR: "/config" },
				files: { [CONFIG_FILE]: connection("gpt-6.2-sol"), [CHAT_FILE]: "{ not json" },
				stdin: "Hello\n",
			})
			expect(unreadable.errorMessage).toBeUndefined()
			expect(unreadable.stderr).toContain("Starting without remembered chat defaults")
			expect(unreadable.stderr).toMatch(/Resume later with: checkfu sessions connect sess_/)
		}),
	)

	it.live("defaults to the last model used when the deployment has no default", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({ [CONFIG_FILE]: connection() })

			const missing = yield* cli.run(["chat"], { env, files, stdin: "Hello\n" })
			expect(missing.errorMessage).toContain("--model")

			yield* cli.run(["chat", "--model", "gpt-6.2-sol"], { env, files, stdin: "Hello\n" })
			const plain = yield* cli.run(["chat"], { env, files, stdin: "Again\n" })
			expect(plain.errorMessage).toBeUndefined()
			expect(plain.stdout).toContain("Echo: Again")
		}),
	)

	it.live("reports a failed lookup instead of creating duplicate resources", () =>
		Effect.gen(function* () {
			const cli = yield* makeTestServer()
			const files = virtualFiles({ [CONFIG_FILE]: connection("gpt-6.2-sol") })
			yield* cli.run(["chat"], { env, files, stdin: "Hello\n" })
			const before = files[CHAT_FILE]

			const creates: Array<string> = []
			const result = yield* cli.run(["chat"], {
				env,
				files,
				stdin: "Hello\n",
				interceptFetch: (next, request) => {
					if (request.method === "GET" && new URL(request.url).pathname.startsWith("/v1/agents/")) {
						return Promise.resolve(errorEnvelope(429, "rate_limit_error"))
					}
					if (request.method === "POST") {
						creates.push(new URL(request.url).pathname)
					}
					return next(request)
				},
			})

			expect(result.exitCode).toBe(1)
			expect(result.errorMessage).toContain("429")
			expect(creates).toEqual([])
			expect(files[CHAT_FILE]).toBe(before)
		}),
	)
})
