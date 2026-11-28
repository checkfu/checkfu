import * as Cloudflare from "@alchemy.run/cloudflare"
import { ListingStore } from "@checkfu/domain/Listing/ListingStore"
import { WebhookEndpoint } from "@checkfu/domain/Webhook/WebhookEndpoint.aggregate"
import type { WebhookEventPublication } from "@checkfu/domain/Webhook/WebhookEvents.external"
import type { WebhookId } from "@checkfu/sdk/Schemas"
import * as Alchemy from "alchemy"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { placedStub, placement } from "../Placement.ts"
import { FANOUT_PAGE_CALLBACK, RETRY_SUBSCRIBER_CALLBACK } from "./FanoutPayloads.ts"
import type { FanoutPagePayload, RetrySubscriberPayload } from "./FanoutPayloads.ts"
import {
	WebhookDeliveryStore,
	WebhookDeliveryStoreError,
	buildWebhookEventEnvelopeJson,
} from "./WebhookDeliveryStore.ts"
import {
	WEBHOOK_FANOUT_LISTING_FILTER,
	WEBHOOK_FANOUT_PAGE_SIZE,
	WebhookFanoutContinuation,
	enqueueWebhookSubscriber,
	fanoutWebhookPage,
} from "./WebhookEventsLive.ts"
import type { WebhookFanoutWork } from "./WebhookEventsLive.ts"

const storeError = (cause: unknown) => new WebhookDeliveryStoreError({ cause })

const overWire = <A, R>(effect: Effect.Effect<A, WebhookDeliveryStoreError, R>) =>
	Effect.mapError(effect, (error) => storeError(String(error.cause)))

export const WEBHOOK_FANOUT_MAX_RETRY_AGE_MS = 14 * 24 * 60 * 60 * 1000
export const WEBHOOK_FANOUT_SHARD_COUNT = 16

/**
 * Deterministically routes an event publication onto a bounded pool of
 * `WebhookFanout` Durable Object shards (`shard_0`..`shard_15`). Bounding the
 * shard count bounds the number of SQLite databases while allowing fan-out in parallel.
 */
export const webhookFanoutShardId = (eventId: string): string => {
	let hash = 2_166_136_261
	for (let index = 0; index < eventId.length; index++) {
		hash ^= eventId.charCodeAt(index)
		hash = Math.imul(hash, 16_777_619)
	}
	hash ^= hash >>> 16
	hash = Math.imul(hash, 2_246_822_507)
	hash ^= hash >>> 13
	return `shard_${(hash >>> 0) % WEBHOOK_FANOUT_SHARD_COUNT}`
}

export interface WebhookFanoutShape {
	readonly enqueue: (
		event: WebhookEventPublication,
		work: WebhookFanoutWork,
	) => Effect.Effect<void, WebhookDeliveryStoreError, RuntimeContext>
}

export class WebhookFanout extends Cloudflare.DurableObject<WebhookFanout, WebhookFanoutShape>()(
	"WebhookFanout",
) {}

const scanJobId = (eventId: string) => `scan:${eventId}`
const retryJobId = (eventId: string, webhookId: WebhookId) => `retry:${eventId}:${webhookId}`

export const webhookFanoutImplementation = Effect.gen(function* () {
	const state = yield* Cloudflare.DurableObjectState
	const listing = yield* ListingStore
	const webhooks = yield* WebhookEndpoint
	const deliveries = yield* WebhookDeliveryStore
	const digest = yield* Digest.Digest
	const random = yield* SecureRandom.SecureRandom
	return { state, listing, webhooks, deliveries, digest, random }
}).pipe(
	Effect.map(({ state, listing, webhooks, deliveries, digest, random }) =>
		Effect.gen(function* () {
			const onRetrySubscriber = yield* Alchemy.makeCallback(
				RETRY_SUBSCRIBER_CALLBACK,
				Effect.fn(function* (payload: RetrySubscriberPayload) {
					const now = yield* Clock.currentTimeMillis
					if (now - payload.event.occurred_at >= WEBHOOK_FANOUT_MAX_RETRY_AGE_MS) {
						yield* Effect.logWarning(
							"Dropping webhook fan-out subscriber retry past retention window",
							{
								webhook_id: payload.webhookId,
								event_id: payload.event.event_id,
							},
						)
						return
					}

					const payloadJson = buildWebhookEventEnvelopeJson(payload.event)
					yield* enqueueWebhookSubscriber(payload.event, payload.webhookId, payloadJson, {
						webhooks,
						deliveries,
						digest,
					}).pipe(Effect.orDie)
				}),
			)

			const scheduleRetries = Effect.fn(function* (
				event: WebhookEventPublication,
				webhookIds: ReadonlyArray<WebhookId>,
			) {
				for (const webhookId of webhookIds) {
					const id = retryJobId(event.event_id, webhookId)
					if ((yield* onRetrySubscriber.getStatus(id)) === undefined) {
						yield* onRetrySubscriber.schedule(id, {
							after: "2 seconds",
							payload: { event, webhookId },
						})
					}
				}
			})
			const schedulePage = (event: WebhookEventPublication, cursor: string, step: number) =>
				onPage.schedule(scanJobId(event.event_id), {
					after: "0 seconds",
					payload: { event, cursor, step },
					progress: step,
				})

			const onPage: Alchemy.Callback<FanoutPagePayload> = yield* Alchemy.makeCallback(
				FANOUT_PAGE_CALLBACK,
				Effect.fn(function* (payload: FanoutPagePayload) {
					const page = yield* listing.page(WEBHOOK_FANOUT_LISTING_FILTER, {
						take: WEBHOOK_FANOUT_PAGE_SIZE,
						after: payload.cursor,
					})
					const result = yield* fanoutWebhookPage(payload.event, page.entries, {
						webhooks,
						deliveries,
						digest,
					})
					const nextCursor = result.reachedEventTimeBound ? null : page.cursor
					yield* state.storage
						.transaction(
							Effect.gen(function* () {
								yield* scheduleRetries(payload.event, result.failedWebhookIds)
								if (nextCursor !== null) {
									yield* schedulePage(payload.event, nextCursor, payload.step + 1)
								}
							}),
						)
						.pipe(Effect.orDie)
				}),
			)

			return {
				enqueue: (event, work) =>
					overWire(
						state.storage
							.transaction(
								Effect.gen(function* () {
									yield* scheduleRetries(event, work.retryWebhookIds)
									if (work.afterCursor !== null) {
										yield* schedulePage(event, work.afterCursor, 1)
									}
								}),
							)
							.pipe(Effect.mapError(storeError)),
					),
			} satisfies WebhookFanoutShape
		}).pipe(
			Effect.provide(
				Cloudflare.DurableObjectCallbacks.pipe(
					Layer.provide(Layer.succeed(SecureRandom.SecureRandom, random)),
				),
			),
		),
	),
)

export const WebhookFanoutLive = WebhookFanout.make(webhookFanoutImplementation)

export const WebhookFanoutContinuationDo = Layer.effect(
	WebhookFanoutContinuation,
	Effect.gen(function* () {
		const placed = yield* placement
		const fanouts = placedStub(yield* WebhookFanout, placed)
		const runtime = yield* Cloudflare.Worker
		return {
			continueFanout: (event, work) =>
				Effect.suspend(() =>
					fanouts(webhookFanoutShardId(event.event_id)).enqueue(event, work),
				).pipe(
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.interrupt
							: Effect.fail(storeError(Cause.squash(cause))),
					),
					Effect.provideService(RuntimeContext, runtime),
				),
		}
	}),
)
