import * as Cloudflare from "@alchemy.run/cloudflare"
import { Random } from "alchemy/Random"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Mac from "effect/crypto/Mac"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as Hex from "effect/encoding/Hex"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"

export const WebhookSigningSecret = Random("WebhookSigningSecret")

export const WEBHOOK_SECRET_PREFIX = "whsec_"
export const DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300

export const STANDARD_WEBHOOK_HEADERS = {
	id: "webhook-id",
	timestamp: "webhook-timestamp",
	signature: "webhook-signature",
} as const

export interface WebhookSigningMasterKeyService {
	readonly key: Effect.Effect<Mac.Key>
}

export class WebhookSigningMasterKey extends Context.Service<
	WebhookSigningMasterKey,
	WebhookSigningMasterKeyService
>()("@checkfu/api/WebhookSigningMasterKey") {}

const utf8 = new TextEncoder()

export const makeWebhookMasterKey = (secret: string): Effect.Effect<Mac.Key> =>
	Mac.key(Mac.hmacSha256, utf8.encode(secret)).pipe(Effect.orDie)

export const webhookSigningMasterKeyFor = (secret: string) =>
	Layer.effect(
		WebhookSigningMasterKey,
		Effect.map(makeWebhookMasterKey(secret), (key) => ({ key: Effect.succeed(key) })),
	)

export const TEST_WEBHOOK_SIGNING_MASTER_KEY = "test-webhook-signing-master-key"

export const WebhookSigningMasterKeyTest = webhookSigningMasterKeyFor(
	TEST_WEBHOOK_SIGNING_MASTER_KEY,
)

export const WebhookSigningMasterKeyLive = Layer.effect(
	WebhookSigningMasterKey,
	Effect.gen(function* () {
		const secret = yield* (yield* WebhookSigningSecret).text
		const runtime = yield* Cloudflare.Worker
		const resolved = yield* Effect.cached(
			Effect.gen(function* () {
				return yield* makeWebhookMasterKey(Redacted.value(yield* secret))
			}).pipe(Effect.provideService(RuntimeContext, runtime), Effect.orDie),
		)
		return { key: resolved }
	}),
)

export const newWebhookSecretSalt = (
	random: SecureRandom.SecureRandom["Service"],
): Effect.Effect<string> => Effect.map(random.randomBytes(16), (bytes) => Hex.encode(bytes))

export interface DeriveWebhookSecretInput {
	readonly webhookId: string
	readonly secretRevision: number
	readonly secretSalt: string
}

export const deriveWebhookSigningSecret = (
	mac: Mac.Mac["Service"],
	masterKey: Mac.Key,
	input: DeriveWebhookSecretInput,
): Effect.Effect<string> =>
	Effect.map(
		mac
			.sign(
				masterKey,
				utf8.encode(
					`checkfu.webhook.secret.v1:${input.webhookId}:${input.secretRevision}:${input.secretSalt}`,
				),
			)
			.pipe(Effect.orDie),
		(bytes) => `${WEBHOOK_SECRET_PREFIX}${Base64.encode(bytes)}`,
	)

const decodeSigningSecretBytes = (secret: string): Uint8Array | null => {
	const encoded = secret.startsWith(WEBHOOK_SECRET_PREFIX)
		? secret.slice(WEBHOOK_SECRET_PREFIX.length)
		: secret
	if (encoded.length === 0) {
		return null
	}
	const decoded = Base64.decode(encoded)
	return Result.isSuccess(decoded) && decoded.success.byteLength > 0 ? decoded.success : null
}

const signedContentOf = (
	webhookId: string,
	timestampSeconds: number,
	payload: string,
): Uint8Array => utf8.encode(`${webhookId}.${timestampSeconds}.${payload}`)

export interface SignStandardWebhookInput {
	readonly secrets: ReadonlyArray<string>
	readonly webhookId: string
	readonly timestampSeconds: number
	readonly payload: string
}

export const signStandardWebhook = (
	mac: Mac.Mac["Service"],
	input: SignStandardWebhookInput,
): Effect.Effect<string> =>
	Effect.gen(function* () {
		const content = signedContentOf(input.webhookId, input.timestampSeconds, input.payload)
		const signatures: Array<string> = []
		for (const secret of input.secrets) {
			const bytes = decodeSigningSecretBytes(secret)
			if (bytes === null) {
				return yield* Effect.die(new Error("Invalid webhook signing secret."))
			}
			const key = yield* Mac.key(Mac.hmacSha256, bytes).pipe(Effect.orDie)
			const tag = yield* mac.sign(key, content).pipe(Effect.orDie)
			signatures.push(`v1,${Base64.encode(tag)}`)
		}
		return signatures.join(" ")
	})

export interface VerifyStandardWebhookInput {
	readonly secret: string
	readonly webhookId: string
	readonly timestampSeconds: number
	readonly signatureHeader: string
	readonly payload: string
	readonly nowSeconds?: number
	readonly toleranceSeconds?: number
}

export const verifyStandardWebhook = (
	mac: Mac.Mac["Service"],
	input: VerifyStandardWebhookInput,
): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		if (!Number.isInteger(input.timestampSeconds) || input.timestampSeconds < 0) {
			return false
		}
		const nowSeconds = input.nowSeconds ?? Math.floor((yield* Clock.currentTimeMillis) / 1000)
		const tolerance = input.toleranceSeconds ?? DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
		if (Math.abs(nowSeconds - input.timestampSeconds) > tolerance) {
			return false
		}
		const bytes = decodeSigningSecretBytes(input.secret)
		if (bytes === null) {
			return false
		}
		const key = yield* Mac.key(Mac.hmacSha256, bytes).pipe(Effect.orDie)
		const content = signedContentOf(input.webhookId, input.timestampSeconds, input.payload)
		const tokens = input.signatureHeader
			.trim()
			.split(/\s+/)
			.filter((token) => token.length > 0)
		for (const token of tokens) {
			const comma = token.indexOf(",")
			if (comma === -1 || token.slice(0, comma) !== "v1") {
				continue
			}
			const decodedTag = Base64.decode(token.slice(comma + 1))
			if (Result.isFailure(decodedTag)) {
				continue
			}
			const valid = yield* mac
				.verify(key, decodedTag.success, content)
				.pipe(Effect.orElseSucceed(() => false))
			if (valid) {
				return true
			}
		}
		return false
	})
