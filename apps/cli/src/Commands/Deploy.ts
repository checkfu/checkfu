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
import { explicitBaseUrl, isSendableApiKey, normalizeApiUrl, verifyApiKey } from "../Client.ts"
import { CliFailure, configError, networkFailure, usageError } from "../Errors.ts"
import {
	readSavedConnection,
	removeSavedConnection,
	writeSavedConnection,
} from "../SavedConnection.ts"
import { readIfPresent, removeIfPresent, restrictToOwner, writePrivate } from "../PrivateFile.ts"
import { COMMAND, isStandalone } from "../Standalone.ts"
import { shellQuote, writeStderrLine } from "../TerminalOutput.ts"

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
		`Deployment stage. deploy defaults to the one this checkout last deployed, or "${DEFAULT_STAGE}" the first time; destroy requires it`,
	),
	Flag.optional,
)

const yesFlag = Flag.Boolean("yes").pipe(
	Flag.withAlias("y"),
	Flag.withDefault(false),
	Flag.withDescription("Skip the confirmation prompt"),
)

/**
 * The deployment this checkout manages, identified by Cloudflare account and stage.
 * Written the moment Alchemy reports a successful deploy, so it always names the last
 * thing this checkout deployed. A bare `deploy` takes its stage from it; `destroy`
 * deletes nothing that it does not name. It is deliberately not part of the saved login;
 * which API the CLI talks to and what this checkout manages change independently.
 */
const DeploymentRecord = Schema.fromJsonString(
	Schema.Struct({
		stage: Schema.String,
		profile: Schema.String,
		account_id: Schema.String,
		// Absent between a successful deploy and reading its URL back.
		url: Schema.optional(Schema.String),
	}),
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
		.pipe(
			Effect.mapError((error) =>
				configError(`Could not look for the checkout at ${checkout.root}: ${error.message}`),
			),
		)
	if (!hasStack) {
		return yield* usageError(
			"This command deploys from a Checkfu source checkout. Clone https://github.com/checkfu/checkfu, run `bun install`, then `bun checkfu deploy`.",
		)
	}
	return checkout
})

/**
 * One Alchemy invocation context. Every call in a run gets the same checkout, env
 * file, and profile, so the sign-in, the account lookup, and the deploy can never
 * disagree about which account they act on.
 */
interface Target {
	readonly checkout: Checkout
	readonly profile: string
	readonly envFile: Option.Option<string>
}

const inCheckout = (target: Target) => ({
	cwd: target.checkout.root,
	env: target.checkout.runtimeEnv,
	extendEnv: true,
})

/** Runs an Alchemy command attached to the terminal and returns its exit code. */
const run = (target: Target, args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		return yield* spawner
			.exitCode(
				ChildProcess.make(
					target.checkout.runtime,
					[
						path.join(target.checkout.root, "node_modules", "alchemy", "bin", "cli.js"),
						...args,
						...Option.match(target.envFile, {
							onNone: () => [],
							onSome: (envFile) => ["--env-file", envFile],
						}),
						"--profile",
						target.profile,
					],
					{ ...inCheckout(target), stdin: "inherit", stdout: "inherit", stderr: "inherit" },
				),
			)
			.pipe(Effect.mapError((error) => configError(`Could not start Alchemy: ${error}`)))
	})

const ANSWER_PREFIX = "@checkfu "

/**
 * Asks Alchemy a question through `apps/cli/scripts/alchemy-query.ts`, which calls
 * Alchemy's own functions and answers on one marked line. Alchemy's console output is
 * never parsed, and a question that could not be answered is an `error` answer, never
 * a missing one.
 */
const ask = <A>(
	target: Target,
	answers: Schema.Codec<A, unknown>,
	question: ReadonlyArray<string>,
): Effect.Effect<
	A | { readonly status: "error"; readonly message: string },
	never,
	ChildProcessSpawner.ChildProcessSpawner | Path.Path
> =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const [name = "", ...rest] = question
		const stdout = yield* spawner
			.string(
				ChildProcess.make(
					target.checkout.runtime,
					[
						path.join(target.checkout.root, "apps", "cli", "scripts", "alchemy-query.ts"),
						name,
						target.profile,
						Option.getOrElse(target.envFile, () => ""),
						...rest,
					],
					{ ...inCheckout(target), stdin: "ignore", stderr: "ignore" },
				),
			)
			.pipe(Effect.mapError((error) => `the query could not be run (${error.message})`))
		const line = stdout.split("\n").findLast((candidate) => candidate.startsWith(ANSWER_PREFIX))
		return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(answers))(
			line?.slice(ANSWER_PREFIX.length),
		).pipe(
			Effect.mapError(
				() => "Alchemy gave no usable answer; run `bun install` if this checkout is new",
			),
		)
	}).pipe(Effect.catch((error) => Effect.succeed({ status: "error" as const, message: error })))

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
		return {
			checkout,
			profile: fromFile || fromShell || Option.getOrUndefined(record)?.profile || "default",
			envFile: dotenv.length > 0 ? Option.some(envFile) : Option.none(),
		} satisfies Target
	})

