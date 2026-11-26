import { EventEmitter } from "node:events"
import * as http from "node:http"
import type * as https from "node:https"
import * as Domain from "@alchemy.run/domain"
import { makeListingStoreMemory } from "@checkfu/domain/Listing/ListingStore"
import { CreateWebhookEndpoint } from "@checkfu/domain/Webhook/CreateWebhookEndpoint.command"
import { WebhookEndpoint } from "@checkfu/domain/Webhook/WebhookEndpoint.aggregate"
import { WebhookEvents } from "@checkfu/domain/Webhook/WebhookEvents.external"
import type { WebhookEventPublication } from "@checkfu/domain/Webhook/WebhookEvents.external"
import { Webhooks, WebhooksHandlersLive } from "@checkfu/domain/Webhooks.model"
import { WebhookId } from "@checkfu/sdk/Schemas"
import { describe, expect, it } from "@effect/vitest"
import { AlchemyContext } from "alchemy/AlchemyContext"
import { Stage } from "alchemy/Stage"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Digest from "effect/crypto/Digest"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
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
	WEBHOOK_EGRESS_URL_ENV,
	WEBHOOK_LOCAL_RUNTIME_ENV,
	WEBHOOK_LOCAL_RUNTIME_VALUE,
	apiWorkerWebhookEgressProps,
	makeConfiguredWebhookHttpSender,
	parseWebhookEgressUrl,
	readWebhookEgressConfig,
} from "../src/Webhooks/WebhookEgress.ts"
import {
	WEBHOOK_FANOUT_LISTING_FILTER,
	WebhookFanoutContinuation,
	fanoutWebhookPage,
	makeWebhookEventsLive,
} from "../src/Webhooks/WebhookEventsLive.ts"
import type { WebhookFanoutWork } from "../src/Webhooks/WebhookEventsLive.ts"
import { WebhookListingQuery, WebhookListingQueryLive } from "../src/Http/Listing.ts"
import { WebhookSigningMasterKeyTest } from "../src/Webhooks/WebhookSigning.ts"

