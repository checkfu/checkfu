import {
	CLOUDFLARE_ACCOUNT_ID_ENV,
	CLOUDFLARE_AI_API_KEY_ENV,
	CLOUDFLARE_GATEWAY_ID_ENV,
	checkProviderCredentials,
	findProvider,
	inferProviderForApiKey,
	shouldBindCloudflareAiGateway,
} from "@checkfu/pi-providers/catalog"
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
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
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
import { COMMAND } from "../Invocation.ts"
import { checkoutRoot, isStandalone } from "../Standalone.ts"
import { writeStderrLine } from "../TerminalOutput.ts"

export const STACK_NAME = "Checkfu"
export const DEFAULT_STAGE = "live"
const API_KEY_ENV = "CHECKFU_API_KEY"

export interface ModelProvider {
	readonly name: string
	readonly env: string
	readonly model: string
}

const singleKeyProvider = (id: "anthropic" | "openai" | "openrouter"): ModelProvider => {
	const spec = findProvider(id)
	if (
		spec === undefined ||
		spec.defaultModel === undefined ||
		(spec.auth.kind !== "bearer" && spec.auth.kind !== "api_key_header")
	) {
		throw new Error(`Missing built-in provider specification for "${id}".`)
	}
	return { name: spec.name, env: spec.auth.env, model: spec.defaultModel }
}

const CLOUDFLARE_AI_GATEWAY_PROVIDER: ModelProvider = {
	name: "Cloudflare AI Gateway",
	env: CLOUDFLARE_GATEWAY_ID_ENV,
	model:
		findProvider("cloudflare-ai-gateway")?.defaultModel ??
		"cloudflare-ai-gateway/claude-sonnet-5-5",
}

const CLOUDFLARE_WORKERS_AI_PROVIDER: ModelProvider = {
	name: "Cloudflare Workers AI",
	env: CLOUDFLARE_AI_API_KEY_ENV,
	model:
		findProvider("cloudflare-workers-ai")?.defaultModel ??
		"cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4.1-flash-1017",
}

export const MODEL_PROVIDERS: ReadonlyArray<ModelProvider> = [
	singleKeyProvider("anthropic"),
	singleKeyProvider("openai"),
	singleKeyProvider("openrouter"),
]

const OPENAI_PROVIDER = singleKeyProvider("openai")

export const providerForKey = (key: string): ModelProvider => {
	const inferred = inferProviderForApiKey(key)
	if (inferred !== undefined) {
		const matched = MODEL_PROVIDERS.find((candidate) => candidate.name === inferred.name)
		if (matched !== undefined) {
			return matched
		}
	}
	return OPENAI_PROVIDER
}

export interface Checkout {
	readonly root: string
	readonly runtime: string
	readonly runtimeEnv: Readonly<Record<string, string>>
	readonly readyWithin: Duration.Input
}

export const Checkout = Context.Reference<Checkout>("@checkfu/cli/Checkout", {
	defaultValue: () => ({
		root: checkoutRoot,
		runtime: process.execPath,
		runtimeEnv: isStandalone ? { BUN_BE_BUN: "1" } : {},
		readyWithin: "90 seconds",
	}),
})

export const readDotEnvValue = (contents: string, name: string): Effect.Effect<string> =>
	Config.String(name)
		.parse(ConfigProvider.fromDotEnvContents(contents))
		.pipe(Effect.orElseSucceed(() => ""))

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

const STAGE_NAME = /^[a-z0-9]+[-_a-z0-9]*$/i

