import { parsePublicHttpsWebhookUrl } from "@checkfu/domain/Webhook/WebhookUrl"
import { AlchemyContext } from "alchemy/AlchemyContext"
import { Stage } from "alchemy/Stage"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"

export const WEBHOOK_EGRESS_URL_ENV = "CHECKFU_WEBHOOK_EGRESS_URL"
export const WEBHOOK_EGRESS_TOKEN_ENV = "CHECKFU_WEBHOOK_EGRESS_TOKEN"
export const WEBHOOK_LOCAL_RUNTIME_ENV = "CHECKFU_WEBHOOK_LOCAL_RUNTIME"
export const WEBHOOK_LOCAL_RUNTIME_VALUE = "local-workerd"

export const WEBHOOK_EGRESS_TARGET_HEADER = "x-checkfu-egress-target"
export const WEBHOOK_EGRESS_TIMEOUT_HEADER = "x-checkfu-egress-timeout-ms"

export interface WebhookEgressConfig {
	readonly egressUrl: string | null
	readonly egressToken: Redacted.Redacted<string> | null
	readonly localRuntime: boolean
}

const optionalTrimmedString = (name: string): Config.Config<string | null> =>
	Config.option(Config.String(name)).pipe(
		Config.map((value) =>
			value.pipe(
				Option.map((raw) => raw.trim()),
				Option.filter((trimmed) => trimmed.length > 0),
				Option.getOrNull,
			),
		),
	)

const optionalTrimmedSecret = (name: string): Config.Config<Redacted.Redacted<string> | null> =>
	Config.option(Config.Redacted(name)).pipe(
		Config.map((value) =>
			value.pipe(
				Option.map((secret) => Redacted.value(secret).trim()),
				Option.filter((trimmed) => trimmed.length > 0),
				Option.map((trimmed) => Redacted.make(trimmed)),
				Option.getOrNull,
			),
		),
	)

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

const parseLoopbackHttpEgressUrl = (parsed: URL): string => {
	if (
		parsed.username.length > 0 ||
		parsed.password.length > 0 ||
		parsed.hash.length > 0 ||
		!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
	) {
		throw new TypeError(
			`Invalid ${WEBHOOK_EGRESS_URL_ENV}: local http:// egress URL must target loopback (127.0.0.1, localhost, or [::1]) without credentials or fragments.`,
		)
	}
	return parsed.toString()
}

export const parseWebhookEgressUrl = (
	raw: string,
	options: { readonly allowLoopbackHttp: boolean },
): string => {
	const trimmed = raw.trim()
	let parsed: URL
	try {
		parsed = new URL(trimmed)
	} catch {
		throw new TypeError(`Invalid ${WEBHOOK_EGRESS_URL_ENV}: must be a valid URL.`)
	}
	if (parsed.protocol === "http:") {
		if (!options.allowLoopbackHttp) {
			throw new TypeError(
				`Invalid ${WEBHOOK_EGRESS_URL_ENV}: must use https:// (loopback http:// is allowed only in local non-production dev).`,
			)
		}
		return parseLoopbackHttpEgressUrl(parsed)
	}
	const canonical = parsePublicHttpsWebhookUrl(trimmed)
	if (canonical === null) {
		throw new TypeError(
			`Invalid ${WEBHOOK_EGRESS_URL_ENV}: must be a public https:// URL without credentials or fragments.`,
		)
	}
	return canonical
}

/**
 * Plan-time Worker props for `ApiWorker`:
 * - Marks EVERY local Alchemy runtime (`alchemyContext.dev === true`, regardless
 *   of stage name) via `CHECKFU_WEBHOOK_LOCAL_RUNTIME="local-workerd"` so the
 *   deliverer refuses direct `fetch()` through local `workerd`'s private-permitting
 *   egress unless a public-only egress URL is configured.
 * - Keeps the rule for allowing a loopback `http://` proxy URL separate: allowed
 *   only in local non-production stages.
 */
export const apiWorkerWebhookEgressProps = Effect.gen(function* () {
	const alchemyContext = yield* Effect.serviceOption(AlchemyContext)
	if (Option.isNone(alchemyContext)) {
		return {}
	}
	const stage = yield* Effect.serviceOption(Stage)
	const localRuntime = alchemyContext.value.dev
	const allowLoopbackHttp = localRuntime && !(Option.isSome(stage) && stage.value === "production")
	const rawUrl = yield* optionalTrimmedString(WEBHOOK_EGRESS_URL_ENV)
	const token = yield* optionalTrimmedSecret(WEBHOOK_EGRESS_TOKEN_ENV)
	const env: Record<string, string | Redacted.Redacted<string>> = {}
	if (localRuntime) {
		env[WEBHOOK_LOCAL_RUNTIME_ENV] = WEBHOOK_LOCAL_RUNTIME_VALUE
	}
	if (rawUrl !== null) {
		env[WEBHOOK_EGRESS_URL_ENV] = parseWebhookEgressUrl(rawUrl, { allowLoopbackHttp })
	}
	if (token !== null) {
		env[WEBHOOK_EGRESS_TOKEN_ENV] = token
	}
	return Object.keys(env).length === 0 ? {} : { env }
}).pipe(Effect.orDie)

export const readWebhookEgressConfig: Effect.Effect<WebhookEgressConfig> = Effect.gen(function* () {
	const runtimeStage = yield* optionalTrimmedString("ALCHEMY_STAGE")
	const localSignal = yield* optionalTrimmedString(WEBHOOK_LOCAL_RUNTIME_ENV)
	const localRuntime = localSignal === WEBHOOK_LOCAL_RUNTIME_VALUE
	const allowLoopbackHttp = localRuntime && runtimeStage !== "production"
	const rawUrl = yield* optionalTrimmedString(WEBHOOK_EGRESS_URL_ENV)
	const egressToken = yield* optionalTrimmedSecret(WEBHOOK_EGRESS_TOKEN_ENV)
	const egressUrl = rawUrl === null ? null : parseWebhookEgressUrl(rawUrl, { allowLoopbackHttp })
	return { egressUrl, egressToken, localRuntime }
}).pipe(Effect.orDie)
