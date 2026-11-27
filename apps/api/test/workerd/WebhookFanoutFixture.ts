import * as Cloudflare from "@alchemy.run/cloudflare"
import { InMemory } from "@alchemy.run/domain/InMemory"
import { ListingStore } from "@checkfu/domain/Listing/ListingStore"
import { CreateWebhookEndpoint } from "@checkfu/domain/Webhook/CreateWebhookEndpoint.command"
import { WebhookEndpoint } from "@checkfu/domain/Webhook/WebhookEndpoint.aggregate"
import type { WebhookEventPublication } from "@checkfu/domain/Webhook/WebhookEvents.external"
import { Webhooks, WebhooksHandlersLive } from "@checkfu/domain/Webhooks.model"
import { WebhookId } from "@checkfu/sdk/Schemas"
import type { RuntimeContext } from "alchemy/RuntimeContext"
import * as Clock from "effect/Clock"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import { COMPATIBILITY_DATE } from "../../src/Compatibility.ts"
import { WebhookListingQuery, WebhookListingQueryLive } from "../../src/Http/Listing.ts"
import { placedStub } from "../../src/Placement.ts"
import { webhookFanoutImplementation } from "../../src/Webhooks/WebhookFanout.do.ts"
import {
	WebhookDeliveryStore,
	WebhookDeliveryStoreError,
} from "../../src/Webhooks/WebhookDeliveryStore.ts"
import type { WebhookDeliveryRecord } from "../../src/Webhooks/WebhookDeliveryStore.ts"
import {
	WEBHOOK_FANOUT_LISTING_FILTER,
	WEBHOOK_FANOUT_PAGE_SIZE,
	fanoutWebhookPage,
} from "../../src/Webhooks/WebhookEventsLive.ts"

const eventId = "evt_fanout_retry_fixture"
const jobId = `cleanup:${eventId}`
const subscriberId = (index: number): WebhookId =>
	WebhookId.make(`whe_retry_fixture_${String(index).padStart(3, "0")}`)
const retrySubscriberId = subscriberId(WEBHOOK_FANOUT_PAGE_SIZE + 1)
const retrySubscriberCount = WEBHOOK_FANOUT_PAGE_SIZE * 2 + 1

interface DeliveryAttempt {
	readonly webhookId: WebhookId
	readonly deliveryId: string
}

export interface FanoutStatus {
	readonly retrySubscriberId: WebhookId
	readonly subscriberCount: number
	readonly started: boolean | null
	readonly scanDone: boolean | null
	readonly pendingCount: number | null
	readonly retryPending: boolean | null
	readonly jobs: ReadonlyArray<{ readonly callback: string; readonly scheduled_at: number }>
	readonly attempts: ReadonlyArray<DeliveryAttempt>
	readonly deliveries: ReadonlyArray<DeliveryAttempt>
}

interface FixtureShape {
	readonly publish: () => Effect.Effect<void, never, RuntimeContext>
	readonly snapshot: () => Effect.Effect<FanoutStatus, never, RuntimeContext>
	readonly releaseRetry: () => Effect.Effect<void>
	readonly advanceCleanup: () => Effect.Effect<void, never, RuntimeContext>
}

class FanoutFixture extends Cloudflare.DurableObject<FanoutFixture, FixtureShape>()(
	"FanoutFixture",
) {}

