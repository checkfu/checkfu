import { fileURLToPath, pathToFileURL } from "node:url"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import * as Prompt from "effect/cli/Prompt"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import { normalizeApiUrl, verifyApiKey } from "../Client.ts"
import { CliFailure, configError, networkFailure, usageError } from "../Errors.ts"
import {
	readSavedConnection,
	removeSavedConnection,
	writeSavedConnection,
} from "../SavedConnection.ts"
import { readIfPresent, removeIfPresent, writePrivate } from "../PrivateFile.ts"
import { isStandalone } from "../Standalone.ts"
import { writeStderrLine } from "../TerminalOutput.ts"

export const STACK_NAME = "Checkfu"
export const DEFAULT_STAGE = "live"
const API_KEY_ENV = "CHECKFU_API_KEY"

export const MODEL_PROVIDERS = [
	{ name: "Anthropic", env: "ANTHROPIC_API_KEY", model: "claude-sonnet-5-5" },
	{ name: "OpenAI", env: "OPENAI_API_KEY", model: "gpt-6.2-sol" },
] as const
type ModelProvider = (typeof MODEL_PROVIDERS)[number]

export const providerForKey = (key: string): ModelProvider =>
	key.startsWith("sk-ant-") ? MODEL_PROVIDERS[0] : MODEL_PROVIDERS[1]

const CLOUDFLARE = "Cloudflare"

export interface Checkout {
	readonly root: string
	/** The Bun that runs Alchemy, with any extra environment it needs to behave as Bun. */
	readonly runtime: string
	readonly runtimeEnv: Readonly<Record<string, string>>
	/** How long a fresh deployment gets to start answering before the deploy is reported as failed. */
	readonly readyWithin: Duration.Input
}

export const Checkout = Context.Reference<Checkout>("@checkfu/cli/Checkout", {
	defaultValue: () => ({
		root: isStandalone
			? fileURLToPath(new URL("../../../", pathToFileURL(process.execPath)))
			: fileURLToPath(new URL("../../../../", import.meta.url)),
		runtime: process.execPath,
		runtimeEnv: isStandalone ? { BUN_BE_BUN: "1" } : {},
		readyWithin: "90 seconds",
	}),
})

export const readDotEnvValue = (contents: string, name: string): Effect.Effect<string> =>
	Config.String(name)
		.parse(ConfigProvider.fromDotEnvContents(contents))
		.pipe(Effect.orElseSucceed(() => ""))

/**
 * The value exactly as Alchemy will read and deploy it. A quoted entry keeps its
 * padding, and the Worker compares credentials byte for byte, so padding is refused
 * here instead of being trimmed into a different value than the one deployed.
 */
const readDotEnvSecret = (contents: string, name: string) =>
	Effect.filterOrFail(
		readDotEnvValue(contents, name),
		(value) => value === value.trim(),
		() =>
			configError(`${name} in .env has leading or trailing whitespace. Remove it and run again.`),
	)

const quoteDotEnvValue = (value: string): string | undefined => {
	if (/^[\w.\-/:+=@%,]+$/.test(value)) {
		return value
	}
	if (/[\r\n]/.test(value)) {
		return undefined
	}
	const quote = ["'", "`", '"'].find((candidate) => !value.includes(candidate))
	return quote === undefined || (quote === '"' && value.includes("\\"))
		? undefined
		: `${quote}${value}${quote}`
}

export const setDotEnvValue = (
	contents: string,
	name: string,
	value: string,
): Effect.Effect<string, CliFailure> =>
	Effect.gen(function* () {
		const unstorable = configError(
			`${name} contains characters that cannot be stored in .env. Use a value without quotes or line breaks.`,
		)
		const quoted = quoteDotEnvValue(value)
		if (quoted === undefined) {
			return yield* unstorable
		}
		const line = `${name}=${quoted}`
		const existing = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, "m")
		const updated = existing.test(contents)
			? contents.replace(existing, () => line)
			: `${contents}${contents.length === 0 || contents.endsWith("\n") ? "" : "\n"}${line}\n`
		if ((yield* readDotEnvValue(updated, name)) !== value) {
			return yield* unstorable
		}
		return updated
	})

