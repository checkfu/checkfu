import {
	CLOUDFLARE_ACCOUNT_ID_ENV,
	CLOUDFLARE_AI_API_KEY_ENV,
	CLOUDFLARE_GATEWAY_ID_ENV,
	CUSTOM_PROVIDERS_ENV,
	CUSTOM_PROVIDER_CATALOG_ENV,
	assertCloudflareWorkerEnvByteLimit,
	checkProviderCredentials,
	findProvider,
	inferProviderForApiKey,
	parseCustomProvidersManifest,
	providerRequiredSecretEnvs,
	serializeCustomProviderCatalog,
	shouldBindCloudflareAiGateway,
	validateCustomProviderCredentials,
} from "@checkfu/pi-providers/catalog"
import type { ProviderSpec } from "@checkfu/pi-providers/catalog"
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
import type * as Scope from "effect/Scope"
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
	readonly id?: string
	readonly name: string
	readonly env: string
	readonly model?: string
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
	readonly dataRoot?: string
	readonly runtime: string
	readonly runtimeEnv: Readonly<Record<string, string>>
	readonly readyWithin: Duration.Input
	readonly managed?: boolean
	readonly stage?: string
	readonly environment?: Readonly<Record<string, string | undefined>>
	readonly recordStage?: (stage: string) => Effect.Effect<void, CliFailure>
}

export const Checkout = Context.Reference<Checkout>("@checkfu/cli/Checkout", {
	defaultValue: () => ({
		root: checkoutRoot,
		runtime: process.execPath,
		runtimeEnv: isStandalone ? { BUN_BE_BUN: "1" } : {},
		readyWithin: "90 seconds",
	}),
})

export interface CheckoutRequest {
	readonly operation: "deploy" | "destroy"
	readonly stage?: string
}

export type ResolveCheckout = (
	request: CheckoutRequest,
) => Effect.Effect<Checkout, CliFailure, Scope.Scope | Path.Path>

export const CheckoutResolver = Context.Reference<ResolveCheckout>(
	"@checkfu/cli/CheckoutResolver",
	{
		defaultValue: () => () => Checkout,
	},
)

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

const trySetDotEnvValue = (
	contents: string,
	name: string,
	value: string,
): Effect.Effect<Option.Option<string>> =>
	Effect.gen(function* () {
		const quoted = quoteDotEnvValue(value)
		if (quoted === undefined) {
			return Option.none()
		}
		const line = `${name}=${quoted}`
		const existing = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, "m")
		const updated = existing.test(contents)
			? contents.replace(existing, () => line)
			: `${contents}${contents.length === 0 || contents.endsWith("\n") ? "" : "\n"}${line}\n`
		return (yield* readDotEnvValue(updated, name)) === value ? Option.some(updated) : Option.none()
	})

export const setDotEnvValue = (
	contents: string,
	name: string,
	value: string,
): Effect.Effect<string, CliFailure> =>
	trySetDotEnvValue(contents, name, value).pipe(
		Effect.flatMap(Effect.fromOption),
		Effect.mapError(() =>
			configError(
				`${name} contains characters that cannot be stored in .env. Use a value without quotes or line breaks.`,
			),
		),
	)

const STAGE_NAME = /^[a-z0-9]+[-_a-z0-9]*$/i

const stageFlag = Flag.String("stage").pipe(
	Flag.withSchema(Schema.String.check(Schema.isPattern(STAGE_NAME))),
	Flag.withMetavar("NAME"),
	Flag.withDescription(
		`Deployment stage. deploy remembers the last selected stage, or uses "${DEFAULT_STAGE}" the first time; destroy requires an explicit stage`,
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
		image: Schema.optional(Schema.String),
	}),
	{ space: "\t" },
)
type DeploymentRecord = typeof DeploymentRecord.Type

const deploymentRecordPath = (checkout: Checkout) =>
	Effect.map(Path.Path, (path) =>
		path.join(checkout.dataRoot ?? checkout.root, ".checkfu", "deployment.json"),
	)

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

const requireCheckout = (request: CheckoutRequest) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const checkout = yield* (yield* CheckoutResolver)(request)
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
	readonly image?: string
}

const inCheckout = (target: Target) => ({
	cwd: target.checkout.root,
	env: {
		...target.checkout.environment,
		...target.checkout.runtimeEnv,
		...(target.image === undefined ? {} : { CHECKFU_SANDBOX_IMAGE: target.image }),
	},
	extendEnv: target.checkout.environment === undefined,
})

const runtimeFlags = (checkout: Checkout) =>
	checkout.managed ? ["--no-env-file", `--config=${checkout.root}/apps/cli/bunfig.toml`] : []

