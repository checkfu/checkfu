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
import { AlchemyContext } from "alchemy/AlchemyContext"
import { Stage } from "alchemy/Stage"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Digest from "effect/crypto/Digest"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import {
	WEBHOOK_EGRESS_TARGET_HEADER,
	WEBHOOK_EGRESS_TIMEOUT_HEADER,
} from "../src/Webhooks/WebhookEgressConfig.ts"
import {
	WebhookDeliveryStore,
	WebhookDeliveryStoreError,
} from "../src/Webhooks/WebhookDeliveryStore.ts"
import {
	MAX_EGRESS_REPORT_BYTES,
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
import {
	WEBHOOK_FANOUT_SHARD_COUNT,
	webhookFanoutShardId,
} from "../src/Webhooks/WebhookFanout.do.ts"
import { WebhookListingQuery, WebhookListingQueryLive } from "../src/Http/Listing.ts"
import { WebhookSigningMasterKeyTest } from "../src/Webhooks/WebhookSigning.ts"

const sampleEvent: WebhookEventPublication = {
	event_id: "evt_agent_agt_1_1",
	event_type: "agent.created",
	resource_type: "agent",
	resource_id: "agt_1",
	occurred_at: Date.parse("2026-01-01T00:00:00.000Z"),
}

describe("Webhook egress", () => {
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

	it("bounds and validates an egress report before treating it as a receiver response", async () => {
		const send = (report: Response) =>
			Effect.runPromise(
				makeConfiguredWebhookHttpSender(
					HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, report))),
					{ egressUrl: "https://relay.example.com/egress", egressToken: null, localRuntime: true },
				).send({ url: "https://hooks.example.com/hook", headers: {}, body: "{}", timeoutMs: 50 }),
			)
		for (const status of [200, 299, 400, 599]) {
			const json = JSON.stringify({ kind: "response", status })
			const exact = json.padEnd(MAX_EGRESS_REPORT_BYTES, " ")
			expect(await send(new Response(exact))).toEqual({ kind: "response", status })
		}
		for (const bad of [
			JSON.stringify({ kind: "response", status: 199 }),
			JSON.stringify({ kind: "response", status: 600 }),
			JSON.stringify({ kind: "response", status: 201.5 }),
			JSON.stringify({ kind: "response", status: "204" }),
			"{",
			new Uint8Array([0xff]),
			'{"kind":"timeout"}'.padEnd(MAX_EGRESS_REPORT_BYTES + 1, " "),
		]) {
			expect(await send(new Response(bad))).toMatchObject({ kind: "egress_error" })
		}

		const encoder = new TextEncoder()
		const bytes = encoder.encode('{"kind":"network_error","message":"é"}')
		const split = bytes.indexOf(0xc3) + 1
		const chunks = new ReadableStream<Uint8Array>({
			start: (controller) => {
				controller.enqueue(bytes.subarray(0, split))
				controller.enqueue(bytes.subarray(split))
				controller.close()
			},
		})
		expect(await send(new Response(chunks))).toEqual({ kind: "network_error", message: "é" })

		for (const declared of [false, true]) {
			let pulls = 0
			let cancelled = 0
			const body = new ReadableStream<Uint8Array>(
				{
					pull: (controller) => {
						pulls += 1
						controller.enqueue(new Uint8Array(MAX_EGRESS_REPORT_BYTES + 1))
					},
					cancel: () => {
						cancelled += 1
						return new Promise<void>(() => {})
					},
				},
				{ highWaterMark: 0 },
			)
			const headers = declared ? { "content-length": String(MAX_EGRESS_REPORT_BYTES + 1) } : {}
			expect(await send(new Response(body, { headers }))).toMatchObject({ kind: "egress_error" })
			expect(pulls).toBe(declared ? 0 : 1)
			expect(cancelled).toBe(1)
			expect(body.locked).toBe(false)
		}
	})

	it("fails closed without local egress and keeps the relay request and failure contract", async () => {
		const target = "https://hooks.example.com/hook"
		const seen: Array<{
			readonly target: string | undefined
			readonly timeout: string | undefined
			readonly eventId: string | undefined
			readonly body: string
		}> = []
		const relay = http.createServer((request, response) => {
			if (request.headers.authorization !== "Bearer egress-secret-token") {
				response.writeHead(401).end()
				return
			}
			let body = ""
			request.setEncoding("utf8")
			request.on("data", (chunk: string) => {
				body += chunk
			})
			request.on("end", () => {
				seen.push({
					target: request.headers[WEBHOOK_EGRESS_TARGET_HEADER]?.toString(),
					timeout: request.headers[WEBHOOK_EGRESS_TIMEOUT_HEADER]?.toString(),
					eventId: request.headers["webhook-id"]?.toString(),
					body,
				})
				response.writeHead(200, { "content-type": "application/json" })
				response.end(
					JSON.stringify({ kind: "invalid_destination", message: "Destination refused." }),
				)
			})
		})
		try {
			await new Promise<void>((resolve, reject) => {
				relay.once("error", reject)
				relay.listen(0, "127.0.0.1", resolve)
			})
			const address = relay.address()
			if (address === null || typeof address === "string") {
				throw new Error("Expected a local relay port.")
			}
			const egressUrl = `http://127.0.0.1:${address.port}/egress`
			expect(() => parseWebhookEgressUrl(egressUrl, { allowLoopbackHttp: false })).toThrow(
				/must use https:\/\//,
			)
			expect(parseWebhookEgressUrl(egressUrl, { allowLoopbackHttp: true })).toBe(egressUrl)

			await Effect.runPromise(
				Effect.gen(function* () {
					const client = yield* HttpClient.HttpClient
					const request = {
						url: target,
						headers: { "webhook-id": "evt_1" },
						body: "{}",
						timeoutMs: 2000,
					}
					const local = makeConfiguredWebhookHttpSender(client, {
						egressUrl: null,
						egressToken: null,
						localRuntime: true,
					})
					expect((yield* local.send(request)).kind).toBe("egress_unconfigured")
					expect(seen).toEqual([])

					const enabled = (token: string) =>
						makeConfiguredWebhookHttpSender(client, {
							egressUrl,
							egressToken: Redacted.make(token),
							localRuntime: true,
						})
					expect((yield* enabled("egress-secret-token").send(request)).kind).toBe(
						"invalid_destination",
					)
					expect((yield* enabled("wrong-token").send(request)).kind).toBe("egress_error")
					expect(seen).toEqual([{ target, timeout: "2000", eventId: "evt_1", body: "{}" }])
				}).pipe(Effect.provide(FetchHttpClient.layer)),
			)
		} finally {
			relay.closeAllConnections()
			await new Promise<void>((resolve) => {
				relay.close(() => resolve())
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
					listDeliveries: () => Effect.succeed({ data: [], next_page: null }),
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

	it("routes fan-out continuations deterministically onto a bounded shard pool", () => {
		const shards = new Set<string>()
		for (let i = 0; i < 200; i++) {
			const eventId = `evt_agent_agt_${i}_${i + 1}`
			const shard = webhookFanoutShardId(eventId)
			expect(shard).toBe(webhookFanoutShardId(eventId))
			expect(shard).toMatch(/^shard_\d+$/u)
			const index = Number(shard.slice("shard_".length))
			expect(index).toBeGreaterThanOrEqual(0)
			expect(index).toBeLessThan(WEBHOOK_FANOUT_SHARD_COUNT)
			shards.add(shard)
		}
		expect(shards.size).toBe(WEBHOOK_FANOUT_SHARD_COUNT)
	})
})
