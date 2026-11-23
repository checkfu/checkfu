import * as NodePath from "node:path"
import { argv, exit, stderr } from "node:process"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as workers from "@distilled.cloud/cloudflare/workers"
import * as BunServices from "@effect/platform-bun/BunServices"
import { AuthProvidersLive } from "alchemy/Auth/AuthProvider"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Console from "effect/Console"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import { CLOUDFLARE_STATE_OBSERVABILITY, DEFAULT_STATE_STORE_WORKER_NAME } from "../alchemy.run.ts"

export type DesiredStateStoreObservability = {
	readonly enabled: boolean
	readonly logs: {
		readonly enabled: boolean
		readonly invocationLogs: boolean
	}
}

export const needsStateStoreObservabilityUpdate = (
	observed: workers.ScriptsSettingsGetResponseObservability | null | undefined,
	desired: DesiredStateStoreObservability,
): boolean =>
	observed?.enabled !== desired.enabled ||
	observed?.logs?.enabled !== desired.logs.enabled ||
	observed?.logs?.invocationLogs !== desired.logs.invocationLogs

/**
 * Cloudflare's `PATCH /script-settings` replaces the entire `observability`
 * object, so preserve any existing sampling, trace, issue, or destination
 * settings while applying the desired logging config.
 */
export const mergeStateStoreObservability = (
	observed: workers.ScriptsSettingsGetResponseObservability | null | undefined,
	desired: DesiredStateStoreObservability,
): workers.ScriptsSettingsEditRequestObservability => ({
	enabled: desired.enabled,
	headSamplingRate: observed?.headSamplingRate ?? undefined,
	redactQueryString: observed?.redactQueryString ?? undefined,
	logs: {
		enabled: desired.logs.enabled,
		invocationLogs: desired.logs.invocationLogs,
		destinations: observed?.logs?.destinations ?? undefined,
		headSamplingRate: observed?.logs?.headSamplingRate ?? undefined,
		persist: observed?.logs?.persist ?? undefined,
	},
	traces: observed?.traces
		? {
				destinations: observed.traces.destinations ?? undefined,
				enabled: observed.traces.enabled ?? undefined,
				headSamplingRate: observed.traces.headSamplingRate ?? undefined,
				persist: observed.traces.persist ?? undefined,
				propagationPolicy: observed.traces.propagationPolicy ?? undefined,
			}
		: undefined,
	issues: observed?.issues
		? {
				enabled: observed.issues.enabled ?? undefined,
			}
		: undefined,
})

export type SyncStateStoreObservabilityResult =
	| { readonly status: "missing"; readonly scriptName: string }
	| { readonly status: "unchanged"; readonly scriptName: string }
	| {
			readonly status: "would-update"
			readonly scriptName: string
			readonly observability: workers.ScriptsSettingsEditRequestObservability
	  }
	| {
			readonly status: "updated"
			readonly scriptName: string
			readonly observability: workers.ScriptsSettingsEditRequestObservability
	  }

export type MissingStateStoreWorkerError = workers.WorkerNotFound | workers.WorkerHasNoVersions

const isMissingStateStoreWorkerError = (error: unknown): error is MissingStateStoreWorkerError =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	(error._tag === "WorkerNotFound" || error._tag === "WorkerHasNoVersions")

export const syncStateStoreObservability = <E1, R1, E2, R2>(options: {
	readonly accountId: string
	readonly scriptName: string
	readonly desired: DesiredStateStoreObservability
	readonly dryRun?: boolean
	readonly getSetting: (
		input: workers.GetScriptSettingRequest,
	) => Effect.Effect<workers.GetScriptSettingResponse, E1 | MissingStateStoreWorkerError, R1>
	readonly patchSetting: (
		input: workers.PatchScriptSettingRequest,
	) => Effect.Effect<workers.PatchScriptSettingResponse, E2, R2>
}): Effect.Effect<
	SyncStateStoreObservabilityResult,
	Exclude<E1, MissingStateStoreWorkerError> | E2,
	R1 | R2
> =>
	Effect.gen(function* () {
		const current = yield* options
			.getSetting({ accountId: options.accountId, scriptName: options.scriptName })
			.pipe(
				Effect.map((response) => ({ found: true as const, response })),
				Effect.catchIf(isMissingStateStoreWorkerError, () =>
					Effect.succeed({ found: false as const }),
				),
			)
		if (!current.found) {
			return { status: "missing" as const, scriptName: options.scriptName }
		}
		if (!needsStateStoreObservabilityUpdate(current.response.observability, options.desired)) {
			return { status: "unchanged" as const, scriptName: options.scriptName }
		}
		const observability = mergeStateStoreObservability(
			current.response.observability,
			options.desired,
		)
		if (options.dryRun) {
			return { status: "would-update" as const, scriptName: options.scriptName, observability }
		}
		yield* options.patchSetting({
			accountId: options.accountId,
			scriptName: options.scriptName,
			observability,
		})
		return { status: "updated" as const, scriptName: options.scriptName, observability }
	})

