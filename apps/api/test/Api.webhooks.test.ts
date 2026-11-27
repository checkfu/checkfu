import { unwrapWebhookEvent } from "@checkfu/sdk"
import { describe, expect, it } from "@effect/vitest"
import * as Mac from "effect/crypto/Mac"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { WebhookListingQuery, WebhookListingTimeout } from "../src/Http/Listing.ts"
import { makeApiHandler } from "../src/Http/Router.ts"
import {
	WebhookDeliveryStore,
	WebhookDeliveryStoreError,
} from "../src/Webhooks/WebhookDeliveryStore.ts"
import { STANDARD_WEBHOOK_HEADERS, verifyStandardWebhook } from "../src/Webhooks/WebhookSigning.ts"
import {
	AUTH_HEADERS,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendAndSettle,
	sendRequest,
} from "./helpers/ApiHarness.ts"

interface WebhookJson {
	readonly id: string
	readonly type: "webhook"
	readonly status: string
	readonly url: string
	readonly description: string
	readonly event_types: ReadonlyArray<string>
	readonly definition_revision: number
	readonly secret_revision: number
	readonly previous_secret_expires_at: string | null
	readonly consecutive_failures: number
	readonly last_failure_at: string | null
	readonly signing_secret?: string
}

interface WebhookDeliveryJson {
	readonly id: string
	readonly type: "webhook_delivery"
	readonly webhook_id: string
	readonly event_id: string
	readonly event_type: string
	readonly status: string
	readonly attempt_count: number
	readonly max_attempts: number
	readonly last_http_status: number | null
	readonly last_outcome: string | null
	readonly last_error: string | null
}

