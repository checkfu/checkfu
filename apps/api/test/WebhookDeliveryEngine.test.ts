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
	WEBHOOK_MAX_PENDING_DELIVERIES,
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
	transaction: (fn) => {
		db.exec("BEGIN IMMEDIATE")
		try {
			const result = fn()
			db.exec("COMMIT")
			return result
		} catch (error) {
			db.exec("ROLLBACK")
			throw error
		}
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
	it.each(["status", "attempt_count"] as const)("rejects a malformed stored %s", (column) => {
		const db = new DatabaseSync(":memory:")
		try {
			const engine = new WebhookDeliveryEngine(WebhookId.make("whe_invalid"), sqliteStorage(db))
			engine.enqueue(
				{
					delivery_id: WebhookDeliveryId.make("wdel_1"),
					event_id: WebhookEventId.make("evt_1"),
					event_type: "session.status_idle",
					dedupe_key: "evt_1",
					payload_json: "{}",
				},
				T0,
			)
			db.exec(`UPDATE webhook_deliveries SET ${column} = 'invalid'`)
			expect(() => engine.listDeliveries({})).toThrow(column)
		} finally {
			db.close()
		}
	})

	it.effect(
		"deduplicates enqueues, delivers signed payloads with zero health writes when healthy, supports dual-secret rotation, and schedules idle 14d retention cleanup",
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

				expect(drain).toEqual({
					processed: 1,
					purged: false,
					nextAlarmAt: T0 + WEBHOOK_RETENTION_MS,
				})
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
				expect(req.headers[STANDARD_WEBHOOK_HEADERS.id]).toBe("evt_1")
				expect(
					yield* verifyStandardWebhook(mac, {
						secret: currentSecret,
						webhookId: "evt_1",
						timestampSeconds: ts,
						signatureHeader: sig,
						payload: req.body,
					}),
				).toBe(true)
				expect(
					yield* verifyStandardWebhook(mac, {
						secret: prevSecret,
						webhookId: "evt_1",
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
				expect(postGrace.headers[STANDARD_WEBHOOK_HEADERS.id]).toBe("evt_2")
				expect(
					yield* verifyStandardWebhook(mac, {
						secret: currentSecret,
						webhookId: "evt_2",
						timestampSeconds: Number(postGrace.headers[STANDARD_WEBHOOK_HEADERS.timestamp] ?? "0"),
						signatureHeader: postGrace.headers[STANDARD_WEBHOOK_HEADERS.signature] ?? "",
						payload: postGrace.body,
					}),
				).toBe(true)
				expect(
					yield* verifyStandardWebhook(mac, {
						secret: prevSecret,
						webhookId: "evt_2",
						timestampSeconds: Number(postGrace.headers[STANDARD_WEBHOOK_HEADERS.timestamp] ?? "0"),
						signatureHeader: postGrace.headers[STANDARD_WEBHOOK_HEADERS.signature] ?? "",
						payload: postGrace.body,
					}),
				).toBe(false)

				// When idle past 14d retention, reads immediately enforce expiry AND the retention alarm clears storage.
				const afterAllExpired = T0 + 86_400_000 + 1000 + WEBHOOK_RETENTION_MS
				yield* TestClock.setTime(afterAllExpired)
				expect(engine.getDelivery(WebhookDeliveryId.make("wdel_1"), afterAllExpired)).toBeNull()
				expect(
					engine.redeliver(
						WebhookDeliveryId.make("wdel_2"),
						WebhookDeliveryId.make("wdel_late"),
						afterAllExpired,
					),
				).toBeNull()
				expect(engine.listDeliveries({ limit: 50 }, afterAllExpired).data).toEqual([])
				expect(engine.nextAlarmAt()).toBeNull()
				db.close()
			}).pipe(Effect.provide(CryptoLive)),
	)

	it.effect(
		"enforces idle retention alarm when no reads arrive after the last completed delivery",
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				const db = new DatabaseSync(":memory:")
				const webhookId = WebhookId.make("whe_idle_ret")
				const engine = new WebhookDeliveryEngine(webhookId, sqliteStorage(db))
				const mac = yield* Mac.Mac
				const masterKey = yield* makeWebhookMasterKey("idle-master")
				const endpoint = activeEndpoint()

				engine.enqueue(
					{
						delivery_id: WebhookDeliveryId.make("wdel_idle"),
						event_id: WebhookEventId.make("evt_idle"),
						event_type: "agent.created",
						dedupe_key: "evt_idle",
						payload_json: "{}",
					},
					T0,
				)
				const first = yield* engine.drainDue({
					readEndpoint: Effect.succeed(endpoint),
					recordOutcome: () => Effect.succeed(endpoint),
					mac,
					masterKey: Effect.succeed(masterKey),
					sender: { send: () => Effect.succeed({ kind: "response", status: 200 }) },
				})
				expect(first.nextAlarmAt).toBe(T0 + WEBHOOK_RETENTION_MS)

				yield* TestClock.setTime(T0 + WEBHOOK_RETENTION_MS)
				const cleanup = yield* engine.drainDue({
					readEndpoint: Effect.succeed(endpoint),
					recordOutcome: () => Effect.succeed(endpoint),
					mac,
					masterKey: Effect.succeed(masterKey),
					sender: { send: () => Effect.succeed({ kind: "response", status: 200 }) },
				})
				expect(cleanup).toEqual({ processed: 0, purged: false, nextAlarmAt: null })
				expect(engine.listDeliveries({ limit: 50 }).data).toEqual([])
				db.close()
			}).pipe(Effect.provide(CryptoLive)),
	)

	it.effect(
		"refreshes endpoint config and signing window before every row in a batch (pause, URL update, secret expiry, delete)",
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				const db = new DatabaseSync(":memory:")
				const webhookId = WebhookId.make("whe_refresh")
				const engine = new WebhookDeliveryEngine(webhookId, sqliteStorage(db))
				const mac = yield* Mac.Mac
				const masterKey = yield* makeWebhookMasterKey("refresh-master")
				const prevExpiry = T0 + 10_000
				let endpoint = activeEndpoint({
					url: "https://hooks.example.com/v1",
					definition_revision: 1,
					secret_revision: 2,
					secret_salt: "22222222222222222222222222222222",
					previous_secret_revision: 1,
					previous_secret_salt: "11111111111111111111111111111111",
					previous_secret_expires_at: prevExpiry,
				})
				const sent: Array<WebhookHttpRequest> = []
				const recordedRevisions: Array<number> = []

				for (const i of [1, 2, 3]) {
					engine.enqueue(
						{
							delivery_id: WebhookDeliveryId.make(`wdel_r${i}`),
							event_id: WebhookEventId.make(`evt_r${i}`),
							event_type: "agent.created",
							dedupe_key: `evt_r${i}`,
							payload_json: `{"i":${i}}`,
						},
						T0 + i,
					)
				}
				yield* TestClock.setTime(T0 + 5)

				const drain = yield* engine.drainDue({
					readEndpoint: Effect.sync(() => endpoint),
					recordOutcome: (input) =>
						Effect.sync(() => {
							recordedRevisions.push(input.definition_revision)
							return endpoint
						}),
					mac,
					masterKey: Effect.succeed(masterKey),
					sender: {
						send: (req) =>
							Effect.gen(function* () {
								sent.push(req)
								if (sent.length === 1) {
									// Operator updates URL + bumps revision, and clock passes previous_secret_expires_at while row 1 is in flight.
									endpoint = {
										...endpoint,
										url: "https://hooks.example.com/v2",
										definition_revision: 2,
									}
									yield* TestClock.setTime(prevExpiry + 1000)
									return { kind: "response" as const, status: 200 }
								}
								// Operator pauses endpoint while row 2 is in flight -> row 3 must NOT be sent.
								endpoint = { ...endpoint, status: "paused" }
								return { kind: "response" as const, status: 500 }
							}),
					},
				})

				expect(drain.processed).toBe(2)
				expect(sent).toHaveLength(2)
				expect(sent[0]!.url).toBe("https://hooks.example.com/v1")
				expect(sent[1]!.url).toBe("https://hooks.example.com/v2")

				// Row 1 had dual signatures; row 2 signed ONLY with current secret after expiry passed mid-batch.
				expect(sent[0]!.headers[STANDARD_WEBHOOK_HEADERS.signature]!.split(" ")).toHaveLength(2)
				expect(sent[1]!.headers[STANDARD_WEBHOOK_HEADERS.signature]!.split(" ")).toHaveLength(1)

				// Row 2 recorded its failure outcome against revision 2 (the revision actually used for row 2).
				expect(recordedRevisions).toEqual([2])
				// Row 3 was skipped once the pause was observed before sending row 3.
				expect(engine.getDelivery(WebhookDeliveryId.make("wdel_r3"))?.status).toBe("skipped")
				db.close()
			}).pipe(Effect.provide(CryptoLive)),
	)

	it.effect(
		"persists health outcomes durably and retries them with deterministic outcome_id before sending subsequent rows",
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				const db = new DatabaseSync(":memory:")
				const webhookId = WebhookId.make("whe_outbox")
				const engine = new WebhookDeliveryEngine(webhookId, sqliteStorage(db))
				const mac = yield* Mac.Mac
				const masterKey = yield* makeWebhookMasterKey("outbox-master")
				let endpoint = activeEndpoint()
				let failRecordOutcome = true
				const seenOutcomeIds: Array<string> = []
				const sentUrls: Array<string> = []

				engine.enqueue(
					{
						delivery_id: WebhookDeliveryId.make("wdel_o1"),
						event_id: WebhookEventId.make("evt_o1"),
						event_type: "agent.created",
						dedupe_key: "evt_o1",
						payload_json: "{}",
					},
					T0,
				)
				engine.enqueue(
					{
						delivery_id: WebhookDeliveryId.make("wdel_o2"),
						event_id: WebhookEventId.make("evt_o2"),
						event_type: "agent.created",
						dedupe_key: "evt_o2",
						payload_json: "{}",
					},
					T0 + 1,
				)
				yield* TestClock.setTime(T0 + 5)

				const runDrain = () =>
					engine.drainDue({
						readEndpoint: Effect.sync(() => endpoint),
						recordOutcome: (input) =>
							Effect.suspend(() => {
								seenOutcomeIds.push(input.outcome_id)
								if (failRecordOutcome) {
									return Effect.die(new Error("transient aggregate RPC error"))
								}
								if (input.outcome === "redirect") {
									endpoint = { ...endpoint, status: "disabled_redirect" }
								}
								return Effect.succeed(endpoint)
							}),
						mac,
						masterKey: Effect.succeed(masterKey),
						sender: {
							send: (req) =>
								Effect.sync(() => {
									sentUrls.push(req.url)
									return { kind: "response", status: 302 }
								}),
						},
					})

				// Attempt 1: row 1 returns 302, commits terminal row + outbox, then recordOutcome fails.
				const failedExit = yield* Effect.exit(runDrain())
				expect(failedExit._tag).toBe("Failure")
				expect(engine.getDelivery(WebhookDeliveryId.make("wdel_o1"))?.status).toBe("failed")
				expect(engine.getDelivery(WebhookDeliveryId.make("wdel_o1"))?.last_outcome).toBe(
					"http_redirect",
				)
				expect(engine.pendingHealthOutcomesCount()).toBe(1)
				expect(engine.nextAlarmAt()).toBeLessThanOrEqual(T0 + 5)
				expect(sentUrls).toHaveLength(1)

				// Attempt 2 (alarm retry): flushes persisted redirect outcome FIRST, disables endpoint, skips row 2 without sending it!
				failRecordOutcome = false
				const recovered = yield* runDrain()
				expect(recovered.processed).toBe(0)
				expect(engine.pendingHealthOutcomesCount()).toBe(0)
				expect(endpoint.status).toBe("disabled_redirect")
				expect(sentUrls).toHaveLength(1)
				expect(seenOutcomeIds).toEqual(["wdel_o1:1", "wdel_o1:1"])
				expect(engine.getDelivery(WebhookDeliveryId.make("wdel_o2"))?.status).toBe("skipped")

				// Even with zero remaining pending deliveries, an unacknowledged health outcome keeps nextAlarmAt immediate (not delayed 14d).
				endpoint = activeEndpoint({ definition_revision: 2 })
				failRecordOutcome = true
				engine.enqueue(
					{
						delivery_id: WebhookDeliveryId.make("wdel_o3"),
						event_id: WebhookEventId.make("evt_o3"),
						event_type: "agent.created",
						dedupe_key: "evt_o3",
						payload_json: "{}",
					},
					T0 + 100,
				)
				yield* TestClock.setTime(T0 + 100)
				expect((yield* Effect.exit(runDrain()))._tag).toBe("Failure")
				expect(engine.pendingHealthOutcomesCount()).toBe(1)
				expect(engine.nextAlarmAt()).toBe(T0 + 100)
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
						expect(res.nextAlarmAt).toBe(T0 + WEBHOOK_RETENTION_MS)
					}
				}

				const exhausted = engine.getDelivery(WebhookDeliveryId.make("wdel_fail"), now)
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
				expect(okDrain).toEqual({
					processed: 1,
					purged: false,
					nextAlarmAt: T0 + WEBHOOK_RETENTION_MS,
				})
				expect(outcomes.at(-1)).toBe("delivered")
				expect(endpoint.failure_window_started_at).toBe(0)
				expect(engine.getDelivery(WebhookDeliveryId.make("wdel_fail"), now + 1000)?.status).toBe(
					"failed",
				)
				expect(
					engine.getDelivery(WebhookDeliveryId.make("wdel_retry_ok"), now + 1000)?.status,
				).toBe("succeeded")
				db.close()
			}).pipe(Effect.provide(CryptoLive)),
	)

	it.effect(
		"never evicts pending rows during 500-row terminal history pruning, bounds pending queue with backpressure, and self-purges on delete",
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				const db = new DatabaseSync(":memory:")
				const webhookId = WebhookId.make("whe_ops")
				const engine = new WebhookDeliveryEngine(webhookId, sqliteStorage(db))
				const mac = yield* Mac.Mac
				const masterKey = yield* makeWebhookMasterKey("ops-master")
				let endpoint = activeEndpoint()

				// Enqueue 520 pending rows: NONE may be evicted by the 500-row terminal history cap.
				for (let i = 0; i < WEBHOOK_MAX_STORED_DELIVERIES + 20; i++) {
					const ts = T0 + i
					engine.enqueue(
						{
							delivery_id: WebhookDeliveryId.make(`wdel_pend_${String(i).padStart(4, "0")}`),
							event_id: WebhookEventId.make(`evt_pend_${i}`),
							event_type: "agent.created",
							dedupe_key: `evt_pend_${i}`,
							payload_json: "{}",
						},
						ts,
					)
				}
				expect(engine.getDelivery(WebhookDeliveryId.make("wdel_pend_0000"))?.status).toBe("pending")

				// Drain all 520 deliveries to terminal succeeded -> terminal history caps at 500 and keyset paginates cleanly.
				yield* TestClock.setTime(T0 + 10_000)
				for (;;) {
					const res = yield* engine.drainDue({
						readEndpoint: Effect.sync(() => endpoint),
						recordOutcome: () => Effect.succeed(endpoint),
						mac,
						masterKey: Effect.succeed(masterKey),
						sender: { send: () => Effect.succeed({ kind: "response", status: 200 }) },
						batchSize: 100,
					})
					if (res.processed === 0) {
						break
					}
				}
				const firstPage = engine.listDeliveries({ limit: 100 }, T0 + 10_000)
				expect(firstPage.data).toHaveLength(100)
				expect(firstPage.next_page).not.toBeNull()
				let totalListed = firstPage.data.length
				let cursor = firstPage.next_page
				while (cursor !== null) {
					const next = engine.listDeliveries({ page: cursor, limit: 100 }, T0 + 10_000)
					totalListed += next.data.length
					cursor = next.next_page
				}
				expect(totalListed).toBe(WEBHOOK_MAX_STORED_DELIVERIES)

				// Pending queue rejects new work cleanly at WEBHOOK_MAX_PENDING_DELIVERIES rather than evicting accepted rows.
				for (let i = 0; i < WEBHOOK_MAX_PENDING_DELIVERIES; i++) {
					engine.enqueue(
						{
							delivery_id: WebhookDeliveryId.make(`wdel_q_${String(i).padStart(4, "0")}`),
							event_id: WebhookEventId.make(`evt_q_${i}`),
							event_type: "agent.created",
							dedupe_key: `evt_q_${i}`,
							payload_json: "{}",
						},
						T0 + 20_000 + i,
					)
				}
				// Replaying an existing dedupe key still succeeds when full.
				expect(
					engine.enqueue(
						{
							delivery_id: WebhookDeliveryId.make("wdel_q_dup"),
							event_id: WebhookEventId.make("evt_q_0"),
							event_type: "agent.created",
							dedupe_key: "evt_q_0",
							payload_json: "{}",
						},
						T0 + 30_000,
					).record.id,
				).toBe("wdel_q_0000")
				// A brand-new event above the cap throws backpressure error.
				expect(() =>
					engine.enqueue(
						{
							delivery_id: WebhookDeliveryId.make("wdel_q_overflow"),
							event_id: WebhookEventId.make("evt_q_overflow"),
							event_type: "agent.created",
							dedupe_key: "evt_q_overflow",
							payload_json: "{}",
						},
						T0 + 30_001,
					),
				).toThrow(/pending delivery queue is full/)

				// Deleted endpoint self-purges all deliveries and health outcomes.
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

	it.effect(
		"preserves signed webhook-id across manual redeliveries, isolates egress proxy outages from endpoint health, and recovers from rolled-back schema init",
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				const db = new DatabaseSync(":memory:")
				const webhookId = WebhookId.make("whe_sqlite_regressions")
				const baseSql = sqliteStorage(db)

				// 1) Simulate a rolled-back first transaction after DDL: schema init cache must reset.
				let forceRollback = true
				const flakySql: WebhookSqlStorage = {
					exec: (query, ...bindings) => baseSql.exec(query, ...bindings),
					transaction: <A>(fn: () => A): A => {
						db.exec("BEGIN IMMEDIATE")
						try {
							const result = fn()
							if (forceRollback) {
								forceRollback = false
								throw new Error("simulated alarm schedule failure")
							}
							db.exec("COMMIT")
							return result
						} catch (error) {
							db.exec("ROLLBACK")
							throw error
						}
					},
				}
				const engine = new WebhookDeliveryEngine(webhookId, flakySql)
				expect(() =>
					engine.enqueue(
						{
							delivery_id: WebhookDeliveryId.make("wdel_rollback_1"),
							event_id: WebhookEventId.make("evt_stable_msg_1"),
							event_type: "agent.created",
							dedupe_key: "evt_stable_msg_1",
							payload_json: JSON.stringify({ custom: "payload" }),
						},
						T0,
					),
				).toThrow(/simulated alarm schedule failure/)

				// Retry succeeds and creates the schema cleanly without "no such table".
				const original = engine.enqueue(
					{
						delivery_id: WebhookDeliveryId.make("wdel_orig_1"),
						event_id: WebhookEventId.make("evt_stable_msg_1"),
						event_type: "agent.created",
						dedupe_key: "evt_stable_msg_1",
						payload_json: JSON.stringify({ custom: "payload" }),
					},
					T0,
				)
				expect(original.record.id).toBe("wdel_orig_1")

				const mac = yield* Mac.Mac
				const masterKey = yield* makeWebhookMasterKey("regression-master")
				const endpoint = activeEndpoint()
				const secret = yield* deriveWebhookSigningSecret(mac, masterKey, {
					webhookId,
					secretRevision: endpoint.secret_revision,
					secretSalt: endpoint.secret_salt,
				})
				const healthOutcomes: Array<string> = []
				const sent: Array<WebhookHttpRequest> = []

				// 2) Egress proxy outage retries delivery WITHOUT degrading endpoint health.
				yield* engine.drainDue({
					readEndpoint: Effect.succeed(endpoint),
					recordOutcome: (input) =>
						Effect.sync(() => {
							healthOutcomes.push(input.outcome)
							return endpoint
						}),
					mac,
					masterKey: Effect.succeed(masterKey),
					sender: {
						send: (req) =>
							Effect.sync(() => {
								sent.push(req)
								return { kind: "egress_error", message: "Webhook egress proxy returned HTTP 503." }
							}),
					},
				})
				expect(healthOutcomes).toEqual([])
				expect(engine.pendingHealthOutcomesCount()).toBe(0)
				const afterProxyOutage = engine.getDelivery(WebhookDeliveryId.make("wdel_orig_1"), T0)
				expect(afterProxyOutage?.status).toBe("pending")
				expect(afterProxyOutage?.attempt_count).toBe(1)

				// 2b) Missing local egress configuration fails the delivery without degrading endpoint health.
				engine.enqueue(
					{
						delivery_id: WebhookDeliveryId.make("wdel_unconfigured_1"),
						event_id: WebhookEventId.make("evt_unconfigured_1"),
						event_type: "agent.created",
						dedupe_key: "evt_unconfigured_1",
						payload_json: JSON.stringify({ custom: "payload" }),
					},
					T0,
				)
				yield* engine.drainDue({
					readEndpoint: Effect.succeed(endpoint),
					recordOutcome: (input) =>
						Effect.sync(() => {
							healthOutcomes.push(input.outcome)
							return endpoint
						}),
					mac,
					masterKey: Effect.succeed(masterKey),
					sender: {
						send: () =>
							Effect.succeed({
								kind: "egress_unconfigured",
								message: "Direct webhook delivery is disabled in local workerd.",
							}),
					},
				})
				expect(healthOutcomes).toEqual([])
				expect(engine.pendingHealthOutcomesCount()).toBe(0)
				const afterUnconfigured = engine.getDelivery(
					WebhookDeliveryId.make("wdel_unconfigured_1"),
					T0,
				)
				expect(afterUnconfigured?.status).toBe("failed")
				expect(afterUnconfigured?.last_outcome).toBe("network_error")

				// 3) Next attempt succeeds; then manual redelivery creates a new delivery_id
				//    while keeping the exact same Standard Webhooks webhook-id & signature input.
				yield* TestClock.setTime(afterProxyOutage!.next_attempt_at!)
				yield* engine.drainDue({
					readEndpoint: Effect.succeed(endpoint),
					recordOutcome: (input) =>
						Effect.sync(() => {
							healthOutcomes.push(input.outcome)
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
				expect(healthOutcomes).toEqual([])

				const redelivered = engine.redeliver(
					WebhookDeliveryId.make("wdel_orig_1"),
					WebhookDeliveryId.make("wdel_replay_2"),
					afterProxyOutage!.next_attempt_at! + 1000,
				)
				expect(redelivered?.record.id).toBe("wdel_replay_2")
				expect(redelivered?.record.event_id).toBe("evt_stable_msg_1")

				yield* TestClock.setTime(afterProxyOutage!.next_attempt_at! + 1000)
				yield* engine.drainDue({
					readEndpoint: Effect.succeed(endpoint),
					recordOutcome: () => Effect.succeed(endpoint),
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
				const firstSend = sent[1]!
				const replaySend = sent[2]!
				expect(firstSend.headers[STANDARD_WEBHOOK_HEADERS.id]).toBe("evt_stable_msg_1")
				expect(replaySend.headers[STANDARD_WEBHOOK_HEADERS.id]).toBe("evt_stable_msg_1")
				expect(
					yield* verifyStandardWebhook(mac, {
						secret,
						webhookId: "evt_stable_msg_1",
						timestampSeconds: Number(replaySend.headers[STANDARD_WEBHOOK_HEADERS.timestamp] ?? "0"),
						signatureHeader: replaySend.headers[STANDARD_WEBHOOK_HEADERS.signature] ?? "",
						payload: replaySend.body,
					}),
				).toBe(true)
				db.close()
			}).pipe(Effect.provide(CryptoLive)),
	)

	it.effect(
		"skips queued retries whose event_type was unsubscribed during backoff without skipping remaining subscribed deliveries",
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				const db = new DatabaseSync(":memory:")
				const webhookId = WebhookId.make("whe_sub_edit")
				const engine = new WebhookDeliveryEngine(webhookId, sqliteStorage(db))
				const mac = yield* Mac.Mac
				const masterKey = yield* makeWebhookMasterKey("sub-edit-master")
				let endpoint = activeEndpoint({
					event_types: "session.status_idled,agent.created",
					definition_revision: 1,
				})
				const sent: Array<WebhookHttpRequest> = []
				const outcomes: Array<string> = []

				engine.enqueue(
					{
						delivery_id: WebhookDeliveryId.make("wdel_unsub"),
						event_id: WebhookEventId.make("evt_unsub"),
						event_type: "session.status_idled",
						dedupe_key: "evt_unsub",
						payload_json: JSON.stringify({ id: "evt_unsub", type: "session.status_idled" }),
					},
					T0,
				)
				engine.enqueue(
					{
						delivery_id: WebhookDeliveryId.make("wdel_kept"),
						event_id: WebhookEventId.make("evt_kept"),
						event_type: "agent.created",
						dedupe_key: "evt_kept",
						payload_json: JSON.stringify({ id: "evt_kept", type: "agent.created" }),
					},
					T0,
				)

				// First attempt fails transiently so both enter retry backoff.
				yield* engine.drainDue({
					readEndpoint: Effect.sync(() => endpoint),
					recordOutcome: (input) =>
						Effect.sync(() => {
							outcomes.push(input.outcome)
							return endpoint
						}),
					mac,
					masterKey: Effect.succeed(masterKey),
					sender: {
						send: (req) =>
							Effect.sync(() => {
								sent.push(req)
								return { kind: "response", status: 503 }
							}),
					},
				})
				expect(sent).toHaveLength(2)

				// Operator edits the endpoint during backoff to unsubscribe from session.status_idled.
				endpoint = activeEndpoint({
					event_types: "agent.created",
					definition_revision: 2,
				})
				const retryAt = engine.nextAlarmAt()!
				yield* TestClock.setTime(retryAt + 10)
				const outcomesBeforeRetry = outcomes.length

				yield* engine.drainDue({
					readEndpoint: Effect.sync(() => endpoint),
					recordOutcome: (input) =>
						Effect.sync(() => {
							outcomes.push(input.outcome)
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

				// Only agent.created was sent on retry; session.status_idled was skipped without touching endpoint health.
				expect(sent).toHaveLength(3)
				expect(sent[2]?.headers[STANDARD_WEBHOOK_HEADERS.id]).toBe("evt_kept")
				expect(outcomes).toHaveLength(outcomesBeforeRetry)
				const skipped = engine.getDelivery(WebhookDeliveryId.make("wdel_unsub"), retryAt + 10)
				const delivered = engine.getDelivery(WebhookDeliveryId.make("wdel_kept"), retryAt + 10)
				expect(skipped?.status).toBe("skipped")
				expect(skipped?.next_attempt_at).toBeNull()
				expect(skipped?.last_error).toContain("session.status_idled")
				expect(delivered?.status).toBe("succeeded")
				db.close()
			}).pipe(Effect.provide(CryptoLive)),
	)
})