const generateApiKey = Effect.map(
	Effect.flatMap(SecureRandom.SecureRandom, (random) => random.randomBytes(32)),
	(bytes) => `ck_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
)

const promptForProviderKey = (retry: string) =>
	Effect.gen(function* () {
		const stdio = yield* Stdio.Stdio
		if (!(yield* stdio.stdinIsTerminal)) {
			return yield* configError(
				`No model provider key found. Export ${MODEL_PROVIDERS.map((provider) => provider.env).join(" or ")} and run \`${retry}\` again.`,
			)
		}
		const key = yield* Prompt.run(
			Prompt.Hidden({
				message: "Paste an Anthropic or OpenAI API key (your agents call the model with it)",
				validate: (value) =>
					value.trim().length === 0
						? Effect.fail("An API key is required.")
						: Effect.succeed(value),
			}),
		).pipe(Effect.mapError(() => new CliFailure({ message: "Deploy cancelled.", exitCode: 130 })))
		return Redacted.value(key).trim()
	})

const prepareEnvFile = (envFile: string, retry: string) =>
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
			const key = yield* promptForProviderKey(retry)
			provider = providerForKey(key)
			contents = yield* setDotEnvValue(contents, provider.env, key)
		}

		if (!isSendableApiKey(apiKey)) {
			return yield* configError(
				`${API_KEY_ENV} cannot be sent in an HTTP header: it must be printable ASCII with no spaces or line breaks. Nothing was deployed.`,
			)
		}
		// Owner-only either way: a hand-written .env usually starts out world-readable.
		yield* contents === original ? restrictToOwner(envFile) : writePrivate(envFile, contents)
		return { apiKey, provider }
	})

const AnswerError = Schema.Struct({ status: Schema.Literal("error"), message: Schema.String })

const AccountAnswer = Schema.Union([
	Schema.Struct({ status: Schema.Literal("connected"), account_id: Schema.String }),
	Schema.Struct({ status: Schema.Literal("not-configured"), message: Schema.String }),
	AnswerError,
])

const OutputAnswer = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("found"),
		value: Schema.Struct({ api: Schema.String }),
	}),
	Schema.Struct({ status: Schema.Literal("missing") }),
	AnswerError,
])

/**
 * The Cloudflare account Alchemy will act on, as Alchemy itself resolves it. Finding
 * it out changes nothing in any account. At a terminal, a profile with no Cloudflare
 * connection gets Alchemy's browser sign-in first.
 */
const requireAccount = (target: Target, signIn: Option.Option<{ readonly retry: string }>) =>
	Effect.gen(function* () {
		let answer = yield* ask(target, AccountAnswer, ["account"])
		if (
			answer.status === "not-configured" &&
			Option.isSome(signIn) &&
			(yield* (yield* Stdio.Stdio).stdinIsTerminal)
		) {
			yield* writeStderrLine(
				[
					"Checkfu deploys into your own Cloudflare account. Sign in first:",
					"",
					"  1. Choose OAuth and keep All Scopes.",
					'  2. In the browser, switch on "Account API Token Provisioning" before you approve.',
					"",
				].join("\n"),
			)
			const exitCode = yield* run(target, ["profile", "edit", "--add", "Cloudflare"])
			answer = yield* ask(target, AccountAnswer, ["account"])
			if (exitCode !== 0 || answer.status === "not-configured") {
				return yield* new CliFailure({
					message: `Cloudflare sign-in did not finish. Run \`${signIn.value.retry}\` again to retry.`,
					exitCode: exitCode === 0 ? 1 : exitCode,
				})
			}
		}
		switch (answer.status) {
			case "connected":
				return answer.account_id
			case "not-configured":
				return yield* configError(
					`${answer.message} Sign in by running \`${COMMAND} deploy\` in a terminal, or export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.`,
				)
			case "error":
				return yield* configError(
					`Could not determine which Cloudflare account is in use: ${answer.message.replace(/\.+$/, "")}. Nothing was changed.`,
				)
		}
	})

/**
 * A stage this checkout has deployed is only ever touched in the account it was
 * deployed to. Otherwise changed credentials would silently point the command at
 * another account's deployment of the same name.
 */
const requireRecordedAccount = (
	record: Option.Option<DeploymentRecord>,
	stage: string,
	accountId: string,
) =>
	Option.isSome(record) && record.value.stage === stage && record.value.account_id !== accountId
		? usageError(
				`This checkout deployed "${stage}" to Cloudflare account ${record.value.account_id}, but the credentials in use act on account ${accountId}. Nothing was changed. Check ALCHEMY_PROFILE and your Cloudflare credentials.`,
			)
		: Effect.void

const writeDeploymentRecord = (checkout: Checkout, record: DeploymentRecord) =>
	Effect.gen(function* () {
		const contents = yield* Schema.encodeEffect(DeploymentRecord)(record).pipe(Effect.orDie)
		yield* writePrivate(yield* deploymentRecordPath(checkout), `${contents}\n`)
	})

