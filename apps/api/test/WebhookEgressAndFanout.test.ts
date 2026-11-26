import * as http from "node:http"
import * as Domain from "@alchemy.run/domain"
import { makeListingStoreMemory } from "@checkfu/domain/Listing/ListingStore"
import { CreateWebhookEndpoint } from "@checkfu/domain/Webhook/CreateWebhookEndpoint.command"
import { WebhookEndpoint } from "@checkfu/domain/Webhook/WebhookEndpoint.aggregate"
import { WebhookEvents } from "@checkfu/domain/Webhook/WebhookEvents.external"
import type { WebhookEventPublication } from "@checkfu/domain/Webhook/WebhookEvents.external"
import { Webhooks, WebhooksHandlersLive } from "@checkfu/domain/Webhooks.model"
import { WebhookId } from "@checkfu/sdk/Schemas"
import { describe, expect, it } from "@effect/vitest"
import * as Digest from "effect/crypto/Digest"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import {
	deliverThroughPublicHttps,
	startPublicWebhookEgressServer,
} from "../src/Webhooks/PublicWebhookEgress.ts"
import {
	WebhookDeliveryStore,
	WebhookDeliveryStoreError,
} from "../src/Webhooks/WebhookDeliveryStore.ts"
import {
	makeConfiguredWebhookHttpSender,
	parseWebhookEgressUrl,
} from "../src/Webhooks/WebhookEgress.ts"
import {
	WEBHOOK_FANOUT_LISTING_FILTER,
	WebhookFanoutContinuation,
	fanoutWebhookPage,
	makeWebhookEventsLive,
} from "../src/Webhooks/WebhookEventsLive.ts"
import { WebhookListingQuery, WebhookListingQueryLive } from "../src/Http/Listing.ts"
import { WebhookSigningMasterKeyTest } from "../src/Webhooks/WebhookSigning.ts"

const sampleEvent: WebhookEventPublication = {
	event_id: "evt_agent_agt_1_1",
	event_type: "agent.created",
	resource_type: "agent",
	resource_id: "agt_1",
	occurred_at: Date.parse("2026-01-01T00:00:00.000Z"),
	data_json: JSON.stringify({ agent_id: "agt_1" }),
}

