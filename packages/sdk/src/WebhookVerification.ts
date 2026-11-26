import * as Schema from "effect/Schema"
import { WebhookEventType } from "./Schemas.ts"

export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300

export const WebhookEventData = Schema.Struct({
	type: WebhookEventType,
	id: Schema.String,
	vault_id: Schema.optionalKey(Schema.String),
	automation_id: Schema.optionalKey(Schema.String),
})
export type WebhookEventData = typeof WebhookEventData.Type

export const WebhookEventEnvelope = Schema.Struct({
	type: Schema.Literal("event"),
	id: Schema.String,
	created_at: Schema.String,
	data: WebhookEventData,
})
export type WebhookEventEnvelope = typeof WebhookEventEnvelope.Type

const decodeEnvelope = Schema.decodeUnknownSync(WebhookEventEnvelope)
const utf8 = new TextEncoder()

export type WebhookHeaderBag =
	| Headers
	| Readonly<Record<string, string | ReadonlyArray<string> | undefined>>

const isHeadersBag = (headers: WebhookHeaderBag): headers is Headers =>
	"get" in headers && typeof headers.get === "function"

const readHeader = (headers: WebhookHeaderBag, name: string): string | null => {
	if (isHeadersBag(headers)) {
		return headers.get(name)
	}
	const target = name.toLowerCase()
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === target) {
			if (typeof value === "string") {
				return value
			}
			if (Array.isArray(value) && typeof value[0] === "string") {
				return value[0]
			}
		}
	}
	return null
}

const decodeBase64 = (encoded: string): Uint8Array<ArrayBuffer> | null => {
	try {
		const binary = atob(encoded)
		const out = new Uint8Array(new ArrayBuffer(binary.length))
		for (let index = 0; index < binary.length; index++) {
			out[index] = binary.charCodeAt(index)
		}
		return out
	} catch {
		return null
	}
}

const decodeSecretKeyBytes = (secret: string): Uint8Array<ArrayBuffer> | null => {
	const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret
	if (raw.length === 0) {
		return null
	}
	const bytes = decodeBase64(raw)
	return bytes !== null && bytes.byteLength > 0 ? bytes : null
}

export interface VerifyWebhookOptions {
	readonly secret: string
	readonly nowSeconds?: number
	readonly toleranceSeconds?: number
}

/**
 * Verifies a Standard Webhooks HMAC-SHA256 signature (`v1,<base64>`) and checks
 * timestamp freshness (5-minute replay window by default). Supports multiple
 * space-separated signatures emitted during signing secret rotation grace periods.
 */
export const verifyWebhookSignature = async (
	payload: string | Uint8Array,
	headers: WebhookHeaderBag,
	options: VerifyWebhookOptions,
): Promise<boolean> => {
	const webhookId = readHeader(headers, "webhook-id")
	const timestampRaw = readHeader(headers, "webhook-timestamp")
	const signatureHeader = readHeader(headers, "webhook-signature")
	if (
		webhookId === null ||
		webhookId.length === 0 ||
		timestampRaw === null ||
		signatureHeader === null
	) {
		return false
	}
	if (!/^\d+$/u.test(timestampRaw.trim())) {
		return false
	}
	const timestampSeconds = Number(timestampRaw.trim())
	const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
	const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS
	if (
		!Number.isFinite(timestampSeconds) ||
		Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds
	) {
		return false
	}
	const keyBytes = decodeSecretKeyBytes(options.secret)
	if (keyBytes === null) {
		return false
	}
	const bodyText = typeof payload === "string" ? payload : new TextDecoder().decode(payload)
	const signedBytes = utf8.encode(`${webhookId}.${timestampSeconds}.${bodyText}`)
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	)
	for (const token of signatureHeader.trim().split(/\s+/u)) {
		if (!token.startsWith("v1,")) {
			continue
		}
		const candidate = decodeBase64(token.slice(3))
		if (candidate === null) {
			continue
		}
		const valid = await crypto.subtle.verify("HMAC", cryptoKey, candidate, signedBytes)
		if (valid) {
			return true
		}
	}
	return false
}

/**
 * Verifies the Standard Webhooks signature and replay window, then decodes and
 * returns the typed webhook event envelope.
 */
export const unwrapWebhookEvent = async (
	payload: string | Uint8Array,
	headers: WebhookHeaderBag,
	options: VerifyWebhookOptions,
): Promise<WebhookEventEnvelope> => {
	const valid = await verifyWebhookSignature(payload, headers, options)
	if (!valid) {
		throw new Error("Invalid webhook signature or expired timestamp.")
	}
	const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload)
	return decodeEnvelope(JSON.parse(text))
}
