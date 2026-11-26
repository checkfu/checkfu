import { describe, expect, it } from "@effect/vitest"
import { unwrapWebhookEvent, verifyWebhookSignature } from "../src/WebhookVerification.ts"

const utf8 = new TextEncoder()

const sign = async (
	secret: string,
	id: string,
	timestamp: number,
	body: string,
): Promise<string> => {
	const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret
	const binary = atob(raw)
	const keyBytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		keyBytes[i] = binary.charCodeAt(i)
	}
	const key = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	)
	const mac = await crypto.subtle.sign("HMAC", key, utf8.encode(`${id}.${timestamp}.${body}`))
	let encoded = ""
	for (const byte of new Uint8Array(mac)) {
		encoded += String.fromCharCode(byte)
	}
	return `v1,${btoa(encoded)}`
}

const SECRET_A = `whsec_${btoa("checkfu-webhook-test-secret-alpha-01")}`
const SECRET_B = `whsec_${btoa("checkfu-webhook-test-secret-beta-002")}`

describe("SDK WebhookVerification", () => {
	it("verifies and unwraps valid Standard Webhooks payloads including vault_id and automation_id", async () => {
		const now = 1_770_000_000
		const body = JSON.stringify({
			type: "event",
			id: "evt_vault_credential_vcrd_1_1",
			created_at: "2026-02-02T00:00:00.000Z",
			data: {
				type: "vault_credential.created",
				id: "vcrd_1",
				vault_id: "vlt_1",
			},
		})
		const sig = await sign(SECRET_A, "evt_vault_credential_vcrd_1_1", now, body)
		const headers = new Headers({
			"Webhook-Id": "evt_vault_credential_vcrd_1_1",
			"Webhook-Timestamp": String(now),
			"Webhook-Signature": sig,
		})

		expect(
			await verifyWebhookSignature(body, headers, { secret: SECRET_A, nowSeconds: now + 30 }),
		).toBe(true)

		const unwrapped = await unwrapWebhookEvent(utf8.encode(body), headers, {
			secret: SECRET_A,
			nowSeconds: now + 30,
		})
		expect(unwrapped).toEqual({
			type: "event",
			id: "evt_vault_credential_vcrd_1_1",
			created_at: "2026-02-02T00:00:00.000Z",
			data: {
				type: "vault_credential.created",
				id: "vcrd_1",
				vault_id: "vlt_1",
			},
		})
	})

	it("accepts either signature during dual-secret rotation grace periods", async () => {
		const now = 1_770_000_000
		const body = JSON.stringify({
			type: "event",
			id: "evt_automation_auto_1_4",
			created_at: "2026-02-02T00:00:00.000Z",
			data: {
				type: "automation_run.succeeded",
				id: "arun_1",
				automation_id: "auto_1",
			},
		})
		const sigA = await sign(SECRET_A, "evt_automation_auto_1_4", now, body)
		const sigB = await sign(SECRET_B, "evt_automation_auto_1_4", now, body)
		const headers = {
			"webhook-id": "evt_automation_auto_1_4",
			"webhook-timestamp": String(now),
			"webhook-signature": `${sigB} ${sigA}`,
		}

		expect(await verifyWebhookSignature(body, headers, { secret: SECRET_A, nowSeconds: now })).toBe(
			true,
		)
		const unwrapped = await unwrapWebhookEvent(body, headers, {
			secret: SECRET_B,
			nowSeconds: now,
		})
		expect(unwrapped.data.type).toBe("automation_run.succeeded")
		expect(unwrapped.data.automation_id).toBe("auto_1")
	})

	it("rejects tampered payloads, mismatched secrets, and expired timestamps", async () => {
		const now = 1_770_000_000
		const body = JSON.stringify({
			type: "event",
			id: "evt_webhook_whe_1_1",
			created_at: "2026-02-02T00:00:00.000Z",
			data: { type: "webhook.test", id: "whe_1" },
		})
		const sig = await sign(SECRET_A, "evt_webhook_whe_1_1", now, body)
		const headers = {
			"webhook-id": "evt_webhook_whe_1_1",
			"webhook-timestamp": String(now),
			"webhook-signature": sig,
		}

		expect(await verifyWebhookSignature(body, headers, { secret: SECRET_B, nowSeconds: now })).toBe(
			false,
		)
		expect(
			await verifyWebhookSignature(`${body} `, headers, { secret: SECRET_A, nowSeconds: now }),
		).toBe(false)
		expect(
			await verifyWebhookSignature(body, headers, {
				secret: SECRET_A,
				nowSeconds: now + 301,
			}),
		).toBe(false)
		await expect(
			unwrapWebhookEvent(body, headers, { secret: SECRET_A, nowSeconds: now + 301 }),
		).rejects.toThrow(/Invalid webhook signature/)
	})
})
