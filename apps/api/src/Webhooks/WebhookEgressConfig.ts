import { parsePublicHttpsWebhookUrl } from "@checkfu/domain/Webhook/WebhookUrl"
import { parseLoopbackBaseUrl } from "@checkfu/pi-providers/fetch"
import { AlchemyContext } from "alchemy/AlchemyContext"
import { Stage } from "alchemy/Stage"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"

export const WEBHOOK_EGRESS_URL_ENV = "CHECKFU_WEBHOOK_EGRESS_URL"
export const WEBHOOK_EGRESS_TOKEN_ENV = "CHECKFU_WEBHOOK_EGRESS_TOKEN"
export const WEBHOOK_LOCAL_DEV_ENV = "CHECKFU_WEBHOOK_LOCAL_DEV"
export const WEBHOOK_LOCAL_DEV_VALUE = "local-dev"

export const WEBHOOK_EGRESS_TARGET_HEADER = "x-checkfu-egress-target"
export const WEBHOOK_EGRESS_TIMEOUT_HEADER = "x-checkfu-egress-timeout-ms"

export interface WebhookEgressConfig {
	readonly egressUrl: string | null
	readonly egressToken: Redacted.Redacted<string> | null
	readonly localDev: boolean
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
				`Invalid ${WEBHOOK_EGRESS_URL_ENV}: must use https:// (loopback http:// is allowed only in local dev).`,
			)
		}
		return parseLoopbackBaseUrl(trimmed, WEBHOOK_EGRESS_URL_ENV)
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
 * - Marks local Alchemy dev (`CHECKFU_WEBHOOK_LOCAL_DEV="local-dev"`) so the
 *   deliverer refuses direct `fetch()` through Alchemy's private-permitting
 *   `InternetLive` unless a public-only egress URL is configured.
 * - Forwards optional `CHECKFU_WEBHOOK_EGRESS_URL` and secret
 *   `CHECKFU_WEBHOOK_EGRESS_TOKEN` when configured.
 */
export const apiWorkerWebhookEgressProps = Effect.gen(function* () {
	const alchemyContext = yield* Effect.serviceOption(AlchemyContext)
	if (Option.isNone(alchemyContext)) {
		return {}
	}
	const stage = yield* Effect.serviceOption(Stage)
	const localDev =
		alchemyContext.value.dev && !(Option.isSome(stage) && stage.value === "production")
	const rawUrl = yield* optionalTrimmedString(WEBHOOK_EGRESS_URL_ENV)
	const token = yield* optionalTrimmedSecret(WEBHOOK_EGRESS_TOKEN_ENV)
	const env: Record<string, string | Redacted.Redacted<string>> = {}
	if (localDev) {
		env[WEBHOOK_LOCAL_DEV_ENV] = WEBHOOK_LOCAL_DEV_VALUE
	}
	if (rawUrl !== null) {
		env[WEBHOOK_EGRESS_URL_ENV] = parseWebhookEgressUrl(rawUrl, { allowLoopbackHttp: localDev })
	}
	if (token !== null) {
		env[WEBHOOK_EGRESS_TOKEN_ENV] = token
	}
	return Object.keys(env).length === 0 ? {} : { env }
}).pipe(Effect.orDie)

export const readWebhookEgressConfig: Effect.Effect<WebhookEgressConfig> = Effect.gen(function* () {
	const runtimeStage = yield* optionalTrimmedString("ALCHEMY_STAGE")
	const localSignal = yield* optionalTrimmedString(WEBHOOK_LOCAL_DEV_ENV)
	const localDev = runtimeStage !== "production" && localSignal === WEBHOOK_LOCAL_DEV_VALUE
	const rawUrl = yield* optionalTrimmedString(WEBHOOK_EGRESS_URL_ENV)
	const egressToken = yield* optionalTrimmedSecret(WEBHOOK_EGRESS_TOKEN_ENV)
	const egressUrl =
		rawUrl === null ? null : parseWebhookEgressUrl(rawUrl, { allowLoopbackHttp: localDev })
	return { egressUrl, egressToken, localDev }
}).pipe(Effect.orDie)