const stageFlag = Flag.String("stage").pipe(
	Flag.withMetavar("NAME"),
	Flag.withDescription(
		`Deployment stage (defaults to the one this checkout last deployed; a first deploy uses "${DEFAULT_STAGE}")`,
	),
	Flag.optional,
)

const yesFlag = Flag.Boolean("yes").pipe(
	Flag.withAlias("y"),
	Flag.withDefault(false),
	Flag.withDescription("Skip the confirmation prompt"),
)

/**
 * The deployment this checkout manages: written only after Alchemy reports a
 * successful deploy, and the sole source of the stage and profile that a bare
 * `deploy` or `destroy` assumes. It is deliberately not part of the saved login;
 * which API the CLI talks to and what this checkout manages change independently.
 */
const DeploymentRecord = Schema.fromJsonString(
	Schema.Struct({ stage: Schema.String, profile: Schema.String, url: Schema.String }),
	{ space: "\t" },
)
type DeploymentRecord = typeof DeploymentRecord.Type

const deploymentRecordPath = (checkout: Checkout) =>
	Effect.map(Path.Path, (path) => path.join(checkout.root, ".checkfu", "deployment.json"))

const readDeploymentRecord = (checkout: Checkout) =>
	Effect.gen(function* () {
		const file = yield* deploymentRecordPath(checkout)
		const contents = yield* readIfPresent(file)
		if (Option.isNone(contents)) {
			return Option.none()
		}
		return yield* Schema.decodeEffect(DeploymentRecord)(contents.value).pipe(
			Effect.mapBoth({
				onSuccess: Option.some,
				onFailure: () =>
					configError(`${file} is not valid. Fix or delete it, then pass --stage explicitly.`),
			}),
		)
	})

const requireCheckout = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const checkout = yield* Checkout
	const hasStack = yield* fs
		.exists(path.join(checkout.root, "alchemy.run.ts"))
		.pipe(Effect.orElseSucceed(() => false))
	if (!hasStack) {
		return yield* usageError(
			"This command deploys from a Checkfu source checkout. Clone https://github.com/checkfu/checkfu, run `bun install`, then `bun checkfu deploy`.",
		)
	}
	return checkout
})

/**
 * One Alchemy invocation context. Every command in a run gets the same checkout,
 * env file, and profile, so the sign-in, the deploy, and the state lookup can never
 * disagree about which account they act on.
 */
interface Target {
	readonly checkout: Checkout
	readonly shared: ReadonlyArray<string>
	readonly profile: string
}

const alchemy = (
	target: Target,
	args: ReadonlyArray<string>,
	output: "inherit" | "pipe" | "quiet",
) =>
	Effect.map(Path.Path, (path) =>
		ChildProcess.make(
			target.checkout.runtime,
			[
				path.join(target.checkout.root, "node_modules", "alchemy", "bin", "cli.js"),
				...args,
				...target.shared,
			],
			{
				cwd: target.checkout.root,
				env: target.checkout.runtimeEnv,
				extendEnv: true,
				stdin: output === "inherit" ? "inherit" : "ignore",
				stdout: output === "inherit" ? "inherit" : "pipe",
				stderr: output === "quiet" ? "ignore" : "inherit",
			},
		),
	)

const run = (target: Target, args: ReadonlyArray<string>, output: "inherit" | "quiet") =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		return yield* spawner
			.exitCode(yield* alchemy(target, args, output))
			.pipe(Effect.mapError((error) => configError(`Could not start Alchemy: ${error}`)))
	})

const envValue = (name: string): Effect.Effect<string> =>
	Config.option(Config.String(name)).pipe(
		Effect.map(Option.getOrElse(() => "")),
		Effect.map((value) => value.trim()),
		Effect.orElseSucceed(() => ""),
	)