const run = (target: Target, args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		return yield* spawner
			.exitCode(
				ChildProcess.make(
					target.checkout.runtime,
					[
						...runtimeFlags(target.checkout),
						target.checkout.managed && (args[0] === "deploy" || args[0] === "destroy")
							? path.join(target.checkout.root, "apps", "cli", "scripts", "Deployment.ts")
							: path.join(target.checkout.root, "node_modules", "alchemy", "bin", "cli.js"),
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
						...runtimeFlags(target.checkout),
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
			Effect.mapError(() =>
				target.checkout.managed
					? "The deployment helper gave no usable answer; run checkfu deploy again to retry"
					: "Alchemy gave no usable answer; run `bun install` if this checkout is new",
			),
		)
	}).pipe(Effect.catch((error) => Effect.succeed({ status: "error" as const, message: error })))

const rawEnvValue = (name: string): Effect.Effect<string> =>
	Config.option(Config.String(name)).pipe(
		Effect.map(Option.getOrElse(() => "")),
		Effect.orElseSucceed(() => ""),
	)

const envValue = (name: string): Effect.Effect<string> =>
	Effect.map(rawEnvValue(name), (value) => value.trim())

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
			...(Option.isSome(record) && record.value.image !== undefined
				? { image: record.value.image }
				: {}),
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
	options?: { readonly secret?: boolean; readonly preferEnvironment?: boolean },
): Effect.Effect<{ readonly contents: string; readonly value: string }, CliFailure, Stdio.Stdio> =>
	Effect.gen(function* () {
		let value = options?.secret
			? yield* readDotEnvSecret(contents, name)
			: (yield* readDotEnvValue(contents, name)).trim()
		if (options?.preferEnvironment) {
			const exported = yield* envValue(name)
			if (exported.length > 0 && exported !== value) {
				const next = yield* setDotEnvValue(contents, name, exported)
				yield* writeStderrLine(`Using ${name} from your environment.`)
				return { contents: next, value: exported }
			}
		}
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

const prepareEnvFile = (envFile: string, retry: string, managed = false) =>
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
			} else if (managed || (yield* (yield* Stdio.Stdio).stdinIsTerminal)) {
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
			const synced = yield* syncEnvEntry(contents, candidate.env, {
				secret: true,
				preferEnvironment: managed,
			})
			contents = synced.contents
			if (synced.value.length > 0) {
				provider ??= candidate
			}
		}

		// Cloudflare AI Gateway (zero-token native Worker AI binding when CLOUDFLARE_GATEWAY_ID
		// is set without CLOUDFLARE_AI_API_KEY, or HTTPS with CLOUDFLARE_AI_API_KEY +
		// CLOUDFLARE_ACCOUNT_ID) and Cloudflare Workers AI (CLOUDFLARE_AI_API_KEY +
		// CLOUDFLARE_ACCOUNT_ID). Deliberately never reads Alchemy's deployment CLOUDFLARE_API_KEY.
		const gatewaySynced = yield* syncEnvEntry(contents, CLOUDFLARE_GATEWAY_ID_ENV, {
			preferEnvironment: managed,
		})
		contents = gatewaySynced.contents
		const cloudflareAiKeySynced = yield* syncEnvEntry(contents, CLOUDFLARE_AI_API_KEY_ENV, {
			secret: true,
			preferEnvironment: managed,
		})
		contents = cloudflareAiKeySynced.contents
		let accountIdValue = ""
		if (cloudflareAiKeySynced.value.length > 0) {
			const accountSynced = yield* syncEnvEntry(contents, CLOUDFLARE_ACCOUNT_ID_ENV, {
				preferEnvironment: managed,
			})
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
		}

		// Custom format-compatible providers declared via CHECKFU_PROVIDERS (non-secret
		// manifest + secret env vars bound exclusively to PiHarnessWorker). Parse and
		// validate before persisting so exported multiline JSON compacts to single-line .env.
		const customManifestFromFile = yield* readDotEnvValue(original, CUSTOM_PROVIDERS_ENV)
		let customManifestRaw = customManifestFromFile.trim()
		let customManifestFromShell = false
		if (customManifestRaw.length === 0 || managed) {
			const exportedManifest = (yield* envValue(CUSTOM_PROVIDERS_ENV)).trim()
			if (exportedManifest.length > 0) {
				customManifestRaw = exportedManifest
				customManifestFromShell = true
			}
		}
		const customCredentialFailures: Array<string> = []
		if (customManifestRaw.length > 0) {
			const customProviders: ReadonlyArray<ProviderSpec> = yield* Effect.try({
				try: () =>
					parseCustomProvidersManifest(customManifestRaw, {
						allowLoopbackHttp: false,
					}),
				catch: (error) =>
					configError(
						error instanceof Error
							? error.message
							: `Invalid ${CUSTOM_PROVIDERS_ENV} configuration.`,
					),
			})
			let deployedManifest = customManifestFromFile
			if (customManifestFromShell) {
				deployedManifest = yield* Effect.try({
					try: () =>
						// Escape `'` (and Unicode line separators) as standard JSON `\uXXXX`
						// escapes so single-quoted `.env` storage always succeeds even when
						// manifest strings contain both apostrophes and backticks.
						JSON.stringify(JSON.parse(customManifestRaw))
							.replaceAll("'", String.raw`\u0027`)
							.replaceAll("\u2028", String.raw`\u2028`)
							.replaceAll("\u2029", String.raw`\u2029`),
					catch: (error) =>
						configError(
							error instanceof Error
								? error.message
								: `Invalid ${CUSTOM_PROVIDERS_ENV} configuration.`,
						),
				})
			}
			yield* Effect.try({
				try: () => {
					assertCloudflareWorkerEnvByteLimit(CUSTOM_PROVIDERS_ENV, deployedManifest, {
						packedConfigBinding: true,
					})
					if (customProviders.length > 0) {
						assertCloudflareWorkerEnvByteLimit(
							CUSTOM_PROVIDER_CATALOG_ENV,
							serializeCustomProviderCatalog(customProviders),
						)
					}
				},
				catch: (error) =>
					configError(
						error instanceof Error
							? error.message
							: `${CUSTOM_PROVIDERS_ENV} exceeds Cloudflare Workers' environment variable size limit.`,
					),
			})
			if (customManifestFromShell) {
				contents = yield* setDotEnvValue(contents, CUSTOM_PROVIDERS_ENV, deployedManifest)
				yield* writeStderrLine(`Using ${CUSTOM_PROVIDERS_ENV} from your environment.`)
			}
			const customSecretEntries: Array<readonly [string, string | undefined]> = []
			const customSecretsFromShell: Array<readonly [string, string]> = []
			for (const secretEnv of providerRequiredSecretEnvs(customProviders)) {
				let value = yield* readDotEnvSecret(original, secretEnv)
				let fromShell = false
				if (value.length === 0 || managed) {
					const exported = yield* rawEnvValue(secretEnv)
					if (exported.length > 0) {
						value = exported
						fromShell = true
					}
				}
				customSecretEntries.push([secretEnv, value.length > 0 ? value : undefined])
				if (fromShell) {
					customSecretsFromShell.push([secretEnv, value])
				}
			}
			const customEnv = Object.fromEntries(customSecretEntries)
			const credentialCheck = validateCustomProviderCredentials(customProviders, customEnv)
			if (credentialCheck.invalidCredentialErrors.length > 0) {
				return yield* configError(
					`${credentialCheck.invalidCredentialErrors.join(" ")} Nothing was deployed.`,
				)
			}
			if (credentialCheck.missingCredentialErrors.length > 0) {
				customCredentialFailures.push(...credentialCheck.missingCredentialErrors)
			} else {
				for (const [secretEnv, secretValue] of customSecretsFromShell) {
					const updated = yield* trySetDotEnvValue(contents, secretEnv, secretValue)
					if (Option.isSome(updated)) {
						contents = updated.value
						yield* writeStderrLine(`Using ${secretEnv} from your environment.`)
					} else {
						yield* writeStderrLine(
							`Using ${secretEnv} from your environment (not saved to .env because .env quoting cannot represent it losslessly; keep it exported on future deploys).`,
						)
					}
				}
				for (const custom of customProviders) {
					provider ??= {
						id: custom.id,
						name: custom.name,
						env:
							custom.auth.kind === "bearer" || custom.auth.kind === "api_key_header"
								? custom.auth.env
								: CUSTOM_PROVIDERS_ENV,
						...(custom.defaultModel === undefined ? {} : { model: custom.defaultModel }),
					}
				}
			}
		}

		if (customCredentialFailures.length > 0) {
			return yield* configError(
				`${customCredentialFailures.join(" ")} Export the missing variable(s) or add them to .env and run \`${retry}\` again.`,
			)
		}

		if (provider === undefined) {
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

const ImageAnswer = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("found"),
		image: Schema.String.check(
			Schema.isPattern(
				/^registry\.cloudflare\.com\/[a-f0-9]{32}\/checkfu-sandbox@sha256:[a-f0-9]{64}$/,
			),
		),
	}),
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
				`This CLI recorded "${stage}" in Cloudflare account ${record.value.account_id}, but the credentials in use act on account ${accountId}. Nothing was changed. Check ALCHEMY_PROFILE and your Cloudflare credentials.`,
			)
		: Effect.void