const stageFlag = Flag.String("stage").pipe(
	Flag.withSchema(Schema.String.check(Schema.isPattern(STAGE_NAME))),
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

const DeploymentRecord = Schema.fromJsonString(
	Schema.Struct({
		stage: Schema.String.check(Schema.isPattern(STAGE_NAME)),
		profile: Schema.String,
		account_id: Schema.String,
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
			const envList = [...MODEL_PROVIDERS.map((provider) => provider.env), "CLOUDFLARE_GATEWAY_ID"]
			return yield* configError(
				`No model provider key found. Export ${envList.slice(0, -1).join(", ")}, or ${envList.at(-1)} and run \`${retry}\` again.`,
			)
		}
		const key = yield* Prompt.run(
			Prompt.Hidden({
				message:
					"Paste an Anthropic, OpenAI, or OpenRouter API key (your agents call the model with it)",
				validate: (value) =>
					value.trim().length === 0
						? Effect.fail("An API key is required.")
						: Effect.succeed(value),
			}),
		).pipe(Effect.mapError(() => new CliFailure({ message: "Deploy cancelled.", exitCode: 130 })))
		return Redacted.value(key).trim()
	})

const syncEnvEntry = (
	contents: string,
	name: string,
	options?: { readonly secret?: boolean },
): Effect.Effect<{ readonly contents: string; readonly value: string }, CliFailure, Stdio.Stdio> =>
	Effect.gen(function* () {
		let value = options?.secret
			? yield* readDotEnvSecret(contents, name)
			: (yield* readDotEnvValue(contents, name)).trim()
		if (value.length === 0) {
			value = yield* envValue(name)
			if (value.length > 0) {
				const next = yield* setDotEnvValue(contents, name, value)
				yield* writeStderrLine(`Using ${name} from your environment.`)
				return { contents: next, value }
			}
		}
		return { contents, value }
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
			const synced = yield* syncEnvEntry(contents, candidate.env, { secret: true })
			contents = synced.contents
			if (synced.value.length > 0) {
				provider ??= candidate
			}
		}

		// Cloudflare AI Gateway (zero-token native Worker AI binding when CLOUDFLARE_GATEWAY_ID
		// is set without CLOUDFLARE_AI_API_KEY, or HTTPS with CLOUDFLARE_AI_API_KEY +
		// CLOUDFLARE_ACCOUNT_ID) and Cloudflare Workers AI (CLOUDFLARE_AI_API_KEY +
		// CLOUDFLARE_ACCOUNT_ID). Deliberately never reads Alchemy's deployment CLOUDFLARE_API_KEY.
		const gatewaySynced = yield* syncEnvEntry(contents, CLOUDFLARE_GATEWAY_ID_ENV)
		contents = gatewaySynced.contents
		const cloudflareAiKeySynced = yield* syncEnvEntry(contents, CLOUDFLARE_AI_API_KEY_ENV, {
			secret: true,
		})
		contents = cloudflareAiKeySynced.contents
		let accountIdValue = ""
		if (cloudflareAiKeySynced.value.length > 0) {
			const accountSynced = yield* syncEnvEntry(contents, CLOUDFLARE_ACCOUNT_ID_ENV)
			contents = accountSynced.contents
			accountIdValue = accountSynced.value
		}
		const cloudflareEnv: Readonly<Record<string, string | undefined>> = Object.fromEntries([
			[CLOUDFLARE_GATEWAY_ID_ENV, gatewaySynced.value.length > 0 ? gatewaySynced.value : undefined],
			[
				CLOUDFLARE_AI_API_KEY_ENV,
				cloudflareAiKeySynced.value.length > 0 ? cloudflareAiKeySynced.value : undefined,
			],
			[CLOUDFLARE_ACCOUNT_ID_ENV, accountIdValue.length > 0 ? accountIdValue : undefined],
		])
		const gatewaySpec = findProvider("cloudflare-ai-gateway")
		const workersAiSpec = findProvider("cloudflare-workers-ai")
		const gatewayCheck =
			gatewaySpec === undefined
				? { ok: false as const, missing: [] as ReadonlyArray<string>, message: "" }
				: checkProviderCredentials(gatewaySpec, {
						env: cloudflareEnv,
						aiBinding: shouldBindCloudflareAiGateway(cloudflareEnv)
							? { fetch: globalThis.fetch }
							: null,
					})
		const workersAiCheck =
			workersAiSpec === undefined
				? { ok: false as const, missing: [] as ReadonlyArray<string>, message: "" }
				: checkProviderCredentials(workersAiSpec, { env: cloudflareEnv })
		if (gatewayCheck.ok) {
			provider ??= CLOUDFLARE_AI_GATEWAY_PROVIDER
		} else if (workersAiCheck.ok) {
			provider ??= CLOUDFLARE_WORKERS_AI_PROVIDER
		} else if (provider === undefined) {
			if (gatewaySynced.value.length > 0 && cloudflareAiKeySynced.value.length > 0) {
				return yield* configError(
					`${CLOUDFLARE_GATEWAY_ID_ENV} and ${CLOUDFLARE_AI_API_KEY_ENV} are set without ${CLOUDFLARE_ACCOUNT_ID_ENV}, so neither HTTPS AI Gateway auth nor the native Worker AI binding can be used. Set ${CLOUDFLARE_ACCOUNT_ID_ENV} for HTTPS auth, or unset ${CLOUDFLARE_AI_API_KEY_ENV} to use the native Worker AI binding on deploy.`,
				)
			}
			if (cloudflareAiKeySynced.value.length > 0) {
				return yield* configError(
					`${CLOUDFLARE_AI_API_KEY_ENV} is set without ${CLOUDFLARE_ACCOUNT_ID_ENV}. Set ${CLOUDFLARE_ACCOUNT_ID_ENV} to use Cloudflare Workers AI (or also set ${CLOUDFLARE_GATEWAY_ID_ENV} for AI Gateway).`,
				)
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
		value: Schema.Struct({
			api: Schema.String,
			mcp: Schema.optionalKey(Schema.String),
			app: Schema.optionalKey(Schema.String),
		}),
	}),
	Schema.Struct({ status: Schema.Literal("missing") }),
	AnswerError,
])

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
				return {
					url: yield* normalizeApiUrl(answer.value.api),
					mcp: answer.value.mcp,
					app: answer.value.app,
				}
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