export type SyncCliArgs = {
	readonly dryRun: boolean
	readonly scriptName: string
	readonly accountId: string | undefined
}

export const parseSyncCliArgs = (args: ReadonlyArray<string>): SyncCliArgs => {
	let dryRun = false
	let scriptName: string = DEFAULT_STATE_STORE_WORKER_NAME
	let accountId: string | undefined

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === undefined) {
			continue
		}
		if (arg === "--dry-run") {
			dryRun = true
		} else if (arg === "--worker-name") {
			const next = args[++i]
			if (!next || next.startsWith("--")) {
				throw new Error("Missing value for --worker-name")
			}
			scriptName = next
		} else if (arg.startsWith("--worker-name=")) {
			const value = arg.slice("--worker-name=".length)
			if (!value) {
				throw new Error("Missing value for --worker-name")
			}
			scriptName = value
		} else if (arg === "--account-id") {
			const next = args[++i]
			if (!next || next.startsWith("--")) {
				throw new Error("Missing value for --account-id")
			}
			accountId = next
		} else if (arg.startsWith("--account-id=")) {
			const value = arg.slice("--account-id=".length)
			if (!value) {
				throw new Error("Missing value for --account-id")
			}
			accountId = value
		} else {
			throw new Error(`Unknown argument: ${arg}`)
		}
	}

	return { dryRun, scriptName, accountId }
}

export class InvalidSyncCliArgs extends Data.TaggedError("InvalidSyncCliArgs")<{
	readonly message: string
}> {}

export const formatSyncStateStoreObservabilityResult = (
	result: SyncStateStoreObservabilityResult,
	desired: DesiredStateStoreObservability = CLOUDFLARE_STATE_OBSERVABILITY,
): string => {
	switch (result.status) {
		case "missing":
			return result.scriptName === DEFAULT_STATE_STORE_WORKER_NAME
				? `State store Worker '${result.scriptName}' does not exist or has no deployed versions; no settings were changed. When bootstrapped in this account via \`alchemy state bootstrap\` or a deploy with bootstrap enabled (pass \`--yes\` in CI), \`alchemy.run.ts\` configures it with invocationLogs=${String(desired.logs.invocationLogs)}.`
				: `State store Worker '${result.scriptName}' does not exist or has no deployed versions; no settings were changed (alchemy.run.ts targets '${DEFAULT_STATE_STORE_WORKER_NAME}', not '${result.scriptName}').`
		case "unchanged":
			return `State store Worker '${result.scriptName}' observability is already up to date (invocationLogs=${String(desired.logs.invocationLogs)}).`
		case "would-update":
			return `[dry-run] Would patch state store Worker '${result.scriptName}' observability to ${JSON.stringify(result.observability)}.`
		case "updated":
			return `Updated state store Worker '${result.scriptName}' observability (enabled=${String(desired.enabled)}, logs.enabled=${String(desired.logs.enabled)}, logs.invocationLogs=${String(desired.logs.invocationLogs)}).`
	}
}

export const makeSyncConfigLayer = (accountId: string | undefined) =>
	accountId === undefined
		? Layer.empty
		: ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ CLOUDFLARE_ACCOUNT_ID: accountId }), {
				asPrimary: true,
			})

export const makeSyncCloudflareApiLayer = (accountId: string | undefined) => {
	const configLayer = makeSyncConfigLayer(accountId)
	return Cloudflare.CloudflareApiLive().pipe(
		Layer.provide(
			Layer.mergeAll(
				BunServices.layer,
				AuthProvidersLive,
				SecureRandom.layerWebCrypto,
				FetchHttpClient.layer,
				configLayer,
			),
		),
		Layer.provideMerge(configLayer),
	)
}

const main = Effect.gen(function* () {
	const parsed = yield* Effect.try({
		try: () => parseSyncCliArgs(argv.slice(2)),
		catch: (cause) =>
			new InvalidSyncCliArgs({
				message: cause instanceof Error ? cause.message : String(cause),
			}),
	})
	return yield* Effect.gen(function* () {
		const accountId = parsed.accountId ?? (yield* yield* Cloudflare.CloudflareEnvironment).accountId
		const result = yield* syncStateStoreObservability({
			accountId,
			scriptName: parsed.scriptName,
			desired: CLOUDFLARE_STATE_OBSERVABILITY,
			dryRun: parsed.dryRun,
			getSetting: workers.getScriptSetting,
			patchSetting: workers.patchScriptSetting,
		})
		yield* Console.log(formatSyncStateStoreObservabilityResult(result))
	}).pipe(Effect.provide(makeSyncCloudflareApiLayer(parsed.accountId)))
})

const isDirectEntry = argv[1] !== undefined && NodePath.resolve(argv[1]) === import.meta.filename

if (isDirectEntry) {
	try {
		await Effect.runPromise(main)
	} catch (error: unknown) {
		stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
		exit(1)
	}
}