const readDeployedUrl = (target: Target, stage: string, retry: string) =>
	Effect.gen(function* () {
		const answer = yield* ask(target, OutputAnswer, ["output", `${STACK_NAME}/${stage}/output`])
		switch (answer.status) {
			case "found":
				return yield* normalizeApiUrl(answer.value.api)
			case "missing":
				return yield* configError(
					`Alchemy deployed "${stage}" but recorded no API URL for it. Run \`${retry}\` again.`,
				)
			case "error":
				return yield* configError(
					`"${stage}" is deployed, but its URL could not be read: ${answer.message.replace(/\.+$/, "")}. Run \`${retry}\` again to finish connecting.`,
				)
		}
	})

const waitUntilLive = (url: string, within: Duration.Input, retry: string) =>
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
							`${url} did not start answering within ${Duration.format(Duration.fromInputUnsafe(within))}. It is deployed; run \`${retry}\` again to re-check.`,
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

		// What to type to run this same deploy again; a bare retry could pick another stage.
		const retry = `${COMMAND} deploy${Option.isSome(input.stage) ? ` --stage ${stage}` : ""}`

		// The account is settled before any secret is written, so a refusal leaves the
		// checkout exactly as it was.
		const accountId = yield* requireAccount(
			yield* resolveTarget(checkout, envFile, record),
			Option.some({ retry }),
		)
		yield* requireRecordedAccount(record, stage, accountId)
		const { apiKey, provider } = yield* prepareEnvFile(envFile, retry)
		// Resolved again because preparing the secrets may have created the env file.
		const target = yield* resolveTarget(checkout, envFile, record)

		const exitCode = yield* run(target, [
			"deploy",
			"--stage",
			stage,
			...(input.yes ? ["--yes"] : []),
		])
		if (exitCode !== 0) {
			return yield* new CliFailure({
				message: `Deploy did not finish. Run \`${retry}\` again when you are ready.`,
				exitCode,
			})
		}

		// Recorded before anything else can fail, so the record always names what was
		// last deployed; its URL follows once Alchemy has been asked for it.
		const deployed = { stage, profile: target.profile, account_id: accountId }
		yield* writeDeploymentRecord(checkout, deployed)
		const url = yield* readDeployedUrl(target, stage, retry)
		yield* writeDeploymentRecord(checkout, { ...deployed, url })
		yield* writeStderrLine(`Waiting for ${url} to come up…`)
		yield* waitUntilLive(url, checkout.readyWithin, retry)
		yield* verifyApiKey(url, apiKey)
		const file = yield* writeSavedConnection({
			url,
			api_key: apiKey,
			model: provider.model,
		})

		// A bare `chat` goes wherever CHECKFU_API_URL or CHECKFU_URL points, so when one of
		// them names another deployment the suggestion has to name this one.
		const exported = yield* explicitBaseUrl(Option.none())
		const elsewhere =
			Option.isSome(exported) &&
			!Option.contains(yield* Effect.option(normalizeApiUrl(exported.value)), url)
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
				elsewhere
					? `  ${COMMAND} --base-url ${shellQuote(url)} chat    (this shell exports a different Checkfu URL)`
					: `  ${COMMAND} chat`,
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
		const record = Option.getOrUndefined(yield* readDeploymentRecord(checkout))

		// Deleting takes two agreeing witnesses: the operator names the stage, and this
		// checkout recorded deploying it. Nothing is ever chosen on the operator's behalf.
		if (Option.isNone(input.stage)) {
			return yield* usageError(
				`Name the stage to delete: \`${COMMAND} destroy --stage <name>\`.${record === undefined ? "" : ` This checkout last deployed "${record.stage}".`}`,
			)
		}
		const stage = input.stage.value
		if (record?.stage !== stage) {
			return yield* usageError(
				`This checkout has no record of deploying "${stage}"${record === undefined ? "" : ` (it last deployed "${record.stage}")`}. Nothing was deleted. To delete a deployment made elsewhere, use Alchemy directly: \`bun run destroy --stage ${stage}\`.`,
			)
		}
		const target = yield* resolveTarget(
			checkout,
			path.join(checkout.root, ".env"),
			Option.some(record),
		)
		const accountId = yield* requireAccount(target, Option.none())
		yield* requireRecordedAccount(Option.some(record), stage, accountId)

		const exitCode = yield* run(target, [
			"destroy",
			"--stage",
			stage,
			...(input.yes ? ["--yes"] : []),
		])
		if (exitCode !== 0) {
			return yield* new CliFailure({ message: "Destroy did not finish.", exitCode })
		}
		yield* writeStderrLine(`Removed the "${stage}" deployment and all of its data.`)
		yield* removeIfPresent(yield* deploymentRecordPath(checkout))
		const saved = yield* readSavedConnection
		if (Option.isSome(saved) && saved.value.url === record.url) {
			yield* removeSavedConnection
		}
	}),
).pipe(
	Command.withDescription(
		"Delete a deployment this checkout made, and all of its data, from your Cloudflare account",
	),
)