const FixtureLive = FanoutFixture.make(
	Effect.map(
		Effect.gen(function* () {
			const state = yield* Cloudflare.DurableObjectState
			const listing = yield* ListingStore
			const webhooks = yield* WebhookEndpoint
			const webhookListing = yield* WebhookListingQuery
			const digest = yield* Digest.Digest
			const release = yield* Deferred.make<void>()
			const attempts: Array<DeliveryAttempt> = []
			const deliveries = new Map<string, DeliveryAttempt>()
			let failedOnce = false
			const store: WebhookDeliveryStore["Service"] = {
				enqueue: (webhookId, input) =>
					Effect.gen(function* () {
						const attempt = { webhookId, deliveryId: input.delivery_id }
						attempts.push(attempt)
						if (webhookId === retrySubscriberId) {
							if (!failedOnce) {
								failedOnce = true
								return yield* new WebhookDeliveryStoreError({ cause: "Fixture enqueue failure" })
							}
							yield* Deferred.await(release)
						}
						deliveries.set(input.delivery_id, attempt)
						const now = yield* Clock.currentTimeMillis
						return {
							id: input.delivery_id,
							webhook_id: webhookId,
							event_id: input.event_id,
							event_type: input.event_type,
							status: "pending",
							attempt_count: 0,
							max_attempts: 6,
							next_attempt_at: now,
							last_attempt_at: null,
							last_http_status: null,
							last_outcome: null,
							last_error: null,
							created_at: now,
							updated_at: now,
							completed_at: null,
						} satisfies WebhookDeliveryRecord
					}),
				listDeliveries: () => Effect.die(new Error("Unexpected delivery list in fan-out fixture")),
				getDelivery: () => Effect.die(new Error("Unexpected delivery read in fan-out fixture")),
				redeliver: () => Effect.die(new Error("Unexpected redelivery in fan-out fixture")),
				purge: () => Effect.die(new Error("Unexpected delivery purge in fan-out fixture")),
			}
			const init = yield* webhookFanoutImplementation.pipe(
				Effect.provideService(WebhookDeliveryStore, store),
			)
			return {
				init,
				state,
				listing,
				webhooks,
				webhookListing,
				digest,
				store,
				attempts,
				deliveries,
				release,
			}
		}),
		({
			init,
			state,
			listing,
			webhooks,
			webhookListing,
			digest,
			store,
			attempts,
			deliveries,
			release,
		}) =>
			Effect.map(init, (fanout) => {
				let event: WebhookEventPublication | undefined
				return {
					publish: () =>
						Effect.gen(function* () {
							if (event === undefined) {
								for (let index = 0; index < retrySubscriberCount; index++) {
									const receipt = yield* webhooks
										.send(
											new CreateWebhookEndpoint({
												webhook_id: subscriberId(index),
												url: "https://receiver.example.test/callback",
												description: "Fan-out fixture subscriber",
												event_types: "agent.created",
												secret_salt: "0123456789abcdef0123456789abcdef",
											}),
										)
										.pipe(Effect.orDie)
									yield* webhookListing.waitFor(receipt).pipe(Effect.orDie)
								}
								event = {
									event_id: eventId,
									event_type: "agent.created",
									resource_type: "agent",
									resource_id: "agent_fanout_retry_fixture",
									occurred_at: yield* Clock.currentTimeMillis,
								}
							}
							const page = yield* listing.page(WEBHOOK_FANOUT_LISTING_FILTER, {
								take: WEBHOOK_FANOUT_PAGE_SIZE,
								after: undefined,
							})
							if (page.entries.length !== WEBHOOK_FANOUT_PAGE_SIZE || page.cursor === null) {
								return yield* Effect.die(new Error("Fixture subscribers did not fill a page"))
							}
							const result = yield* fanoutWebhookPage(event, page.entries, {
								webhooks,
								deliveries: store,
								digest,
							})
							yield* fanout
								.enqueue(event, {
									afterCursor: page.cursor,
									retryWebhookIds: result.failedWebhookIds,
								})
								.pipe(Effect.orDie)
						}),
					snapshot: () =>
						Effect.gen(function* () {
							const key = `ev:${eventId}`
							const started = (yield* state.storage.get<boolean>(`${key}:started`)) ?? null
							const scanDone = (yield* state.storage.get<boolean>(`${key}:done`)) ?? null
							const pendingCount =
								(yield* state.storage.get<number>(`${key}:pending_count`)) ?? null
							const retryPending =
								(yield* state.storage.get<boolean>(`${key}:retry:${retrySubscriberId}`)) ?? null
							const jobs = state.raw.storage.sql
								.exec<{ callback: string; scheduled_at: number }>(
									"SELECT callback, scheduled_at FROM alchemy_alarm_callbacks ORDER BY callback",
								)
								.toArray()
							return {
								retrySubscriberId,
								subscriberCount: retrySubscriberCount,
								started,
								scanDone,
								pendingCount,
								retryPending,
								jobs,
								attempts: [...attempts],
								deliveries: [...deliveries.values()],
							}
						}).pipe(Effect.orDie),
					releaseRetry: () => Deferred.succeed(release, undefined).pipe(Effect.asVoid),
					advanceCleanup: () =>
						Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis
							// Advance the fixture's scheduled deadline and let the real alarm run cleanup.
							state.raw.storage.sql.exec(
								"UPDATE alchemy_alarm_callbacks SET run_at = ?, scheduled_at = ? WHERE callback = 'cleanup' AND id = ?",
								now,
								now,
								jobId,
							)
							yield* Effect.promise(() => state.raw.storage.setAlarm(now))
						}),
				} satisfies FixtureShape
			}),
	),
)

const WebhooksLive = Webhooks.layer(WebhooksHandlersLive).pipe(
	Layer.provideMerge(ListingStore.memory),
	Layer.provide(InMemory),
)
const FixtureDependencies = WebhookListingQueryLive.pipe(Layer.provideMerge(WebhooksLive))

export class FanoutTestWorker extends Cloudflare.Worker<FanoutTestWorker, Record<never, never>>()(
	"FanoutTestWorker",
) {}

export default FanoutTestWorker.make(
	{ main: import.meta.url, compatibility: { date: COMPATIBILITY_DATE }, dev: { port: 1389 } },
	Effect.gen(function* () {
		const stub = placedStub(yield* FanoutFixture, {})
		return {
			fetch: Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				const path = new URL(request.url, "http://fixture.test").pathname
				const fixture = stub("fanout")
				if (request.method === "POST" && path === "/publish") {
					yield* fixture.publish()
				}
				if (request.method === "POST" && path === "/release") {
					yield* fixture.releaseRetry()
				}
				if (request.method === "POST" && path === "/cleanup") {
					yield* fixture.advanceCleanup()
				}
				return path === "/status"
					? HttpServerResponse.jsonUnsafe(yield* fixture.snapshot())
					: HttpServerResponse.empty({ status: 200 })
			}),
		}
	}).pipe(
		Effect.provide(
			FixtureLive.pipe(
				Layer.provide(FixtureDependencies),
				Layer.provide(Digest.layerWebCrypto),
				Layer.provide(SecureRandom.layerWebCrypto),
			),
		),
	),
)