const waitUntilReady = (url: string, apiKey: string, within: Duration.Input, retry: string) =>
	Effect.gen(function* () {
		const lastFailure = yield* Ref.make("it did not answer")
		yield* verifyApiKey(url, apiKey).pipe(
			Effect.tapError((error) => Ref.set(lastFailure, error.message)),
			Effect.retry(Schedule.spaced("2 seconds")),
			Effect.timeoutOrElse({
				duration: within,
				orElse: () =>
					Effect.flatMap(Ref.get(lastFailure), (reason) =>
						Effect.fail(
							networkFailure(
								`The deployment did not accept its API key within ${Duration.format(Duration.fromInputUnsafe(within))}: ${reason.replace(/\.+$/, "")}. It is deployed; run \`${retry}\` again to re-check.`,
							),
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

		const retry = `${COMMAND} deploy${Option.isSome(input.stage) ? ` --stage ${stage}` : ""}`

		const checked = yield* resolveTarget(checkout, envFile, record)
		const accountId = yield* requireAccount(checked, Option.some({ retry }))
		yield* requireRecordedAccount(record, stage, accountId)
		const { apiKey, provider } = yield* prepareEnvFile(envFile, retry)
		const target = { ...checked, envFile: Option.some(envFile) } satisfies Target

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

		const known = Option.filter(
			record,
			(previous) => previous.stage === stage && previous.account_id === accountId,
		)
		const deployed = { stage, profile: target.profile, account_id: accountId }
		yield* writeDeploymentRecord(checkout, {
			...deployed,
			...Option.match(known, {
				onNone: () => ({}),
				onSome: (previous) => (previous.url === undefined ? {} : { url: previous.url }),
			}),
		})
		const { url, mcp, app } = yield* readDeployedUrl(target, stage, retry)
		yield* writeDeploymentRecord(checkout, { ...deployed, url })
		yield* writeStderrLine(`Waiting for ${url} to come up…`)
		yield* waitUntilReady(url, apiKey, checkout.readyWithin, retry)
		const file = yield* writeSavedConnection({ url, api_key: apiKey })

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
				`  API docs   ${url}/openapi.json`,
				...(app === undefined ? [] : [`  Dashboard  ${app.replace(/\/+$/, "")}`]),
				...(mcp === undefined ? [] : [`  MCP        ${mcp.replace(/\/+$/, "")}/mcp`]),
				"",
				"Next, create an agent, an environment, and a session, then connect to it:",
				"",
				`  ${COMMAND} agents create --name Assistant --model ${provider.model}`,
				`  ${COMMAND} environments create --name default`,
				`  ${COMMAND} sessions create --agent-id <agent-id> --environment-id <environment-id>`,
				`  ${COMMAND} sessions connect <session-id>`,
				"",
				...(elsewhere
					? [
							`This shell exports a different Checkfu URL. Unset it, or add \`--base-url ${url}\` after \`${COMMAND}\`.`,
							"",
						]
					: []),
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