describe("PublicWebhookEgress connection-time enforcement", () => {
	it("refuses DNS names resolving to private, loopback, link-local, or mixed private+public IPs before connecting", async () => {
		let connectAttempts = 0
		const fakeHttpsRequest = (() => {
			connectAttempts += 1
			throw new Error("should never be called for non-public destinations")
		}) as unknown as NonNullable<Parameters<typeof deliverThroughPublicHttps>[0]["httpsRequest"]>

		for (const addresses of [
			[{ address: "127.0.0.1", family: 4 }],
			[{ address: "10.0.0.5", family: 4 }],
			[{ address: "169.254.169.254", family: 4 }],
			[{ address: "100.64.0.1", family: 4 }],
			[{ address: "::1", family: 6 }],
			[{ address: "fc00::1", family: 6 }],
			[{ address: "::ffff:127.0.0.1", family: 6 }],
			[
				{ address: "93.184.216.34", family: 4 },
				{ address: "127.0.0.1", family: 4 },
			],
		]) {
			const res = await deliverThroughPublicHttps({
				targetUrl: "https://rebinding.example.com/hook",
				headers: {},
				body: Buffer.from("{}"),
				timeoutMs: 2000,
				lookupAll: async () => addresses,
				httpsRequest: fakeHttpsRequest,
			})
			expect(res.kind, JSON.stringify(addresses)).toBe("invalid_destination")
		}
		expect(connectAttempts).toBe(0)
	})

	it("fails closed in local dev without CHECKFU_WEBHOOK_EGRESS_URL and routes through PublicWebhookEgress when configured", async () => {
		let localHits = 0
		const victimServer = http.createServer((_req, res) => {
			localHits += 1
			res.writeHead(200)
			res.end("leaked")
		})
		await new Promise<void>((resolve) => {
			victimServer.listen(0, "127.0.0.1", () => {
				resolve()
			})
		})
		const victimAddress = victimServer.address()
		if (victimAddress === null || typeof victimAddress === "string") {
			throw new Error("Expected TCP address")
		}
		const victimPort = victimAddress.port

		const egress = await startPublicWebhookEgressServer({
			token: "egress-secret-token",
			lookupAll: async () => [{ address: "127.0.0.1", family: 4 }],
		})

		try {
			expect(() =>
				parseWebhookEgressUrl(`http://127.0.0.1:${victimPort}/egress`, {
					allowLoopbackHttp: false,
				}),
			).toThrow(/must use https:\/\//)
			expect(
				parseWebhookEgressUrl(egress.url, {
					allowLoopbackHttp: true,
				}),
			).toBe(egress.url)

			await Effect.runPromise(
				Effect.gen(function* () {
					const client = yield* HttpClient.HttpClient
					// 1) Local dev without egress URL fails closed instead of touching local workerd InternetLive.
					const localBlocked = makeConfiguredWebhookHttpSender(client, {
						egressUrl: null,
						egressToken: null,
						localDev: true,
					})
					const blockedRes = yield* localBlocked.send({
						url: `https://127.0.0.1.nip.io:${victimPort}/hook`,
						headers: {},
						body: "{}",
						timeoutMs: 2000,
					})
					expect(blockedRes.kind).toBe("invalid_destination")

					// 2) Configured egress proxy enforces public-only IP check at connection time.
					const viaEgress = makeConfiguredWebhookHttpSender(client, {
						egressUrl: egress.url,
						egressToken: Redacted.make("egress-secret-token"),
						localDev: true,
					})
					const egressRes = yield* viaEgress.send({
						url: `https://127.0.0.1.nip.io:${victimPort}/hook`,
						headers: { "webhook-id": "wdel_1" },
						body: "{}",
						timeoutMs: 2000,
					})
					expect(egressRes.kind).toBe("invalid_destination")

					// 3) Bad egress token is rejected with 401 -> retryable network_error, never bypasses egress.
					const badAuth = makeConfiguredWebhookHttpSender(client, {
						egressUrl: egress.url,
						egressToken: Redacted.make("wrong-token"),
						localDev: true,
					})
					const badAuthRes = yield* badAuth.send({
						url: "https://hooks.example.com/hook",
						headers: {},
						body: "{}",
						timeoutMs: 2000,
					})
					expect(badAuthRes.kind).toBe("network_error")
				}).pipe(Effect.provide(FetchHttpClient.layer)),
			)
			expect(localHits).toBe(0)
		} finally {
			await egress.close()
			await new Promise<void>((resolve) => {
				victimServer.close(() => {
					resolve()
				})
			})
		}
	})
})

describe("WebhookEventsLive propagation and resumable batched fan-out", () => {
	it.effect(
		"propagates enqueue failures instead of swallowing them, and splits large registries into resumable page batches",
		() =>
			Effect.gen(function* () {
				const listing = makeListingStoreMemory()
				const webhooksLayer = Webhooks.layer(
					WebhooksHandlersLive.pipe(Layer.provide(listing.layer)),
				).pipe(Layer.provide(Domain.InMemory))
				const listingQueryLayer = WebhookListingQueryLive.pipe(Layer.provide(webhooksLayer))

				const enqueued = new Map<string, string>()
				let failWebhookId: string | null = null
				const deliveriesLayer = Layer.succeed(WebhookDeliveryStore, {
					enqueue: (webhookId, input) =>
						Effect.suspend(() => {
							if (webhookId === failWebhookId) {
								return Effect.fail(new WebhookDeliveryStoreError({ cause: "transient DO error" }))
							}
							enqueued.set(webhookId, input.delivery_id)
							return Effect.succeed({
								id: input.delivery_id,
								webhook_id: webhookId,
								event_id: input.event_id,
								event_type: input.event_type,
								status: "pending" as const,
								attempt_count: 0,
								max_attempts: 6,
								next_attempt_at: sampleEvent.occurred_at,
								last_attempt_at: null,
								last_http_status: null,
								last_outcome: null,
								last_error: null,
								created_at: sampleEvent.occurred_at,
								updated_at: sampleEvent.occurred_at,
								completed_at: null,
							})
						}),
					listDeliveries: () => Effect.succeed({ data: [], has_more: false, next_cursor: null }),
					getDelivery: () => Effect.succeed(null),
					redeliver: () => Effect.succeed(null),
					purge: () => Effect.void,
				})

				const queuedContinuations: Array<{
					readonly event: WebhookEventPublication
					readonly cursor: string
				}> = []
				const continuationLayer = Layer.succeed(WebhookFanoutContinuation, {
					continueFanout: (event, cursor) =>
						Effect.sync(() => {
							queuedContinuations.push({ event, cursor })
						}),
				})

				const eventsLayer = makeWebhookEventsLive(listing.page, { pageSize: 4 }).pipe(
					Layer.provide(webhooksLayer),
					Layer.provide(deliveriesLayer),
					Layer.provide(continuationLayer),
					Layer.provide(Digest.layerWebCrypto),
				)

				const testLayer = Layer.mergeAll(
					webhooksLayer,
					listingQueryLayer,
					deliveriesLayer,
					eventsLayer,
					WebhookSigningMasterKeyTest,
					Digest.layerWebCrypto,
					Mac.layerWebCrypto,
				).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto))

				yield* Effect.gen(function* () {
					const webhooks = yield* WebhookEndpoint
					const webhookListing = yield* WebhookListingQuery
					const events = yield* WebhookEvents
					const deliveries = yield* WebhookDeliveryStore
					const digest = yield* Digest.Digest

					// Register 10 webhooks (spans 3 pages of 4: 4 + 4 + 2).
					const ids: Array<WebhookId> = []
					for (let i = 0; i < 10; i++) {
						const id = WebhookId.make(`whe_fanout_${String(i).padStart(2, "0")}`)
						ids.push(id)
						const receipt = yield* webhooks.send(
							new CreateWebhookEndpoint({
								webhook_id: id,
								url: `https://hooks.example.com/sub/${i}`,
								description: `Subscriber ${i}`,
								event_types: "*",
								secret_salt: "0123456789abcdef0123456789abcdef",
							}),
						)
						yield* webhookListing.waitFor(receipt)
					}

					// 1) Transient enqueue failure on page 1 must fail publish so the retrying policy retries.
					failWebhookId = ids[2]!
					const failedPublish = yield* Effect.exit(events.publish(sampleEvent))
					expect(Exit.isFailure(failedPublish)).toBe(true)
					expect(queuedContinuations).toHaveLength(0)

					// 2) Retry succeeds on page 1 (4 webhooks) and hands cursor to continuation instead of scanning all 10 inline.
					failWebhookId = null
					yield* events.publish(sampleEvent)
					expect(enqueued.size).toBe(4)
					expect(queuedContinuations).toHaveLength(1)

					// 3) Resumable continuation drains page 2 -> fails on subscriber #6 -> retries page 2 without re-running page 1 -> completes page 3!
					const page2Cursor = queuedContinuations[0]!.cursor
					const page2 = yield* listing.page(WEBHOOK_FANOUT_LISTING_FILTER, {
						take: 4,
						after: page2Cursor,
					})
					expect(page2.entries).toHaveLength(4)
					expect(page2.cursor).not.toBeNull()

					failWebhookId = ids[6]!
					const failedPage2 = yield* Effect.exit(
						fanoutWebhookPage(sampleEvent, page2.entries, { webhooks, deliveries, digest }),
					)
					expect(Exit.isFailure(failedPage2)).toBe(true)

					failWebhookId = null
					yield* fanoutWebhookPage(sampleEvent, page2.entries, { webhooks, deliveries, digest })
					expect(enqueued.size).toBe(8)

					const page3 = yield* listing.page(WEBHOOK_FANOUT_LISTING_FILTER, {
						take: 4,
						after: page2.cursor!,
					})
					expect(page3.entries).toHaveLength(2)
					expect(page3.cursor).toBeNull()
					yield* fanoutWebhookPage(sampleEvent, page3.entries, { webhooks, deliveries, digest })

					// All 10 subscribers across all 3 pages received the event with deterministic delivery IDs.
					expect(enqueued.size).toBe(10)
					for (const id of ids) {
						expect(enqueued.has(id)).toBe(true)
					}
				}).pipe(Effect.provide(testLayer))
			}),
	)
})