describe("Webhooks HTTP API", () => {
	it("manages webhook lifecycle, idempotency, SSRF checks, dual-secret rotation, redirect recovery, and deletion", async () => {
		let nextStatus = 200
		const harness = makePiDurableTestLayer(
			async (model) => makeAssistantReply(model, null, "ok", 5, 3),
			{
				webhookSender: {
					send: () => Effect.succeed({ kind: "response", status: nextStatus }),
				},
			},
		)

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const mac = yield* Mac.Mac

					// Unauthenticated requests are rejected.
					const unauthRes = yield* sendRequest(apiFetch, { method: "GET", path: "/v1/webhooks" })
					expect(unauthRes.status).toBe(401)

					// Unsafe / non-HTTPS / private destinations are rejected with 400.
					for (const badUrl of [
						"http://hooks.example.com/events",
						"https://localhost/events",
						"https://127.0.0.1/events",
						"https://169.254.169.254/latest/meta-data/",
						"https://user:pass@hooks.example.com/events",
						"https://hooks.example.com/events#frag",
						// Canonicalizes past 2048 bytes after percent-encoding.
						`https://hooks.example.com/${"é".repeat(400)}`,
					]) {
						const badRes = yield* sendRequest(apiFetch, {
							method: "POST",
							path: "/v1/webhooks",
							headers: AUTH_HEADERS,
							body: { url: badUrl, event_types: ["*"] },
						})
						expect(badRes.status, badUrl).toBe(400)
					}

					// Create with Idempotency-Key returns 201 + signing_secret once.
					const createRes1 = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/webhooks",
						headers: { ...AUTH_HEADERS, "idempotency-key": "idem-wh-1" },
						body: {
							url: "https://hooks.example.com/checkfu?env=prod",
							description: "Primary sink",
							event_types: ["session.status_idled", "session.status_idled"],
						},
					})
					expect(createRes1.status).toBe(201)
					const created1 = (yield* Effect.promise(() => createRes1.json())) as WebhookJson
					expect(created1.id.startsWith("whe_")).toBe(true)
					expect(created1.status).toBe("active")
					expect(created1.event_types).toEqual(["session.status_idled"])
					expect(created1.signing_secret?.startsWith("whsec_")).toBe(true)
					const originalSecret = created1.signing_secret ?? ""

					// Replaying the same Idempotency-Key with the same payload returns the same webhook.
					const createReplay = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/webhooks",
						headers: { ...AUTH_HEADERS, "idempotency-key": "idem-wh-1" },
						body: {
							url: "https://hooks.example.com/checkfu?env=prod",
							description: "Primary sink",
							event_types: ["session.status_idled"],
						},
					})
					expect(createReplay.status).toBe(201)
					const replayed = (yield* Effect.promise(() => createReplay.json())) as WebhookJson
					expect(replayed.id).toBe(created1.id)
					expect(replayed.signing_secret).toBe(originalSecret)

					// Reusing the same Idempotency-Key with a different payload returns 409.
					const createConflict = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/webhooks",
						headers: { ...AUTH_HEADERS, "idempotency-key": "idem-wh-1" },
						body: {
							url: "https://hooks.example.com/other",
							event_types: ["*"],
						},
					})
					expect(createConflict.status).toBe(409)
					expect(yield* Effect.promise(() => createConflict.json())).toMatchObject({
						error: { code: "idempotency_key_reused" },
					})

					// GET and LIST never expose signing_secret.
					const getRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/webhooks/${created1.id}`,
						headers: AUTH_HEADERS,
					})
					expect(getRes.status).toBe(200)
					const fetched = (yield* Effect.promise(() => getRes.json())) as WebhookJson
					expect("signing_secret" in fetched).toBe(false)

					const listRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/v1/webhooks",
						headers: AUTH_HEADERS,
					})
					expect(listRes.status).toBe(200)
					const listed = (yield* Effect.promise(() => listRes.json())) as {
						readonly data: ReadonlyArray<WebhookJson>
					}
					expect(listed.data.map((w) => w.id)).toEqual([created1.id])
					expect(listed.data.every((w) => !("signing_secret" in w))).toBe(true)

					// Rotate secret -> returns new secret once and dual-signs test deliveries for 24h.
					const rotateRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/webhooks/${created1.id}/rotate-secret`,
						headers: { ...AUTH_HEADERS, "idempotency-key": "idem-rot-1" },
					})
					expect(rotateRes.status).toBe(200)
					const rotated = (yield* Effect.promise(() => rotateRes.json())) as WebhookJson
					expect(rotated.secret_revision).toBe(2)
					expect(rotated.previous_secret_expires_at).not.toBeNull()
					expect(rotated.signing_secret?.startsWith("whsec_")).toBe(true)
					const rotatedSecret = rotated.signing_secret ?? ""
					expect(rotatedSecret).not.toBe(originalSecret)

					// Send test delivery -> dual-signed header verifies with BOTH old and new secrets.
					const testRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/webhooks/${created1.id}/test`,
						headers: AUTH_HEADERS,
					})
					expect(testRes.status).toBe(201)
					const testDelivery = (yield* Effect.promise(() => testRes.json())) as WebhookDeliveryJson
					expect(testDelivery.status).toBe("succeeded")
					expect(testDelivery.event_type).toBe("webhook.test")
					expect(testDelivery.last_http_status).toBe(200)

					const sent = harness.webhookDeliveries.sentRequests.at(-1)
					expect(sent).toBeDefined()
					const sigHeader = sent?.headers[STANDARD_WEBHOOK_HEADERS.signature] ?? ""
					const ts = Number(sent?.headers[STANDARD_WEBHOOK_HEADERS.timestamp] ?? "0")
					const deliveryIdHeader = sent?.headers[STANDARD_WEBHOOK_HEADERS.id] ?? ""
					expect(deliveryIdHeader).toBe(testDelivery.event_id)
					expect(JSON.parse(sent?.body ?? "{}")).toEqual({
						type: "event",
						id: testDelivery.event_id,
						created_at: expect.any(String),
						data: { type: "webhook.test", id: created1.id },
					})
					expect(
						yield* verifyStandardWebhook(mac, {
							secret: originalSecret,
							webhookId: deliveryIdHeader,
							timestampSeconds: ts,
							signatureHeader: sigHeader,
							payload: sent?.body ?? "",
						}),
					).toBe(true)
					expect(
						yield* verifyStandardWebhook(mac, {
							secret: rotatedSecret,
							webhookId: deliveryIdHeader,
							timestampSeconds: ts,
							signatureHeader: sigHeader,
							payload: sent?.body ?? "",
						}),
					).toBe(true)

					// Pause rejects test deliveries with 409; resume restores active status.
					const pauseRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/webhooks/${created1.id}/pause`,
						headers: AUTH_HEADERS,
					})
					expect(pauseRes.status).toBe(200)
					expect(((yield* Effect.promise(() => pauseRes.json())) as WebhookJson).status).toBe(
						"paused",
					)

					const pausedTestRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/webhooks/${created1.id}/test`,
						headers: AUTH_HEADERS,
					})
					expect(pausedTestRes.status).toBe(409)

					const resumeRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/webhooks/${created1.id}/resume`,
						headers: AUTH_HEADERS,
					})
					expect(resumeRes.status).toBe(200)
					expect(((yield* Effect.promise(() => resumeRes.json())) as WebhookJson).status).toBe(
						"active",
					)

					// 302 redirect immediately disables endpoint; update + reactivate + redeliver recovers.
					nextStatus = 302
					const redirectTestRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/webhooks/${created1.id}/test`,
						headers: AUTH_HEADERS,
					})
					expect(redirectTestRes.status).toBe(201)
					const failedDelivery = (yield* Effect.promise(() =>
						redirectTestRes.json(),
					)) as WebhookDeliveryJson
					expect(failedDelivery.status).toBe("failed")
					expect(failedDelivery.last_outcome).toBe("http_redirect")

					const disabledRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/webhooks/${created1.id}`,
						headers: AUTH_HEADERS,
					})
					expect(((yield* Effect.promise(() => disabledRes.json())) as WebhookJson).status).toBe(
						"disabled_redirect",
					)

					nextStatus = 200
					const updateRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/webhooks/${created1.id}`,
						headers: AUTH_HEADERS,
						body: {
							url: "https://hooks.example.com/checkfu-v2",
							reactivate: true,
						},
					})
					expect(updateRes.status).toBe(200)
					const reactivated = (yield* Effect.promise(() => updateRes.json())) as WebhookJson
					expect(reactivated.status).toBe("active")
					expect(reactivated.url).toBe("https://hooks.example.com/checkfu-v2")

					const redeliverRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/webhooks/${created1.id}/deliveries/${failedDelivery.id}/redeliver`,
						headers: AUTH_HEADERS,
					})
					expect(redeliverRes.status).toBe(201)
					const redelivered = (yield* Effect.promise(() =>
						redeliverRes.json(),
					)) as WebhookDeliveryJson
					expect(redelivered.id).not.toBe(failedDelivery.id)
					expect(redelivered.event_id).toBe(failedDelivery.event_id)
					expect(redelivered.status).toBe("succeeded")

					// List deliveries returns newest first, and getDelivery retrieves a single record.
					const deliveriesRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/webhooks/${created1.id}/deliveries`,
						headers: AUTH_HEADERS,
					})
					expect(deliveriesRes.status).toBe(200)
					const deliveriesList = (yield* Effect.promise(() => deliveriesRes.json())) as {
						readonly data: ReadonlyArray<WebhookDeliveryJson>
					}
					expect(deliveriesList.data.length).toBeGreaterThanOrEqual(3)

					const getDeliveryRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/webhooks/${created1.id}/deliveries/${redelivered.id}`,
						headers: AUTH_HEADERS,
					})
					expect(getDeliveryRes.status).toBe(200)

					// Delete removes from listing, returns 404 on subsequent reads, and purges deliveries.
					const deleteRes = yield* sendRequest(apiFetch, {
						method: "DELETE",
						path: `/v1/webhooks/${created1.id}`,
						headers: AUTH_HEADERS,
					})
					expect(deleteRes.status).toBe(200)
					expect(yield* Effect.promise(() => deleteRes.json())).toEqual({
						id: created1.id,
						type: "webhook_deleted",
					})

					const afterDeleteGet = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/webhooks/${created1.id}`,
						headers: AUTH_HEADERS,
					})
					expect(afterDeleteGet.status).toBe(404)

					const afterDeleteList = yield* sendRequest(apiFetch, {
						method: "GET",
						path: "/v1/webhooks",
						headers: AUTH_HEADERS,
					})
					const afterDeleteListed = (yield* Effect.promise(() => afterDeleteList.json())) as {
						readonly data: ReadonlyArray<WebhookJson>
					}
					expect(afterDeleteListed.data).toEqual([])
				}).pipe(Effect.scoped, Effect.provide(harness.layer)),
			)
		} finally {
			await harness.closeAll()
		}
	})

	it("publishes one creation for a keyed empty artifact and a distinct event for version one", async () => {
		const creationFanout = Promise.withResolvers<void>()
		const versionFanout = Promise.withResolvers<void>()
		const harness = makePiDurableTestLayer(
			async (model) => makeAssistantReply(model, null, "ok", 5, 3),
			{
				webhookPublicationCompleted: ({ event_type }) => {
					if (event_type === "artifact.created") {
						creationFanout.resolve()
					}
					if (event_type === "artifact.version_added") {
						versionFanout.resolve()
					}
				},
			},
		)
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const register = (name: string, eventTypes: ReadonlyArray<string>) =>
						Effect.gen(function* () {
							const response = yield* sendRequest(apiFetch, {
								method: "POST",
								path: "/v1/webhooks",
								headers: AUTH_HEADERS,
								body: { url: `https://hooks.example.com/${name}`, event_types: eventTypes },
							})
							expect(response.status).toBe(201)
							return (yield* Effect.promise(() => response.json())) as WebhookJson
						})
					const wildcard = yield* register("all-artifact-events", ["*"])
					const creationOnly = yield* register("artifact-creation", ["artifact.created"])
					const deliveries = (id: string) =>
						Effect.gen(function* () {
							const response = yield* sendRequest(apiFetch, {
								method: "GET",
								path: `/v1/webhooks/${id}/deliveries`,
								headers: AUTH_HEADERS,
							})
							expect(response.status).toBe(200)
							const { data } = (yield* Effect.promise(() => response.json())) as {
								readonly data: ReadonlyArray<WebhookDeliveryJson>
							}
							return data.map(({ event_id, event_type }) => ({ event_id, event_type }))
						})

					const create = sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/artifacts",
						headers: { ...AUTH_HEADERS, "idempotency-key": "empty-upload" },
						body: { name: "Report" },
					})
					const response = yield* create
					expect(response.status).toBe(201)
					const artifact = (yield* Effect.promise(() => response.json())) as {
						readonly id: string
						readonly version: number
					}
					expect(artifact.version).toBe(0)
					const opened = {
						event_id: `evt_artifact_${artifact.id}_2`,
						event_type: "artifact.created",
					}
					yield* Effect.promise(() => creationFanout.promise).pipe(Effect.timeout("2 seconds"))
					expect(yield* deliveries(wildcard.id)).toEqual([opened])
					expect(yield* deliveries(creationOnly.id)).toEqual([opened])

					const replay = yield* create
					expect(replay.status).toBe(201)
					expect(yield* Effect.promise(() => replay.json())).toMatchObject(artifact)
					const version = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/artifacts/${artifact.id}/versions`,
						headers: AUTH_HEADERS,
						body: { version: 0, files: [{ path: "report.txt", content: "Ready" }] },
					})
					expect(version.status).toBe(201)
					expect(yield* Effect.promise(() => version.json())).toMatchObject({
						artifact_id: artifact.id,
						version: 1,
					})
					const added = {
						event_id: `evt_artifact_${artifact.id}_3`,
						event_type: "artifact.version_added",
					}
					yield* Effect.promise(() => versionFanout.promise).pipe(Effect.timeout("2 seconds"))
					const lifecycle = yield* deliveries(wildcard.id)
					expect(lifecycle).toHaveLength(2)
					expect(lifecycle).toEqual(expect.arrayContaining([opened, added]))
					expect(yield* deliveries(creationOnly.id)).toEqual([opened])
				}).pipe(Effect.scoped, Effect.provide(harness.layer)),
			)
		} finally {
			await harness.closeAll()
		}
	})

	it("fans out signed Checkfu lifecycle events to matching webhooks and never leaks artifact publication tokens", async () => {
		const harness = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "Hello webhook!", 8, 4),
		)

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler
					const mac = yield* Mac.Mac

					const wildcardRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/webhooks",
						headers: AUTH_HEADERS,
						body: { url: "https://hooks.example.com/all", event_types: ["*"] },
					})
					const wildcard = (yield* Effect.promise(() => wildcardRes.json())) as WebhookJson

					const filteredRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/webhooks",
						headers: AUTH_HEADERS,
						body: {
							url: "https://hooks.example.com/only-failures",
							event_types: ["automation_run.failed"],
						},
					})
					const filtered = (yield* Effect.promise(() => filteredRes.json())) as WebhookJson

					// Registration is immediately visible to fan-out upon 201 (no list polling needed).
					const agentRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/agents",
						headers: AUTH_HEADERS,
						body: { name: "Webhook Agent", model: "gpt-4o-mini" },
					})
					const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }

					const envRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/environments",
						headers: AUTH_HEADERS,
						body: { name: "Webhook Env" },
					})
					const env = (yield* Effect.promise(() => envRes.json())) as { id: string }

					const sessRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/sessions",
						headers: AUTH_HEADERS,
						body: { agent: agent.id, environment_id: env.id },
					})
					const session = (yield* Effect.promise(() => sessRes.json())) as { id: string }
					yield* sendAndSettle(apiFetch, session.id, ["ping"], 1)

					const artRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/artifacts",
						headers: AUTH_HEADERS,
						body: {
							name: "Report",
							files: [{ path: "index.html", content: "<h1>Hi</h1>" }],
						},
					})
					const art = (yield* Effect.promise(() => artRes.json())) as { id: string }

					const pubRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/artifacts/${art.id}/publication`,
						headers: AUTH_HEADERS,
						body: {},
					})
					const published = (yield* Effect.promise(() => pubRes.json())) as {
						readonly publication: { readonly address: string }
					}

					// Poll until the wildcard webhook receives artifact.published + session.status_idled.
					let deliveredEvents: Array<string> = []
					for (let attempt = 0; attempt < 100; attempt++) {
						const res = yield* sendRequest(apiFetch, {
							method: "GET",
							path: `/v1/webhooks/${wildcard.id}/deliveries`,
							headers: AUTH_HEADERS,
						})
						const list = (yield* Effect.promise(() => res.json())) as {
							readonly data: ReadonlyArray<WebhookDeliveryJson>
						}
						deliveredEvents = list.data.map((d) => d.event_type)
						if (
							deliveredEvents.includes("session.status_idled") &&
							deliveredEvents.includes("artifact.published")
						) {
							break
						}
						yield* Effect.sleep("10 millis")
					}

					expect(deliveredEvents).toContain("agent.created")
					expect(deliveredEvents).toContain("environment.created")
					expect(deliveredEvents).not.toContain("session.created")
					expect(deliveredEvents).toContain("session.status_run_started")
					expect(deliveredEvents).toContain("session.status_idled")
					expect(deliveredEvents).toContain("artifact.created")
					expect(deliveredEvents).toContain("artifact.published")

					// Filtered webhook subscribed only to automation_run.failed receives nothing.
					const filteredDeliveriesRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/webhooks/${filtered.id}/deliveries`,
						headers: AUTH_HEADERS,
					})
					const filteredDeliveries = (yield* Effect.promise(() =>
						filteredDeliveriesRes.json(),
					)) as { readonly data: ReadonlyArray<WebhookDeliveryJson> }
					expect(filteredDeliveries.data).toEqual([])

					// Every delivered request verifies cleanly and never contains the artifact publication token.
					const pubToken = published.publication.address.split("-").at(-1) ?? ""
					expect(pubToken.length).toBeGreaterThan(8)
					for (const req of harness.webhookDeliveries.sentRequests) {
						expect(req.body).not.toContain(pubToken)
						const delivery = JSON.parse(req.body) as {
							readonly id: string
							readonly data: { readonly type: string; readonly id: string }
						}
						expect(delivery).toEqual({
							type: "event",
							id: req.headers[STANDARD_WEBHOOK_HEADERS.id],
							created_at: expect.any(String),
							data: { type: expect.any(String), id: expect.any(String) },
						})
						const valid = yield* verifyStandardWebhook(mac, {
							secret: wildcard.signing_secret ?? "",
							webhookId: req.headers[STANDARD_WEBHOOK_HEADERS.id] ?? "",
							timestampSeconds: Number(req.headers[STANDARD_WEBHOOK_HEADERS.timestamp] ?? "0"),
							signatureHeader: req.headers[STANDARD_WEBHOOK_HEADERS.signature] ?? "",
							payload: req.body,
						})
						expect(valid).toBe(true)
					}
				}).pipe(Effect.scoped, Effect.provide(harness.layer)),
			)
		} finally {
			await harness.closeAll()
		}
	})

	it("applies partial updates atomically and makes deletion cleanup retryable after tombstoning", async () => {
		const harness = makePiDurableTestLayer(async (model) =>
			makeAssistantReply(model, null, "ok", 5, 3),
		)
		let failPurge = true
		let purgeCalls = 0
		const FlakyPurgeDeliveries = Layer.effect(
			WebhookDeliveryStore,
			Effect.map(WebhookDeliveryStore, (store) => ({
				...store,
				purge: (webhookId) =>
					Effect.suspend(() => {
						purgeCalls += 1
						if (failPurge) {
							return Effect.fail(new WebhookDeliveryStoreError({ cause: "transient purge outage" }))
						}
						return store.purge(webhookId)
					}),
			})),
		)
		const testLayer = FlakyPurgeDeliveries.pipe(Layer.provideMerge(harness.layer))

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler

					const createRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/webhooks",
						headers: AUTH_HEADERS,
						body: {
							url: "https://hooks.example.com/initial",
							description: "Initial desc",
							event_types: ["agent.created"],
						},
					})
					expect(createRes.status).toBe(201)
					const created = (yield* Effect.promise(() => createRes.json())) as WebhookJson

					// Concurrent partial updates (URL-only + description-only) preserve both changes.
					const [urlRes, descRes] = yield* Effect.all(
						[
							sendRequest(apiFetch, {
								method: "POST",
								path: `/v1/webhooks/${created.id}`,
								headers: AUTH_HEADERS,
								body: { url: "https://hooks.example.com/updated" },
							}),
							sendRequest(apiFetch, {
								method: "POST",
								path: `/v1/webhooks/${created.id}`,
								headers: AUTH_HEADERS,
								body: { description: "Updated desc" },
							}),
						],
						{ concurrency: 2 },
					)
					expect(urlRes.status).toBe(200)
					expect(descRes.status).toBe(200)

					const afterUpdatesRes = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/webhooks/${created.id}`,
						headers: AUTH_HEADERS,
					})
					expect(afterUpdatesRes.status).toBe(200)
					const afterUpdates = (yield* Effect.promise(() => afterUpdatesRes.json())) as WebhookJson
					expect(afterUpdates.url).toBe("https://hooks.example.com/updated")
					expect(afterUpdates.description).toBe("Updated desc")
					expect(afterUpdates.event_types).toEqual(["agent.created"])

					// Create a completed delivery so payloads exist in storage before deletion.
					const testRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/webhooks/${created.id}/test`,
						headers: AUTH_HEADERS,
					})
					expect(testRes.status).toBe(201)

					// First DELETE tombstones the endpoint, fails purge -> 503 (never silently claims success).
					const deleteFailRes = yield* sendRequest(apiFetch, {
						method: "DELETE",
						path: `/v1/webhooks/${created.id}`,
						headers: AUTH_HEADERS,
					})
					expect(deleteFailRes.status).toBe(503)
					expect(purgeCalls).toBe(1)

					// Retrying DELETE on the tombstoned endpoint completes purge and returns 200.
					failPurge = false
					const deleteRetryRes = yield* sendRequest(apiFetch, {
						method: "DELETE",
						path: `/v1/webhooks/${created.id}`,
						headers: AUTH_HEADERS,
					})
					expect(deleteRetryRes.status).toBe(200)
					expect(purgeCalls).toBe(2)

					// Deleting a never-created webhook still returns 404.
					const missingDeleteRes = yield* sendRequest(apiFetch, {
						method: "DELETE",
						path: "/v1/webhooks/whe_does_not_exist_000000",
						headers: AUTH_HEADERS,
					})
					expect(missingDeleteRes.status).toBe(404)
				}).pipe(Effect.scoped, Effect.provide(testLayer)),
			)
		} finally {
			await harness.closeAll()
		}
	})

	it("returns 202 PendingWebhook with committed id and secret on listing timeout, isolates concurrent unkeyed secret rotations, and fans out vault/credential lifecycle events", async () => {
		const harness = makePiDurableTestLayer(
			async (model) => makeAssistantReply(model, null, "ok", 5, 3),
			{
				webhookSender: {
					send: () => Effect.succeed({ kind: "response", status: 200 }),
				},
				webhookAutoDrain: true,
			},
		)

		let listingMode: "timeout" | "defect" | "normal" = "timeout"
		const FlakyListing = Layer.effect(
			WebhookListingQuery,
			Effect.map(WebhookListingQuery, (inner) => ({
				page: (order, options) => inner.page(order, options),
				lookup: (id) => inner.lookup(id),
				waitFor: (receipt) =>
					listingMode === "timeout"
						? Effect.fail(new WebhookListingTimeout({ receipt }))
						: listingMode === "defect"
							? Effect.die(new Error("D1 listing host unavailable"))
							: inner.waitFor(receipt),
			})),
		)
		const testLayer = FlakyListing.pipe(Layer.provideMerge(harness.layer))

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const { fetch: apiFetch } = yield* makeApiHandler

					// 1) Unkeyed create whose listing wait times out returns 202 PendingWebhook
					//    carrying BOTH the committed id and the signing_secret (recoverable!).
					const pendingRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/webhooks",
						headers: AUTH_HEADERS,
						body: {
							url: "https://hooks.example.com/vault-sink",
							description: "Vault listener",
							event_types: ["*"],
						},
					})
					expect(pendingRes.status).toBe(202)
					const pendingBody = (yield* Effect.promise(() => pendingRes.json())) as {
						readonly id: string
						readonly type: string
						readonly pending: boolean
						readonly signing_secret: string
					}
					expect(pendingBody.id.startsWith("whe_")).toBe(true)
					expect(pendingBody.type).toBe("webhook")
					expect(pendingBody.pending).toBe(true)
					expect(pendingBody.signing_secret.startsWith("whsec_")).toBe(true)

					// 1b) Post-commit listing defect (e.g., D1 failure) ALSO returns 202 PendingWebhook
					//     with committed id + signing_secret instead of a 500 without receipt!
					listingMode = "defect"
					const defectRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/webhooks",
						headers: AUTH_HEADERS,
						body: {
							url: "https://hooks.example.com/defect-sink",
							description: "Defect listener",
							event_types: ["agent.created"],
						},
					})
					expect(defectRes.status).toBe(202)
					const defectBody = (yield* Effect.promise(() => defectRes.json())) as {
						readonly id: string
						readonly type: string
						readonly pending: boolean
						readonly signing_secret: string
					}
					expect(defectBody.id.startsWith("whe_")).toBe(true)
					expect(defectBody.pending).toBe(true)
					expect(defectBody.signing_secret.startsWith("whsec_")).toBe(true)
					// Remove the extra defect webhook so only pendingBody listens to the vault events below.
					expect(
						(yield* sendRequest(apiFetch, {
							method: "DELETE",
							path: `/v1/webhooks/${defectBody.id}`,
							headers: AUTH_HEADERS,
						})).status,
					).toBe(200)

					// 2) Concurrent unkeyed rotations: one succeeds (rev 2) and the overlapping rotation
					//    is rejected with 409 Conflict so rev 1's advertised 24h grace period is preserved!
					const [rotA, rotB] = yield* Effect.all(
						[
							sendRequest(apiFetch, {
								method: "POST",
								path: `/v1/webhooks/${pendingBody.id}/rotate-secret`,
								headers: AUTH_HEADERS,
							}),
							sendRequest(apiFetch, {
								method: "POST",
								path: `/v1/webhooks/${pendingBody.id}/rotate-secret`,
								headers: AUTH_HEADERS,
							}),
						],
						{ concurrency: 2 },
					)
					expect([rotA.status, rotB.status].toSorted((a, b) => a - b)).toEqual([200, 409])
					const winningRes = rotA.status === 200 ? rotA : rotB
					const winningBody = (yield* Effect.promise(() => winningRes.json())) as WebhookJson
					expect(winningBody.secret_revision).toBe(2)
					expect(winningBody.signing_secret?.startsWith("whsec_")).toBe(true)
					expect(winningBody.signing_secret).not.toBe(pendingBody.signing_secret)
					const activeSecret = winningBody.signing_secret ?? ""

					// 3) Check ID-specific listing readiness via GET /v1/webhooks?id=... in O(1),
					//    then exercise Vault & Credential lifecycle -> vault.created,
					//    vault_credential.created, vault.archived + vault_credential.archived,
					//    vault.deleted + vault_credential.deleted!
					listingMode = "normal"
					let listedPending = false
					for (let attempt = 0; attempt < 100; attempt++) {
						const listRes = yield* sendRequest(apiFetch, {
							method: "GET",
							path: `/v1/webhooks?id=${pendingBody.id}&limit=1`,
							headers: AUTH_HEADERS,
						})
						const listed = (yield* Effect.promise(() => listRes.json())) as {
							readonly data: ReadonlyArray<WebhookJson>
						}
						if (listed.data.length === 1 && listed.data[0]?.id === pendingBody.id) {
							listedPending = true
							break
						}
						yield* Effect.sleep("25 millis")
					}
					expect(listedPending).toBe(true)

					const vaultCreateRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: "/v1/vaults",
						headers: AUTH_HEADERS,
						body: { display_name: "Prod Secrets" },
					})
					expect(vaultCreateRes.status).toBe(201)
					const vault = (yield* Effect.promise(() => vaultCreateRes.json())) as {
						readonly id: string
					}

					const credCreateRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/vaults/${vault.id}/credentials`,
						headers: AUTH_HEADERS,
						body: {
							display_name: "GitHub MCP",
							auth: {
								type: "static_bearer",
								token: "tok_secret_never_in_webhook_12345",
								mcp_server_url: "https://mcp.example.com/github",
							},
						},
					})
					expect(credCreateRes.status).toBe(201)
					const credential = (yield* Effect.promise(() => credCreateRes.json())) as {
						readonly id: string
					}

					const vaultArchiveRes = yield* sendRequest(apiFetch, {
						method: "POST",
						path: `/v1/vaults/${vault.id}/archive`,
						headers: AUTH_HEADERS,
					})
					expect(vaultArchiveRes.status).toBe(200)

					// Wait for ArchiveVault's cascaded vault_credential.archived before deleting the vault.
					for (let attempt = 0; attempt < 100; attempt++) {
						const res = yield* sendRequest(apiFetch, {
							method: "GET",
							path: `/v1/webhooks/${pendingBody.id}/deliveries?limit=50`,
							headers: AUTH_HEADERS,
						})
						const list = (yield* Effect.promise(() => res.json())) as {
							readonly data: ReadonlyArray<WebhookDeliveryJson>
						}
						if (list.data.some((d) => d.event_type === "vault_credential.archived")) {
							break
						}
						yield* Effect.sleep("25 millis")
					}

					const vaultDeleteRes = yield* sendRequest(apiFetch, {
						method: "DELETE",
						path: `/v1/vaults/${vault.id}`,
						headers: AUTH_HEADERS,
					})
					expect(vaultDeleteRes.status).toBe(200)

					// Poll until all 6 vault/credential webhook events have been delivered.
					let deliveredTypes: Array<string> = []
					for (let attempt = 0; attempt < 100; attempt++) {
						const res = yield* sendRequest(apiFetch, {
							method: "GET",
							path: `/v1/webhooks/${pendingBody.id}/deliveries?limit=50`,
							headers: AUTH_HEADERS,
						})
						const list = (yield* Effect.promise(() => res.json())) as {
							readonly data: ReadonlyArray<WebhookDeliveryJson>
						}
						deliveredTypes = list.data.map((d) => d.event_type)
						if (
							deliveredTypes.includes("vault.deleted") &&
							deliveredTypes.includes("vault_credential.deleted")
						) {
							break
						}
						yield* Effect.sleep("25 millis")
					}
					expect(deliveredTypes).toEqual(
						expect.arrayContaining([
							"vault.created",
							"vault_credential.created",
							"vault.archived",
							"vault_credential.archived",
							"vault.deleted",
							"vault_credential.deleted",
						]),
					)

					// Verify every delivered vault/credential payload with SDK unwrapWebhookEvent
					// and confirm the credential secret never appears in any body!
					for (const req of harness.webhookDeliveries.sentRequests) {
						expect(req.body).not.toContain("tok_secret_never_in_webhook_12345")
						const unwrapped = yield* Effect.promise(() =>
							unwrapWebhookEvent(req.body, req.headers, { secret: activeSecret }),
						)
						expect(unwrapped.type).toBe("event")
						if (unwrapped.data.type.startsWith("vault_credential.")) {
							expect(unwrapped.data.id).toBe(credential.id)
							expect(unwrapped.data.vault_id).toBe(vault.id)
						}
					}
				}).pipe(Effect.scoped, Effect.provide(testLayer)),
			)
		} finally {
			await harness.closeAll()
		}
	})
})
