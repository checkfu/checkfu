import { DatabaseSync } from "node:sqlite"
import type { WebhookEndpointState } from "@checkfu/domain/Webhook/WebhookEndpoint.aggregate"
import { SUSTAINED_FAILURE_DISABLE_WINDOW_MS } from "@checkfu/domain/Webhook/WebhookTypes"
import { WebhookDeliveryId, WebhookEventId, WebhookId } from "@checkfu/sdk/Schemas"
import { describe, expect, it } from "@effect/vitest"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as TestClock from "effect/testing/TestClock"
import {
	WEBHOOK_MAX_ATTEMPTS,
	WEBHOOK_MAX_STORED_DELIVERIES,
	WEBHOOK_RETENTION_MS,
	WEBHOOK_RETRY_DELAYS_MS,
	WebhookDeliveryEngine,
} from "../src/Webhooks/WebhookDeliveryEngine.ts"
import type {
	WebhookHttpRequest,
	WebhookHttpResult,
	WebhookSqlStorage,
} from "../src/Webhooks/WebhookDeliveryEngine.ts"
import {
	STANDARD_WEBHOOK_HEADERS,
	deriveWebhookSigningSecret,
	makeWebhookMasterKey,
	verifyStandardWebhook,
} from "../src/Webhooks/WebhookSigning.ts"

const sqliteStorage = (db: DatabaseSync): WebhookSqlStorage => ({
	exec: (query, ...bindings) => {
		const stmt = db.prepare(query)
		const trimmed = query.trimStart().toUpperCase()
		if (trimmed.startsWith("SELECT")) {
			const rows = stmt.all(...bindings)
			return { toArray: () => rows }
		}
		stmt.run(...bindings)
		return { toArray: () => [] }
	},
})

const T0 = Date.parse("2026-01-01T00:00:00.000Z")

const activeEndpoint = (overrides: Partial<WebhookEndpointState> = {}): WebhookEndpointState => ({
	status: "active",
	url: "https://hooks.example.com/events",
	description: "Test sink",
	event_types: "*",
	definition_revision: 1,
	secret_revision: 1,
	secret_salt: "0123456789abcdef0123456789abcdef",
	previous_secret_revision: 0,
	previous_secret_salt: "",
	previous_secret_expires_at: 0,
	failure_window_started_at: 0,
	last_failure_at: 0,
	consecutive_failures: 0,
	created_at: T0,
	updated_at: T0,
	...overrides,
})

const CryptoLive = Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))