const resolveTarget = (
	checkout: Checkout,
	envFile: string,
	record: Option.Option<DeploymentRecord>,
) =>
	Effect.gen(function* () {
		const dotenv = Option.getOrElse(yield* readIfPresent(envFile), () => "")
		const fromFile = yield* readDotEnvValue(dotenv, "ALCHEMY_PROFILE")
		const fromShell = yield* envValue("ALCHEMY_PROFILE")
		const profile = fromFile || fromShell || Option.getOrUndefined(record)?.profile || "default"
		return {
			checkout,
			profile,
			shared: [...(dotenv.length > 0 ? ["--env-file", envFile] : []), "--profile", profile],
		} satisfies Target
	})

const generateApiKey = Effect.map(
	Effect.flatMap(SecureRandom.SecureRandom, (random) => random.randomBytes(32)),
	(bytes) => `ck_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
)

const promptForProviderKey = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio
	if (!(yield* stdio.stdinIsTerminal)) {
		return yield* configError(
			`No model provider key found. Export ${MODEL_PROVIDERS.map((provider) => provider.env).join(" or ")} and run \`checkfu deploy\` again.`,
		)
	}
	const key = yield* Prompt.run(
		Prompt.Hidden({
			message: "Paste an Anthropic or OpenAI API key (your agents call the model with it)",
			validate: (value) =>
				value.trim().length === 0 ? Effect.fail("An API key is required.") : Effect.succeed(value),
		}),
	).pipe(Effect.mapError(() => new CliFailure({ message: "Deploy cancelled.", exitCode: 130 })))
	return Redacted.value(key).trim()
})

const prepareEnvFile = (envFile: string) =>
	Effect.gen(function* () {
		const original = Option.getOrElse(yield* readIfPresent(envFile), () => "")
		let contents = original

		let apiKey = yield* readDotEnvSecret(contents, API_KEY_ENV)
		const exportedKey = yield* envValue(API_KEY_ENV)
		if (apiKey.length > 0 && exportedKey.length > 0 && apiKey !== exportedKey) {
			return yield* configError(
				`${API_KEY_ENV} in your shell differs from the one in .env. The .env value is what gets deployed, but later commands would send the shell value and be rejected. Unset ${API_KEY_ENV} or make the two match, then run again.`,
			)
		}
		if (apiKey.length === 0) {
			apiKey = exportedKey
			if (apiKey.length > 0) {
				yield* writeStderrLine(`Using ${API_KEY_ENV} from your environment.`)
			} else if (yield* (yield* Stdio.Stdio).stdinIsTerminal) {
				apiKey = yield* generateApiKey
				yield* writeStderrLine("Generated an API key for your deployment.")
			} else {
				return yield* configError(
					`No ${API_KEY_ENV} found. Without a terminal a generated key would be lost and replaced on every run; export a persistent ${API_KEY_ENV} (for example from \`openssl rand -hex 32\`).`,
				)
			}
			contents = yield* setDotEnvValue(contents, API_KEY_ENV, apiKey)
		}

		let provider: ModelProvider | undefined
		for (const candidate of MODEL_PROVIDERS) {
			let key = yield* readDotEnvSecret(contents, candidate.env)
			if (key.length === 0) {
				key = yield* envValue(candidate.env)
				if (key.length > 0) {
					contents = yield* setDotEnvValue(contents, candidate.env, key)
					yield* writeStderrLine(`Using ${candidate.env} from your environment.`)
				}
			}
			if (key.length > 0) {
				provider ??= candidate
			}
		}
		if (provider === undefined) {
			const key = yield* promptForProviderKey
			provider = providerForKey(key)
			contents = yield* setDotEnvValue(contents, provider.env, key)
		}

		if (contents !== original) {
			yield* writePrivate(envFile, contents)
		}
		return { apiKey, provider }
	})

const ProfileNames = Schema.fromJsonString(Schema.Array(Schema.String))

/** Alchemy profiles with a Cloudflare account connected, or none when that cannot be read. */
const cloudflareProfiles = (checkout: Checkout) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const stdout = yield* spawner.string(
			ChildProcess.make(
				checkout.runtime,
				[path.join(checkout.root, "apps", "cli", "scripts", "cloudflare-profiles.ts")],
				{
					cwd: checkout.root,
					env: checkout.runtimeEnv,
					extendEnv: true,
					stdin: "ignore",
					stderr: "ignore",
				},
			),
		)
		return yield* Schema.decodeEffect(ProfileNames)(stdout)
	}).pipe(Effect.option)

