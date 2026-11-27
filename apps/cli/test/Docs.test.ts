import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as CliOutput from "effect/cli/CliOutput"
import * as Command from "effect/cli/Command"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import { CLI_VERSION, CheckfuCli } from "../src/Cli.ts"

const cliDir = fileURLToPath(new URL("..", import.meta.url))
const repoRoot = resolve(cliDir, "../..")

const CLI_DOC_FILES = [resolve(cliDir, "README.md"), resolve(repoRoot, "README.md")] as const

interface DocumentedInvocation {
	readonly source: string
	readonly line: string
	readonly commandPath: ReadonlyArray<string>
	readonly flags: ReadonlyArray<string>
}

const SHARED_VALUE_FLAGS = new Set(["--base-url", "--format", "--transform"])
const SHARED_BOOLEAN_FLAGS = new Set(["--raw-output", "-r", "--help", "-h", "--version"])

const extractShellBlocks = (markdown: string): ReadonlyArray<string> => {
	const blocks: Array<string> = []
	const pattern = /```(?:sh|bash)\n([\s\S]*?)```/gu
	for (const match of markdown.matchAll(pattern)) {
		if (match[1] !== undefined) {
			blocks.push(match[1])
		}
	}
	return blocks
}

const parseCheckfuInvocation = (source: string, rawLine: string): DocumentedInvocation | null => {
	const trimmed = rawLine.trim()
	if (trimmed.length === 0 || trimmed.startsWith("#")) {
		return null
	}
	const tokens = trimmed.split(/\s+/u)
	const start =
		tokens[0] === "checkfu" ? 1 : tokens[0] === "bun" && tokens[1] === "checkfu" ? 2 : -1
	if (start === -1) {
		return null
	}

	const commandPath: Array<string> = []
	const flags: Array<string> = []
	let seenCommand = false

	for (let i = start; i < tokens.length; i++) {
		const token = tokens[i]!
		if (token === "|" || token === "&&" || token === ";") {
			break
		}
		if (token.startsWith("--")) {
			const [flagName] = token.split("=", 1)
			if (flagName !== undefined) {
				flags.push(flagName)
			}
			if (
				!token.includes("=") &&
				!SHARED_BOOLEAN_FLAGS.has(flagName ?? "") &&
				flagName !== "--dry-run" &&
				flagName !== "--yes" &&
				flagName !== "--force"
			) {
				i += 1
			}
			continue
		}
		if (token.startsWith("-")) {
			flags.push(token)
			continue
		}
		if (!seenCommand) {
			commandPath.push(token)
			seenCommand = true
			continue
		}
		// Subcommand verbs are lowercase kebab-case words before positional args/paths/placeholders.
		if (
			commandPath.length < 3 &&
			/^[a-z][a-z0-9-]*$/u.test(token) &&
			!token.includes(".") &&
			!token.includes("/") &&
			token !== "default"
		) {
			commandPath.push(token)
		} else {
			break
		}
	}

	return { source, line: trimmed, commandPath, flags }
}

const renderHelp = (args: ReadonlyArray<string>): Effect.Effect<string> =>
	Effect.gen(function* () {
		const output: Array<string> = []
		const formatter = CliOutput.defaultFormatter({ colors: false })
		const presenter = Layer.succeed(CliOutput.Presenter, {
			present: (event) =>
				Effect.sync(() => {
					if (event._tag === "Help") {
						output.push(formatter.formatHelpDoc(event.helpDoc))
					} else if (event._tag === "InvalidInvocation") {
						output.push(`INVALID: ${formatter.formatErrors(event.errors)}`)
					}
				}),
		})
		const layer = Layer.mergeAll(
			NodeServices.layer,
			FetchHttpClient.layer,
			SecureRandom.layerWebCrypto,
			presenter,
		)
		yield* Command.runWith(CheckfuCli, { version: CLI_VERSION })([...args, "--help"]).pipe(
			Effect.ignore,
			Effect.provide(layer),
		)
		return output.join("\n")
	})

describe("CLI documentation parity", () => {
	it.effect("every checkfu command and flag documented in README files matches CheckfuCli", () =>
		Effect.gen(function* () {
			const rootHelp = yield* renderHelp([])
			expect(rootHelp).not.toContain("INVALID:")
			for (const sharedFlag of [...SHARED_VALUE_FLAGS, "--raw-output"]) {
				expect(rootHelp).toContain(sharedFlag)
			}

			const invocations: Array<DocumentedInvocation> = []
			for (const file of CLI_DOC_FILES) {
				const markdown = readFileSync(file, "utf8")
				for (const block of extractShellBlocks(markdown)) {
					for (const line of block.split("\n")) {
						const parsed = parseCheckfuInvocation(file, line)
						if (parsed !== null) {
							invocations.push(parsed)
						}
					}
				}
			}

			expect(invocations.length).toBeGreaterThan(8)

			const helpCache = new Map<string, string>()
			for (const invocation of invocations) {
				const key = invocation.commandPath.join(" ")
				let help = helpCache.get(key)
				if (help === undefined) {
					help = yield* renderHelp(invocation.commandPath)
					helpCache.set(key, help)
				}
				expect(
					help,
					`documented command "${invocation.line}" (${invocation.source})`,
				).not.toContain("INVALID:")
				expect(help.length, `help output for "${invocation.line}"`).toBeGreaterThan(0)
				for (const flag of invocation.flags) {
					if (flag === "--help" || flag === "-h" || flag === "--version") {
						continue
					}
					const documentedInHelp = help.includes(flag) || rootHelp.includes(flag)
					expect(
						documentedInHelp,
						`flag ${flag} in "${invocation.line}" (${invocation.source}) must exist in CLI help`,
					).toBe(true)
				}
			}
		}),
	)
})
