import { describe, expect, it } from "@effect/vitest"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as TestClock from "effect/testing/TestClock"
import {
	WEBHOOK_SECRET_PREFIX,
	deriveWebhookSigningSecret,
	makeWebhookMasterKey,
	newWebhookSecretSalt,
	signStandardWebhook,
	verifyStandardWebhook,
} from "../src/Webhooks/WebhookSigning.ts"

const CryptoLive = Mac.layerWebCrypto.pipe(Layer.provideMerge(SecureRandom.layerWebCrypto))

describe("WebhookSigning (Standard Webhooks HMAC-SHA256)", () => {
	it.effect(
		"derives deterministic whsec_ secrets isolated by webhook id, revision, salt, and master key",
		() =>
			Effect.gen(function* () {
				const mac = yield* Mac.Mac
				const random = yield* SecureRandom.SecureRandom
				const masterA = yield* makeWebhookMasterKey("master-secret-a")
				const masterB = yield* makeWebhookMasterKey("master-secret-b")
				const salt1 = yield* newWebhookSecretSalt(random)
				const salt2 = yield* newWebhookSecretSalt(random)

				expect(salt1).toMatch(/^[0-9a-f]{32}$/)
				expect(salt1).not.toBe(salt2)

				const s1 = yield* deriveWebhookSigningSecret(mac, masterA, {
					webhookId: "whe_001",
					secretRevision: 1,
					secretSalt: salt1,
				})
				const s1Again = yield* deriveWebhookSigningSecret(mac, masterA, {
					webhookId: "whe_001",
					secretRevision: 1,
					secretSalt: salt1,
				})
				const sRev2 = yield* deriveWebhookSigningSecret(mac, masterA, {
					webhookId: "whe_001",
					secretRevision: 2,
					secretSalt: salt1,
				})
				const sOtherSalt = yield* deriveWebhookSigningSecret(mac, masterA, {
					webhookId: "whe_001",
					secretRevision: 1,
					secretSalt: salt2,
				})
				const sOtherId = yield* deriveWebhookSigningSecret(mac, masterA, {
					webhookId: "whe_002",
					secretRevision: 1,
					secretSalt: salt1,
				})
				const sOtherMaster = yield* deriveWebhookSigningSecret(mac, masterB, {
					webhookId: "whe_001",
					secretRevision: 1,
					secretSalt: salt1,
				})

				expect(s1.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true)
				expect(s1).toBe(s1Again)
				expect(new Set([s1, sRev2, sOtherSalt, sOtherId, sOtherMaster]).size).toBe(5)
			}).pipe(Effect.provide(CryptoLive)),
	)

	it.effect(
		"signs and verifies single and dual-secret rotation headers with replay tolerance",
		() =>
			Effect.gen(function* () {
				const mac = yield* Mac.Mac
				const master = yield* makeWebhookMasterKey("master-secret")
				const oldSecret = yield* deriveWebhookSigningSecret(mac, master, {
					webhookId: "whe_rot",
					secretRevision: 1,
					secretSalt: "0123456789abcdef0123456789abcdef",
				})
				const newSecret = yield* deriveWebhookSigningSecret(mac, master, {
					webhookId: "whe_rot",
					secretRevision: 2,
					secretSalt: "fedcba9876543210fedcba9876543210",
				})
				const thirdSecret = yield* deriveWebhookSigningSecret(mac, master, {
					webhookId: "whe_rot",
					secretRevision: 3,
					secretSalt: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				})

				const payload = JSON.stringify({ id: "evt_1", type: "session.status_idle", data: {} })
				const timestampSeconds = 1_767_225_600

				const dualHeader = yield* signStandardWebhook(mac, {
					secrets: [newSecret, oldSecret],
					webhookId: "wdel_1",
					timestampSeconds,
					payload,
				})
				expect(dualHeader.split(" ")).toHaveLength(2)
				expect(dualHeader.split(" ").every((part) => part.startsWith("v1,"))).toBe(true)

				expect(
					yield* verifyStandardWebhook(mac, {
						secret: newSecret,
						webhookId: "wdel_1",
						timestampSeconds,
						signatureHeader: dualHeader,
						payload,
						nowSeconds: timestampSeconds + 10,
					}),
				).toBe(true)
				expect(
					yield* verifyStandardWebhook(mac, {
						secret: oldSecret,
						webhookId: "wdel_1",
						timestampSeconds,
						signatureHeader: dualHeader,
						payload,
						nowSeconds: timestampSeconds + 10,
					}),
				).toBe(true)
				expect(
					yield* verifyStandardWebhook(mac, {
						secret: thirdSecret,
						webhookId: "wdel_1",
						timestampSeconds,
						signatureHeader: dualHeader,
						payload,
						nowSeconds: timestampSeconds + 10,
					}),
				).toBe(false)

				// Tampered payload, id, timestamp, or expired replay window must fail.
				expect(
					yield* verifyStandardWebhook(mac, {
						secret: newSecret,
						webhookId: "wdel_1",
						timestampSeconds,
						signatureHeader: dualHeader,
						payload: `${payload} `,
						nowSeconds: timestampSeconds + 10,
					}),
				).toBe(false)
				expect(
					yield* verifyStandardWebhook(mac, {
						secret: newSecret,
						webhookId: "wdel_other",
						timestampSeconds,
						signatureHeader: dualHeader,
						payload,
						nowSeconds: timestampSeconds + 10,
					}),
				).toBe(false)
				expect(
					yield* verifyStandardWebhook(mac, {
						secret: newSecret,
						webhookId: "wdel_1",
						timestampSeconds,
						signatureHeader: dualHeader,
						payload,
						nowSeconds: timestampSeconds + 301,
					}),
				).toBe(false)

				// By default (without nowSeconds), Clock enforces the 5-minute replay window.
				yield* TestClock.setTime((timestampSeconds + 10) * 1000)
				expect(
					yield* verifyStandardWebhook(mac, {
						secret: newSecret,
						webhookId: "wdel_1",
						timestampSeconds,
						signatureHeader: dualHeader,
						payload,
					}),
				).toBe(true)

				yield* TestClock.setTime((timestampSeconds + 301) * 1000)
				expect(
					yield* verifyStandardWebhook(mac, {
						secret: newSecret,
						webhookId: "wdel_1",
						timestampSeconds,
						signatureHeader: dualHeader,
						payload,
					}),
				).toBe(false)
			}).pipe(Effect.provide(CryptoLive)),
	)
})