/**
 * Offers the browser sign-in when someone is at a terminal and Alchemy has no
 * Cloudflare credentials. It never blocks a deploy on its own judgement: which
 * credentials count is Alchemy's call, made by `provider check-env` and the deploy.
 */
const offerCloudflareSignIn = (target: Target) =>
	Effect.gen(function* () {
		if (!(yield* (yield* Stdio.Stdio).stdinIsTerminal)) {
			return
		}
		const signedIn = Effect.map(
			cloudflareProfiles(target.checkout),
			Option.match({
				onNone: () => true,
				onSome: (profiles) => profiles.includes(target.profile),
			}),
		)
		if (yield* signedIn) {
			return
		}
		if ((yield* run(target, ["provider", "check-env", "--provider", CLOUDFLARE], "quiet")) === 0) {
			return
		}
		yield* writeStderrLine(
			[
				"Checkfu deploys into your own Cloudflare account. Sign in first:",
				"",
				"  1. Choose OAuth and keep All Scopes.",
				'  2. In the browser, switch on "Account API Token Provisioning" before you approve.',
				"",
			].join("\n"),
		)
		const exitCode = yield* run(target, ["profile", "edit", "--add", CLOUDFLARE], "inherit")
		if (exitCode !== 0 || !(yield* signedIn)) {
			return yield* new CliFailure({
				message: "Cloudflare sign-in did not finish. Run `bun checkfu deploy` again to retry.",
				exitCode: exitCode === 0 ? 1 : exitCode,
			})
		}
	})

const StackOutput = Schema.fromJsonString(Schema.Struct({ api: Schema.String }))

const readDeployedUrl = (target: Target, stage: string, mode: "pipe" | "quiet" = "pipe") =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const stdout = yield* spawner
			.string(
				yield* alchemy(
					target,
					["state", "read", `${STACK_NAME}/${stage}/output`, "--no-input"],
					mode,
				),
			)
			.pipe(Effect.mapError((error) => configError(`Could not read deploy output: ${error}`)))
		const output = yield* Schema.decodeEffect(StackOutput)(stdout).pipe(
			Effect.mapError(() =>
				configError("The deploy finished but did not report an API URL. Run it again."),
			),
		)
		return yield* normalizeApiUrl(output.api)
	})

/**
 * A stage taken from the record rather than typed by the operator is only acted on
 * when the Cloudflare account in use holds exactly the deployment that was recorded.
 * Otherwise changed credentials would silently point the command at another account.
 */
const requireRecordedDeployment = (
	target: Target,
	record: DeploymentRecord,
	found: Option.Option<string>,
	consequence: string,
) =>
	Option.contains(found, record.url)
		? Effect.void
		: usageError(
				`This checkout deployed "${record.stage}" at ${record.url}, but the Cloudflare account in use (profile "${target.profile}") has ${Option.match(
					found,
					{
						onNone: () => `no "${record.stage}" deployment`,
						onSome: (url) => `"${record.stage}" at ${url}`,
					},
				)}. ${consequence} Check ALCHEMY_PROFILE and your Cloudflare credentials, or pass --stage to act on this account on purpose.`,
			)

const waitUntilLive = (url: string, within: Duration.Input) =>
	Effect.gen(function* () {
		const http = yield* HttpClient.HttpClient
		yield* http.execute(HttpClientRequest.get(`${url}/health`)).pipe(
			Effect.map((response) => response.status),
			Effect.scoped,
			Effect.mapError((error) => networkFailure(`${url} is not reachable: ${error.message}`)),
			Effect.filterOrFail(
				(code) => code === 200,
				(code) => networkFailure(`${url}/health answered HTTP ${code}.`),
			),
			Effect.retry(Schedule.spaced("2 seconds")),
			Effect.timeoutOrElse({
				duration: within,
				orElse: () =>
					Effect.fail(
						networkFailure(
							`${url} did not start answering within ${Duration.format(Duration.fromInputUnsafe(within))}. It is deployed; run \`bun checkfu deploy\` again to re-check.`,
						),
					),
			}),
		)
	})