describe("WebhookDeliveryEngine (real SQLite)", () => {
	it.effect(
		"deduplicates enqueues, delivers signed payloads with zero health writes when healthy, and supports dual-secret rotation",
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				const db = new DatabaseSync(":memory:")
				const webhookId = WebhookId.make("whe_sqlite_1")
				const engine = new WebhookDeliveryEngine(webhookId, sqliteStorage(db))
				const mac = yield* Mac.Mac
				const masterKey = yield* makeWebhookMasterKey("sqlite-master")
				const endpoint = activeEndpoint({
					secret_revision: 2,
					secret_salt: "22222222222222222222222222222222",
					previous_secret_revision: 1,
					previous_secret_salt: "11111111111111111111111111111111",
					previous_secret_expires_at: T0 + 86_400_000,
				})
				const recordedOutcomes: Array<string> = []
				const sent: Array<WebhookHttpRequest> = []

				const first = engine.enqueue(
					{
						delivery_id: WebhookDeliveryId.make("wdel_1"),
						event_id: WebhookEventId.make("evt_1"),
						event_type: "session.status_idle",
						dedupe_key: "evt_1",
						payload_json: JSON.stringify({ id: "evt_1", type: "session.status_idle", data: {} }),
					},
					T0,
				)
				const duplicate = engine.enqueue(
					{
						delivery_id: WebhookDeliveryId.make("wdel_dup"),
						event_id: WebhookEventId.make("evt_1"),
						event_type: "session.status_idle",
						dedupe_key: "evt_1",
						payload_json: JSON.stringify({ id: "evt_1", type: "session.status_idle", data: {} }),
					},
					T0 + 10,
				)
				expect(duplicate.record.id).toBe(first.record.id)
				expect(first.nextAlarmAt).toBe(T0)

				const drain = yield* engine.drainDue({
					readEndpoint: Effect.succeed(endpoint),
					recordOutcome: (input) =>
						Effect.sync(() => {
							recordedOutcomes.push(input.outcome)
							return endpoint
						}),
					mac,
					masterKey: Effect.succeed(masterKey),
					sender: {
						send: (req) =>
							Effect.sync(() => {
								sent.push(req)
								return { kind: "response", status: 200 }
							}),
					},
				})

				expect(drain).toEqual({ processed: 1, purged: false, nextAlarmAt: null })
				expect(recordedOutcomes).toEqual([])
				expect(sent).toHaveLength(1)

				const currentSecret = yield* deriveWebhookSigningSecret(mac, masterKey, {
					webhookId,
					secretRevision: 2,
					secretSalt: endpoint.secret_salt,
				})
				const prevSecret = yield* deriveWebhookSigningSecret(mac, masterKey, {
					webhookId,
					secretRevision: 1,
					secretSalt: endpoint.previous_secret_salt,
				})
				const req = sent[0]!
				const sig = req.headers[STANDARD_WEBHOOK_HEADERS.signature] ?? ""
				const ts = Number(req.headers[STANDARD_WEBHOOK_HEADERS.timestamp] ?? "0")
				expect(
					yield* verifyStandardWebhook(mac, {
						secret: currentSecret,
						webhookId: "wdel_1",
						timestampSeconds: ts,
						signatureHeader: sig,
						payload: req.body,
					}),
				).toBe(true)
				expect(
					yield* verifyStandardWebhook(mac, {
						secret: prevSecret,
						webhookId: "wdel_1",
						timestampSeconds: ts,
						signatureHeader: sig,
						payload: req.body,
					}),
				).toBe(true)

				// Once grace expires, only the current secret is sent.
				yield* TestClock.setTime(T0 + 86_400_000 + 1000)
				engine.enqueue(
					{
						delivery_id: WebhookDeliveryId.make("wdel_2"),
						event_id: WebhookEventId.make("evt_2"),
						event_type: "session.status_idle",
						dedupe_key: "evt_2",
						payload_json: JSON.stringify({ id: "evt_2", type: "session.status_idle", data: {} }),
					},
					T0 + 86_400_000 + 1000,
				)
				yield* engine.drainDue({
					readEndpoint: Effect.succeed(endpoint),
					recordOutcome: () => Effect.succeed(endpoint),
					mac,
					masterKey: Effect.succeed(masterKey),
					sender: {
						send: (request) =>
							Effect.sync(() => {
								sent.push(request)
								return { kind: "response", status: 204 }
							}),
					},
				})
				const postGrace = sent[1]!
				expect(
					yield* verifyStandardWebhook(mac, {
						secret: currentSecret,
						webhookId: "wdel_2",
						timestampSeconds: Number(postGrace.headers[STANDARD_WEBHOOK_HEADERS.timestamp] ?? "0"),
						signatureHeader: postGrace.headers[STANDARD_WEBHOOK_HEADERS.signature] ?? "",
						payload: postGrace.body,
					}),
				).toBe(true)
				expect(
					yield* verifyStandardWebhook(mac, {
						secret: prevSecret,
						webhookId: "wdel_2",
						timestampSeconds: Number(postGrace.headers[STANDARD_WEBHOOK_HEADERS.timestamp] ?? "0"),
						signatureHeader: postGrace.headers[STANDARD_WEBHOOK_HEADERS.signature] ?? "",
						payload: postGrace.body,
					}),
				).toBe(false)
				db.close()
			}).pipe(Effect.provide(CryptoLive)),
	)

	it.effect(
		"retries with exponential backoff up to max_attempts, records recovery on 2xx, and supports redeliver",
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				const db = new DatabaseSync(":memory:")
				const webhookId = WebhookId.make("whe_retry")
				const engine = new WebhookDeliveryEngine(webhookId, sqliteStorage(db))
				const mac = yield* Mac.Mac
				const masterKey = yield* makeWebhookMasterKey("retry-master")
				let endpoint = activeEndpoint()
				const outcomes: Array<string> = []
				let nextResult: WebhookHttpResult = { kind: "response", status: 500 }

				engine.enqueue(
					{
						delivery_id: WebhookDeliveryId.make("wdel_fail"),
						event_id: WebhookEventId.make("evt_fail"),
						event_type: "agent.created",
						dedupe_key: "evt_fail",
						payload_json: JSON.stringify({ id: "evt_fail", type: "agent.created", data: {} }),
					},
					T0,
				)

				const runDrain = () =>
					engine.drainDue({
						readEndpoint: Effect.sync(() => endpoint),
						recordOutcome: (input) =>
							Effect.sync(() => {
								outcomes.push(input.outcome)
								if (input.outcome === "failed") {
									endpoint = {
										...endpoint,
										failure_window_started_at:
											endpoint.failure_window_started_at === 0
												? input.observed_at
												: endpoint.failure_window_started_at,
										last_failure_at: input.observed_at,
										consecutive_failures: endpoint.consecutive_failures + 1,
									}
								} else if (input.outcome === "delivered") {
									endpoint = {
										...endpoint,
										failure_window_started_at: 0,
										last_failure_at: 0,
										consecutive_failures: 0,
									}
								}
								return endpoint
							}),
						mac,
						masterKey: Effect.succeed(masterKey),
						sender: { send: () => Effect.succeed(nextResult) },
					})

				let now = T0
				for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
					const res = yield* runDrain()
					expect(res.processed).toBe(1)
					const expectedDelay = WEBHOOK_RETRY_DELAYS_MS[attempt - 1] ?? null
					if (expectedDelay !== null) {
						expect(res.nextAlarmAt).toBe(now + expectedDelay)
						now += expectedDelay
						yield* TestClock.setTime(now)
					} else {
						expect(res.nextAlarmAt).toBeNull()
					}
				}

				const exhausted = engine.getDelivery(WebhookDeliveryId.make("wdel_fail"))
				expect(exhausted?.status).toBe("failed")
				expect(exhausted?.attempt_count).toBe(WEBHOOK_MAX_ATTEMPTS)
				expect(exhausted?.last_outcome).toBe("http_5xx")
				expect(outcomes).toHaveLength(WEBHOOK_MAX_ATTEMPTS)

				// Redeliver with 200 succeeds and reports "delivered" to clear the failure window.
				nextResult = { kind: "response", status: 200 }
				const redelivered = engine.redeliver(
					WebhookDeliveryId.make("wdel_fail"),
					WebhookDeliveryId.make("wdel_retry_ok"),
					now + 1000,
				)
				expect(redelivered?.record.id).toBe("wdel_retry_ok")
				yield* TestClock.setTime(now + 1000)
				const okDrain = yield* runDrain()
				expect(okDrain).toEqual({ processed: 1, purged: false, nextAlarmAt: null })
				expect(outcomes.at(-1)).toBe("delivered")
				expect(endpoint.failure_window_started_at).toBe(0)
				expect(engine.getDelivery(WebhookDeliveryId.make("wdel_fail"))?.status).toBe("failed")
				expect(engine.getDelivery(WebhookDeliveryId.make("wdel_retry_ok"))?.status).toBe(
					"succeeded",
				)
				db.close()
			}).pipe(Effect.provide(CryptoLive)),
	)

	it.effect(
		"disables on redirect, skips queued rows, self-purges on delete, and enforces 500-row / 14d retention + pagination",
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				const db = new DatabaseSync(":memory:")
				const webhookId = WebhookId.make("whe_ops")
				const engine = new WebhookDeliveryEngine(webhookId, sqliteStorage(db))
				const mac = yield* Mac.Mac
				const masterKey = yield* makeWebhookMasterKey("ops-master")
				let endpoint = activeEndpoint()

				engine.enqueue(
					{
						delivery_id: WebhookDeliveryId.make("wdel_a"),
						event_id: WebhookEventId.make("evt_a"),
						event_type: "agent.created",
						dedupe_key: "evt_a",
						payload_json: "{}",
					},
					T0,
				)
				engine.enqueue(
					{
						delivery_id: WebhookDeliveryId.make("wdel_b"),
						event_id: WebhookEventId.make("evt_b"),
						event_type: "agent.created",
						dedupe_key: "evt_b",
						payload_json: "{}",
					},
					T0 + 1,
				)

				const redirDrain = yield* engine.drainDue({
					readEndpoint: Effect.sync(() => endpoint),
					recordOutcome: (input) =>
						Effect.sync(() => {
							if (input.outcome === "redirect") {
								endpoint = { ...endpoint, status: "disabled_redirect" }
							}
							return endpoint
						}),
					mac,
					masterKey: Effect.succeed(masterKey),
					sender: { send: () => Effect.succeed({ kind: "response", status: 301 }) },
				})
				expect(redirDrain).toEqual({ processed: 1, purged: false, nextAlarmAt: null })
				expect(engine.getDelivery(WebhookDeliveryId.make("wdel_a"))?.status).toBe("failed")
				expect(engine.getDelivery(WebhookDeliveryId.make("wdel_b"))?.status).toBe("skipped")

				// Retention: cap at 500 rows and keyset paginate cleanly.
				endpoint = activeEndpoint({
					failure_window_started_at: 0,
					last_failure_at: 0,
					consecutive_failures: 0,
				})
				for (let i = 0; i < WEBHOOK_MAX_STORED_DELIVERIES + 20; i++) {
					const ts = T0 + 10_000 + i
					engine.enqueue(
						{
							delivery_id: WebhookDeliveryId.make(`wdel_cap_${String(i).padStart(4, "0")}`),
							event_id: WebhookEventId.make(`evt_cap_${i}`),
							event_type: "agent.created",
							dedupe_key: `evt_cap_${i}`,
							payload_json: "{}",
						},
						ts,
					)
				}
				const firstPage = engine.listDeliveries({ limit: 100 })
				expect(firstPage.data).toHaveLength(100)
				expect(firstPage.has_more).toBe(true)
				expect(firstPage.next_cursor).not.toBeNull()

				let totalListed = firstPage.data.length
				let cursor = firstPage.next_cursor
				while (cursor !== null) {
					const next = engine.listDeliveries({ after: cursor, limit: 100 })
					totalListed += next.data.length
					cursor = next.next_cursor
				}
				expect(totalListed).toBe(WEBHOOK_MAX_STORED_DELIVERIES)

				// Sustained failure past 14d prunes old non-pending rows and deleted endpoint purges all rows.
				yield* TestClock.setTime(T0 + WEBHOOK_RETENTION_MS + SUSTAINED_FAILURE_DISABLE_WINDOW_MS)
				endpoint = { ...endpoint, status: "deleted", secret_salt: "" }
				const purged = yield* engine.drainDue({
					readEndpoint: Effect.sync(() => endpoint),
					recordOutcome: () => Effect.succeed(endpoint),
					mac,
					masterKey: Effect.succeed(masterKey),
					sender: { send: () => Effect.succeed({ kind: "response", status: 200 }) },
				})
				expect(purged).toEqual({ processed: 0, purged: true, nextAlarmAt: null })
				expect(engine.listDeliveries({ limit: 50 }).data).toEqual([])
				db.close()
			}).pipe(Effect.provide(CryptoLive)),
	)
})