const sampleEvent: WebhookEventPublication = {
	event_id: "evt_agent_agt_1_1",
	event_type: "agent.created",
	resource_type: "agent",
	resource_id: "agt_1",
	occurred_at: Date.parse("2026-01-01T00:00:00.000Z"),
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

	it("enforces an end-to-end deadline across DNS resolution and prevents late lookups from connecting", async () => {
		let connectAttempts = 0
		let releaseLookup!: (
			addrs: ReadonlyArray<{ readonly address: string; readonly family: number }>,
		) => void
		const slowLookup = () =>
			new Promise<ReadonlyArray<{ readonly address: string; readonly family: number }>>(
				(resolve) => {
					releaseLookup = resolve
				},
			)
		const fakeHttpsRequest = (() => {
			connectAttempts += 1
			throw new Error("should never start after deadline expired")
		}) as unknown as typeof https.request

		const result = await deliverThroughPublicHttps({
			targetUrl: "https://slow-dns.example.com/hook",
			headers: {},
			body: Buffer.from("{}"),
			timeoutMs: 40,
			lookupAll: slowLookup,
			httpsRequest: fakeHttpsRequest,
		})
		expect(result).toEqual({ kind: "timeout" })
		releaseLookup([{ address: "93.184.216.34", family: 4 }])
		await new Promise((resolve) => {
			setTimeout(resolve, 25)
		})
		expect(connectAttempts).toBe(0)
	})

	it("supplies all verified addresses for family selection and falls back to the next verified address on pre-TLS connect failure", async () => {
		const seenPrimaryAddresses: Array<string> = []
		const seenAllCounts: Array<number> = []
		const fakeHttpsRequest = ((
			options: https.RequestOptions,
			onResponse?: (res: http.IncomingMessage) => void,
		) => {
			const req = new EventEmitter() as EventEmitter & {
				end: () => void
				destroy: () => void
			}
			req.destroy = () => undefined
			req.end = () => {
				const lookup = options.lookup
				if (lookup === undefined) {
					throw new Error("Expected custom pinned lookup")
				}
				lookup("dualstack.example.com", { all: true }, (_err, allResult) => {
					if (Array.isArray(allResult)) {
						seenAllCounts.push(allResult.length)
					}
				})
				lookup("dualstack.example.com", {}, (_err, address) => {
					if (typeof address !== "string") {
						throw new Error("Expected string address")
					}
					seenPrimaryAddresses.push(address)
					if (seenPrimaryAddresses.length === 1) {
						queueMicrotask(() => {
							req.emit("error", new Error("ENETUNREACH"))
						})
						return
					}
					const socket = Object.assign(new EventEmitter(), {
						connecting: false,
						destroyed: false,
						remoteAddress: address,
						destroy: () => undefined,
					})
					queueMicrotask(() => {
						req.emit("socket", socket)
						socket.emit("secureConnect")
						const res = Object.assign(new EventEmitter(), {
							statusCode: 204,
							resume: () => undefined,
							destroy: () => undefined,
						}) as unknown as http.IncomingMessage
						onResponse?.(res)
					})
				})
			}
			return req as unknown as http.ClientRequest
		}) as unknown as typeof https.request

		const result = await deliverThroughPublicHttps({
			targetUrl: "https://dualstack.example.com/hook",
			headers: {},
			body: Buffer.from("{}"),
			timeoutMs: 2000,
			lookupAll: async () => [
				{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
				{ address: "93.184.216.34", family: 4 },
			],
			httpsRequest: fakeHttpsRequest,
		})
		expect(result).toEqual({ kind: "response", status: 204 })
		expect(seenAllCounts).toEqual([2, 1])
		expect(seenPrimaryAddresses).toEqual(["2606:2800:220:1:248:1893:25c8:1946", "93.184.216.34"])
	})

	it.effect(
		"disables direct delivery in EVERY local runtime even when stage is production, while keeping loopback HTTP disallowed in production",
		() =>
			Effect.gen(function* () {
				const devProdProps = yield* apiWorkerWebhookEgressProps.pipe(
					Effect.provide([
						Layer.succeed(AlchemyContext, { dev: true } as unknown as AlchemyContext["Service"]),
						Layer.succeed(Stage, "production"),
						ConfigProvider.layer(ConfigProvider.fromUnknown({})),
					]),
				)
				expect(devProdProps.env?.[WEBHOOK_LOCAL_RUNTIME_ENV]).toBe(WEBHOOK_LOCAL_RUNTIME_VALUE)

				const runtimeConfig = yield* readWebhookEgressConfig.pipe(
					Effect.provide(
						ConfigProvider.layer(
							ConfigProvider.fromUnknown({
								ALCHEMY_STAGE: "production",
								[WEBHOOK_LOCAL_RUNTIME_ENV]: WEBHOOK_LOCAL_RUNTIME_VALUE,
							}),
						),
					),
				)
				expect(runtimeConfig.localRuntime).toBe(true)
				expect(runtimeConfig.egressUrl).toBeNull()

				// Loopback http:// proxy is still rejected when stage === "production",
				// while an https:// proxy URL is permitted in local production stage.
				const exitHttp = yield* Effect.exit(
					apiWorkerWebhookEgressProps.pipe(
						Effect.provide([
							Layer.succeed(AlchemyContext, {
								dev: true,
							} as unknown as AlchemyContext["Service"]),
							Layer.succeed(Stage, "production"),
							ConfigProvider.layer(
								ConfigProvider.fromUnknown({
									[WEBHOOK_EGRESS_URL_ENV]: "http://127.0.0.1:9999/egress",
								}),
							),
						]),
					),
				)
				expect(exitHttp._tag).toBe("Failure")

				const httpsInLocalProd = yield* apiWorkerWebhookEgressProps.pipe(
					Effect.provide([
						Layer.succeed(AlchemyContext, { dev: true } as unknown as AlchemyContext["Service"]),
						Layer.succeed(Stage, "production"),
						ConfigProvider.layer(
							ConfigProvider.fromUnknown({
								[WEBHOOK_EGRESS_URL_ENV]: "https://egress.example.com/hook",
							}),
						),
					]),
				)
				expect(httpsInLocalProd.env?.[WEBHOOK_LOCAL_RUNTIME_ENV]).toBe(WEBHOOK_LOCAL_RUNTIME_VALUE)
				expect(httpsInLocalProd.env?.[WEBHOOK_EGRESS_URL_ENV]).toBe(
					"https://egress.example.com/hook",
				)
			}),
	)

	it("fails closed in local runtime without CHECKFU_WEBHOOK_EGRESS_URL and returns egress_error on proxy auth/outage", async () => {
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
					const localBlocked = makeConfiguredWebhookHttpSender(client, {
						egressUrl: null,
						egressToken: null,
						localRuntime: true,
					})
					const blockedRes = yield* localBlocked.send({
						url: `https://127.0.0.1.nip.io:${victimPort}/hook`,
						headers: {},
						body: "{}",
						timeoutMs: 2000,
					})
					expect(blockedRes.kind).toBe("invalid_destination")

					const viaEgress = makeConfiguredWebhookHttpSender(client, {
						egressUrl: egress.url,
						egressToken: Redacted.make("egress-secret-token"),
						localRuntime: true,
					})
					const egressRes = yield* viaEgress.send({
						url: `https://127.0.0.1.nip.io:${victimPort}/hook`,
						headers: { "webhook-id": "evt_1" },
						body: "{}",
						timeoutMs: 2000,
					})
					expect(egressRes.kind).toBe("invalid_destination")

					// Proxy auth failure / outage returns egress_error so endpoint health is not degraded.
					const badAuth = makeConfiguredWebhookHttpSender(client, {
						egressUrl: egress.url,
						egressToken: Redacted.make("wrong-token"),
						localRuntime: true,
					})
					const badAuthRes = yield* badAuth.send({
						url: "https://hooks.example.com/hook",
						headers: {},
						body: "{}",
						timeoutMs: 2000,
					})
					expect(badAuthRes.kind).toBe("egress_error")
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

describe("WebhookEventsLive isolation, event-time bounds, and resumable batched fan-out", () => {
	it.effect(
		"isolates saturated subscribers so later pages still receive events, and bounds fan-out to endpoints registered at or before event.occurred_at",
		() =>
			Effect.gen(function* () {
				const listing = makeListingStoreMemory()
				const webhooksLayer = Webhooks.layer(
					WebhooksHandlersLive.pipe(Layer.provide(listing.layer)),
				).pipe(Layer.provide(Domain.InMemory))
				const listingQueryLayer = WebhookListingQueryLive.pipe(Layer.provide(webhooksLayer))

				const enqueued = new Map<string, string>()
				const fullQueues = new Set<string>()
				const deliveriesLayer = Layer.succeed(WebhookDeliveryStore, {
					enqueue: (webhookId, input) =>
						Effect.suspend(() => {
							if (fullQueues.has(webhookId)) {
								return Effect.fail(
									new WebhookDeliveryStoreError({ cause: "pending delivery queue is full (1000)" }),
								)
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
					readonly work: WebhookFanoutWork
				}> = []
				const continuationLayer = Layer.succeed(WebhookFanoutContinuation, {
					continueFanout: (event, work) =>
						Effect.sync(() => {
							queuedContinuations.push({ event, work })
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

					// Register 10 webhooks before the event occurs (spans 3 pages of 4: 4 + 4 + 2).
					const ids: Array<WebhookId> = []
					let latestCreatedAt = 0
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
						const state = yield* webhooks.get(id)
						latestCreatedAt = Math.max(latestCreatedAt, state.created_at)
					}

					const boundedEvent: WebhookEventPublication = {
						...sampleEvent,
						occurred_at: latestCreatedAt,
					}

					// Register a latecomer strictly AFTER event.occurred_at — must never receive boundedEvent.
					const lateId = WebhookId.make("whe_fanout_late_99")
					const lateReceipt = yield* webhooks.send(
						new CreateWebhookEndpoint({
							webhook_id: lateId,
							url: "https://hooks.example.com/sub/late",
							description: "Latecomer",
							event_types: "*",
							secret_salt: "0123456789abcdef0123456789abcdef",
						}),
					)
					yield* webhookListing.waitFor(lateReceipt)
					// Ensure listing entry for latecomer has created_at > event.occurred_at.
					yield* listing.record([
						{
							kind: "webhook",
							id: lateId,
							created_at: latestCreatedAt + 1000,
							agent_id: null,
							status: 0,
						},
					])
					// Also test a fresh listing record with strictly later created_at.
					const laterStillId = WebhookId.make("whe_fanout_late_100")
					yield* listing.record([
						{
							kind: "webhook",
							id: laterStillId,
							created_at: latestCreatedAt + 5000,
							agent_id: null,
							status: 0,
						},
					])

					// 1) Saturate subscriber #2 on page 1: page 1 STILL enqueues the other 3 healthy
					//    subscribers AND schedules continuation with both afterCursor AND retryWebhookIds=[ids[2]].
					fullQueues.add(ids[2]!)
					yield* events.publish(boundedEvent)
					expect(enqueued.size).toBe(3)
					expect(enqueued.has(ids[2]!)).toBe(false)
					expect(queuedContinuations).toHaveLength(1)
					expect(queuedContinuations[0]!.work.retryWebhookIds).toEqual([ids[2]!])
					expect(queuedContinuations[0]!.work.afterCursor).not.toBeNull()

					// 2) Drain page 2 even while subscriber #2 is STILL saturated AND subscriber #6 is also full.
					fullQueues.add(ids[6]!)
					const page2 = yield* listing.page(WEBHOOK_FANOUT_LISTING_FILTER, {
						take: 4,
						after: queuedContinuations[0]!.work.afterCursor!,
					})
					const page2Result = yield* fanoutWebhookPage(boundedEvent, page2.entries, {
						webhooks,
						deliveries,
						digest,
					})
					expect(page2Result.failedWebhookIds).toEqual([ids[6]!])
					expect(page2Result.reachedEventTimeBound).toBe(false)
					expect(enqueued.size).toBe(6)

					// 3) Drain page 3: encounters the latecomer created AFTER event.occurred_at,
					//    excludes it, and signals reachedEventTimeBound = true to stop pagination!
					const page3 = yield* listing.page(WEBHOOK_FANOUT_LISTING_FILTER, {
						take: 4,
						after: page2.cursor!,
					})
					const page3Result = yield* fanoutWebhookPage(boundedEvent, page3.entries, {
						webhooks,
						deliveries,
						digest,
					})
					expect(page3Result.failedWebhookIds).toEqual([])
					expect(page3Result.reachedEventTimeBound).toBe(true)
					expect(enqueued.has(laterStillId)).toBe(false)
					expect(enqueued.size).toBe(8)
					// Healthy subscribers on page 3 received the event even while #2 and #6 remained full!
					expect(enqueued.has(ids[8]!)).toBe(true)
					expect(enqueued.has(ids[9]!)).toBe(true)
				}).pipe(Effect.provide(testLayer))
			}),
	)
})