const writeDeploymentRecord = (checkout: Checkout, record: DeploymentRecord) =>
	Effect.gen(function* () {
		const contents = yield* Schema.encodeEffect(DeploymentRecord)(record).pipe(Effect.orDie)
		yield* writePrivate(yield* deploymentRecordPath(checkout), `${contents}\n`)
		if (checkout.recordStage !== undefined) {
			yield* checkout.recordStage(record.stage)
		}
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

const SAFE_UNQUOTED_SHELL_ARG = /^[A-Za-z0-9._/@:+][A-Za-z0-9._/@:+-]*$/

const formatShellArg = (value: string): string =>
	SAFE_UNQUOTED_SHELL_ARG.test(value) ? value : `'${value.replaceAll("'", String.raw`'\''`)}'`

export const deployCommand = Command.make("deploy", { stage: stageFlag, yes: yesFlag }, (input) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const checkout = yield* requireCheckout({
			operation: "deploy",
			...Option.match(input.stage, { onNone: () => ({}), onSome: (stage) => ({ stage }) }),
		})
		const envFile = path.join(checkout.dataRoot ?? checkout.root, ".env")
		const record = yield* readDeploymentRecord(checkout)
		const stage = Option.getOrElse(input.stage, () =>
			Option.match(record, {
				onNone: () => checkout.stage ?? DEFAULT_STAGE,
				onSome: (known) => known.stage,
			}),
		)

		const retry = `${COMMAND} deploy${Option.isSome(input.stage) ? ` --stage ${stage}` : ""}`

		const checked = yield* resolveTarget(checkout, envFile, record)
		const accountId = yield* requireAccount(checked, Option.some({ retry }))
		yield* requireRecordedAccount(record, stage, accountId)
		const { apiKey, provider } = yield* prepareEnvFile(envFile, retry, checkout.managed)
		let target: Target = { ...checked, envFile: Option.some(envFile) }
		// Record ownership before the first mutation: failed/partial deploys must be destroyable.
		const attempt = {
			stage,
			profile: target.profile,
			account_id: accountId,
			...(Option.isSome(record) && record.value.stage === stage && record.value.url !== undefined
				? { url: record.value.url }
				: {}),
			...(target.image === undefined ? {} : { image: target.image }),
		}
		yield* writeDeploymentRecord(checkout, attempt)
		if (checkout.managed) {
			yield* writeStderrLine("Preparing the agent sandbox in your Cloudflare account…")
			const image = yield* ask(target, ImageAnswer, ["image"])
			if (image.status === "error") {
				return yield* configError(`Could not prepare the sandbox: ${image.message}`)
			}
			target = { ...target, image: image.image }
			yield* writeDeploymentRecord(checkout, { ...attempt, image: image.image })
		}

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
		const deployed = {
			stage,
			profile: target.profile,
			account_id: accountId,
			...(target.image === undefined ? {} : { image: target.image }),
		}
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
				`  ${COMMAND} agents create --name Assistant --model ${provider.model === undefined ? `${provider.id ?? "<provider>"}/<model-id>` : formatShellArg(provider.model)}`,
				`  ${COMMAND} environments create --name default`,
				`  ${COMMAND} sessions create --agent <agent-id> --environment-id <environment-id>`,
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
	}).pipe(Effect.scoped),
).pipe(
	Command.withDescription("Deploy Checkfu to your Cloudflare account and connect this CLI to it"),
)

export const destroyCommand = Command.make("destroy", { stage: stageFlag, yes: yesFlag }, (input) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const checkout = yield* requireCheckout({
			operation: "destroy",
			...Option.match(input.stage, { onNone: () => ({}), onSome: (stage) => ({ stage }) }),
		})
		const record = Option.getOrUndefined(yield* readDeploymentRecord(checkout))

		if (Option.isNone(input.stage)) {
			return yield* usageError(
				`Name the stage to delete: \`${COMMAND} destroy --stage <name>\`.${record === undefined ? "" : ` This CLI last deployed "${record.stage}".`}`,
			)
		}
		const stage = input.stage.value
		if (record?.stage !== stage) {
			return yield* usageError(
				`This CLI has no record of deploying "${stage}"${record === undefined ? "" : ` (it last deployed "${record.stage}")`}. Nothing was deleted. Use the configuration directory that originally deployed this stage.`,
			)
		}
		const target = yield* resolveTarget(
			checkout,
			path.join(checkout.dataRoot ?? checkout.root, ".env"),
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
	}).pipe(Effect.scoped),
).pipe(
	Command.withDescription(
		"Delete a recorded deployment and all of its data from your Cloudflare account",
	),
)