export const deployCommand = Command.make("deploy", { stage: stageFlag, yes: yesFlag }, (input) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const checkout = yield* requireCheckout
		const envFile = path.join(checkout.root, ".env")
		const record = yield* readDeploymentRecord(checkout)
		const stage = Option.getOrElse(input.stage, () =>
			Option.match(record, { onNone: () => DEFAULT_STAGE, onSome: (known) => known.stage }),
		)

		const { apiKey, provider } = yield* prepareEnvFile(envFile)
		const target = yield* resolveTarget(checkout, envFile, record)
		yield* offerCloudflareSignIn(target)
		if (Option.isNone(input.stage) && Option.isSome(record)) {
			yield* requireRecordedDeployment(
				target,
				record.value,
				yield* readDeployedUrl(target, stage, "quiet").pipe(Effect.option),
				"Nothing was deployed.",
			)
		}

		const exitCode = yield* run(
			target,
			["deploy", "--stage", stage, ...(input.yes ? ["--yes"] : [])],
			"inherit",
		)
		if (exitCode !== 0) {
			return yield* new CliFailure({
				message: "Deploy did not finish. Run `bun checkfu deploy` again when you are ready.",
				exitCode,
			})
		}

		const url = yield* readDeployedUrl(target, stage)
		yield* writePrivate(
			yield* deploymentRecordPath(checkout),
			`${yield* Schema.encodeEffect(DeploymentRecord)({ stage, profile: target.profile, url }).pipe(Effect.orDie)}\n`,
		)
		yield* writeStderrLine(`Waiting for ${url} to come up…`)
		yield* waitUntilLive(url, checkout.readyWithin)
		yield* verifyApiKey(url, apiKey)
		const file = yield* writeSavedConnection({
			url,
			api_key: apiKey,
			model: provider.model,
		})

		yield* writeStderrLine(
			[
				"",
				`Checkfu is live at ${url}`,
				"",
				`  API key    saved to ${file}`,
				`  Model      ${provider.model} (${provider.name})`,
				`  API docs   ${url}/openapi.json`,
				"",
				"Talk to your first agent:",
				"",
				"  bun checkfu chat",
				"",
			].join("\n"),
		)
	}),
).pipe(
	Command.withDescription("Deploy Checkfu to your Cloudflare account and connect this CLI to it"),
)

export const destroyCommand = Command.make("destroy", { stage: stageFlag, yes: yesFlag }, (input) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const checkout = yield* requireCheckout
		const envFile = path.join(checkout.root, ".env")
		const record = yield* readDeploymentRecord(checkout)
		const target = yield* resolveTarget(checkout, envFile, record)

		const stage = Option.getOrElse(input.stage, () => Option.getOrUndefined(record)?.stage)
		if (stage === undefined) {
			return yield* usageError(
				"This checkout has no record of a deployment, so there is no stage to assume. Pass --stage with the one to delete.",
			)
		}
		const deployedUrl = yield* readDeployedUrl(target, stage, "quiet").pipe(Effect.option)
		if (Option.isNone(input.stage) && Option.isSome(record)) {
			yield* requireRecordedDeployment(target, record.value, deployedUrl, "Nothing was deleted.")
		}

		const exitCode = yield* run(
			target,
			["destroy", "--stage", stage, ...(input.yes ? ["--yes"] : [])],
			"inherit",
		)
		if (exitCode !== 0) {
			return yield* new CliFailure({ message: "Destroy did not finish.", exitCode })
		}
		yield* writeStderrLine(`Removed the "${stage}" deployment and all of its data.`)
		if (Option.isSome(record) && Option.contains(deployedUrl, record.value.url)) {
			yield* removeIfPresent(yield* deploymentRecordPath(checkout))
		}
		const saved = yield* readSavedConnection
		if (Option.isSome(saved) && Option.contains(deployedUrl, saved.value.url)) {
			yield* removeSavedConnection
		}
	}),
).pipe(
	Command.withDescription("Delete a deployment and all of its data from your Cloudflare account"),
)
