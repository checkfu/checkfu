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

export const WEBHOOK_FANOUT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000
export const WEBHOOK_FANOUT_MAX_RETRY_AGE_MS = 14 * 24 * 60 * 60 * 1000
export const WEBHOOK_FANOUT_SHARD_COUNT = 16

/**
 * Deterministically routes an event publication onto a bounded pool of
 * `WebhookFanout` Durable Object shards (`shard_0`..`shard_15`). Bounding the
 * shard count prevents unbounded per-event SQLite database accumulation while
 * preserving per-event deduplication and parallel fan-out throughput.
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

interface FanoutPagePayload {
	readonly event: WebhookEventPublication
	readonly cursor: string
	readonly step: number
}

interface RetrySubscriberPayload {
	readonly event: WebhookEventPublication
	readonly webhookId: WebhookId
}

interface CleanupPayload {
	readonly eventId: string
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

const FANOUT_PAGE_CALLBACK = "fanoutPage"
const RETRY_SUBSCRIBER_CALLBACK = "retrySubscriber"
const CLEANUP_CALLBACK = "cleanup"

const scanJobId = (eventId: string) => `scan:${eventId}`
const retryJobId = (eventId: string, webhookId: WebhookId) => `retry:${eventId}:${webhookId}`
const cleanupJobId = (eventId: string) => `cleanup:${eventId}`

const scanStartedKey = (eventId: string) => `ev:${eventId}:started`
const scanDoneKey = (eventId: string) => `ev:${eventId}:done`
const pendingCountKey = (eventId: string) => `ev:${eventId}:pending_count`
const retryMarkerKey = (eventId: string, webhookId: WebhookId) => `ev:${eventId}:retry:${webhookId}`

interface FanoutCallbackSlot<P> {
	current: Alchemy.Callback<P> | undefined
}

/**
 * Sharded durable continuation object for large or partially saturated webhook
 * fan-outs. Each event is deterministically mapped to one of 16 reusable shards:
 * - `"fanoutPage"` drains one creation-ordered page at a time, bounded to
 *   endpoints registered at or before `event.occurred_at`.
 * - `"retrySubscriber"` stores one small marker key per failed subscriber plus
 *   a transactional pending count, retrying each subscriber independently with
 *   exponential backoff so neither slow receivers nor large outages block later pages.
 * - `"cleanup"` deletes the per-event scalar keys after `WEBHOOK_FANOUT_DEDUPE_TTL_MS`
 *   once the scan and all subscriber retries have settled, and Alchemy deletes each
 *   completed callback row upon acknowledgment.
 */
export const WebhookFanoutLive = WebhookFanout.make(
	Effect.map(
		Effect.gen(function* () {
			const state = yield* Cloudflare.DurableObjectState
			const listing = yield* ListingStore
			const webhooks = yield* WebhookEndpoint
			const deliveries = yield* WebhookDeliveryStore
			const digest = yield* Digest.Digest
			const random = yield* SecureRandom.SecureRandom
			return { state, listing, webhooks, deliveries, digest, random }
		}),
		({ state, listing, webhooks, deliveries, digest, random }) =>
			Effect.gen(function* () {
				const pageRef: FanoutCallbackSlot<FanoutPagePayload> = { current: undefined }
				const retryRef: FanoutCallbackSlot<RetrySubscriberPayload> = { current: undefined }
				const cleanupRef: FanoutCallbackSlot<CleanupPayload> = { current: undefined }

				const scheduleCleanupIfSettled = (
					eventId: string,
					scanDone: boolean,
					pendingCount: number,
				) =>
					Effect.gen(function* () {
						const cleanup = cleanupRef.current
						if (cleanup === undefined || !scanDone || pendingCount > 0) {
							return
						}
						const now = yield* Clock.currentTimeMillis
						yield* cleanup.schedule(cleanupJobId(eventId), {
							at: now + WEBHOOK_FANOUT_DEDUPE_TTL_MS,
							payload: { eventId },
						})
					})

				const onPage = yield* Alchemy.makeCallback(
					FANOUT_PAGE_CALLBACK,
					Effect.fn(function* (payload: FanoutPagePayload) {
						const eventId = payload.event.event_id
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
									const pKey = pendingCountKey(eventId)
									let pendingCount = (yield* state.storage.get<number>(pKey)) ?? 0
									let addedRetries = 0
									const retryCb = retryRef.current
									for (const webhookId of result.failedWebhookIds) {
										const rKey = retryMarkerKey(eventId, webhookId)
										const alreadyPending = (yield* state.storage.get<boolean>(rKey)) === true
										if (!alreadyPending) {
											yield* state.storage.put(rKey, true)
											addedRetries += 1
											if (retryCb !== undefined) {
												yield* retryCb.schedule(retryJobId(eventId, webhookId), {
													after: "2 seconds",
													payload: { event: payload.event, webhookId },
												})
											}
										}
									}
									if (addedRetries > 0) {
										pendingCount += addedRetries
										yield* state.storage.put(pKey, pendingCount)
									}

									if (nextCursor !== null && pageRef.current !== undefined) {
										yield* pageRef.current.schedule(scanJobId(eventId), {
											after: "0 seconds",
											payload: {
												event: payload.event,
												cursor: nextCursor,
												step: payload.step + 1,
											},
											progress: payload.step + 1,
										})
										return
									}
									yield* state.storage.put(scanDoneKey(eventId), true)
									yield* scheduleCleanupIfSettled(eventId, true, pendingCount)
								}),
							)
							.pipe(Effect.orDie)
					}),
				)
				pageRef.current = onPage

				const onRetrySubscriber = yield* Alchemy.makeCallback(
					RETRY_SUBSCRIBER_CALLBACK,
					Effect.fn(function* (payload: RetrySubscriberPayload) {
						const eventId = payload.event.event_id
						const now = yield* Clock.currentTimeMillis
						if (now - payload.event.occurred_at < WEBHOOK_FANOUT_MAX_RETRY_AGE_MS) {
							const payloadJson = buildWebhookEventEnvelopeJson(payload.event)
							yield* enqueueWebhookSubscriber(payload.event, payload.webhookId, payloadJson, {
								webhooks,
								deliveries,
								digest,
							}).pipe(Effect.orDie)
						} else {
							yield* Effect.logWarning(
								"Dropping webhook fan-out subscriber retry past retention window",
								{
									webhook_id: payload.webhookId,
									event_id: eventId,
								},
							)
						}

						yield* state.storage
							.transaction(
								Effect.gen(function* () {
									const rKey = retryMarkerKey(eventId, payload.webhookId)
									const pKey = pendingCountKey(eventId)
									const existed = (yield* state.storage.get<boolean>(rKey)) === true
									let pendingCount = (yield* state.storage.get<number>(pKey)) ?? 0
									if (existed) {
										yield* state.storage.delete(rKey)
										pendingCount = Math.max(0, pendingCount - 1)
										if (pendingCount === 0) {
											yield* state.storage.delete(pKey)
										} else {
											yield* state.storage.put(pKey, pendingCount)
										}
									}
									const scanDone =
										(yield* state.storage.get<boolean>(scanDoneKey(eventId))) === true
									yield* scheduleCleanupIfSettled(eventId, scanDone, pendingCount)
								}),
							)
							.pipe(Effect.orDie)
					}),
				)
				retryRef.current = onRetrySubscriber

				const onCleanup = yield* Alchemy.makeCallback(
					CLEANUP_CALLBACK,
					Effect.fn(function* (payload: CleanupPayload) {
						const { eventId } = payload
						yield* state.storage
							.transaction(
								Effect.gen(function* () {
									const sKey = scanStartedKey(eventId)
									const dKey = scanDoneKey(eventId)
									const pKey = pendingCountKey(eventId)
									const scanDone = (yield* state.storage.get<boolean>(dKey)) === true
									const pendingCount = (yield* state.storage.get<number>(pKey)) ?? 0
									if (!scanDone || pendingCount > 0) {
										return
									}
									yield* state.storage.delete([sKey, dKey, pKey])
								}),
							)
							.pipe(Effect.orDie)
					}),
				)
				cleanupRef.current = onCleanup

				return {
					enqueue: (event, work) =>
						overWire(
							state.storage
								.transaction(
									Effect.gen(function* () {
										const eventId = event.event_id
										const sKey = scanStartedKey(eventId)
										const dKey = scanDoneKey(eventId)
										const pKey = pendingCountKey(eventId)
										const scanStarted = (yield* state.storage.get<boolean>(sKey)) === true
										let scanDone = (yield* state.storage.get<boolean>(dKey)) === true
										let pendingCount = (yield* state.storage.get<number>(pKey)) ?? 0
										let addedRetries = 0
										let scheduledNewWork = false

										for (const webhookId of work.retryWebhookIds) {
											const rKey = retryMarkerKey(eventId, webhookId)
											const alreadyPending = (yield* state.storage.get<boolean>(rKey)) === true
											if (!alreadyPending) {
												yield* state.storage.put(rKey, true)
												addedRetries += 1
												scheduledNewWork = true
												yield* onRetrySubscriber.schedule(retryJobId(eventId, webhookId), {
													after: "2 seconds",
													payload: { event, webhookId },
												})
											}
										}
										if (addedRetries > 0) {
											pendingCount += addedRetries
											yield* state.storage.put(pKey, pendingCount)
										}

										if (!scanStarted) {
											yield* state.storage.put(sKey, true)
											if (work.afterCursor !== null) {
												scanDone = false
												scheduledNewWork = true
												yield* state.storage.put(dKey, false)
												yield* onPage.schedule(scanJobId(eventId), {
													after: "0 seconds",
													payload: { event, cursor: work.afterCursor, step: 1 },
													progress: 1,
												})
											} else {
												scanDone = true
												yield* state.storage.put(dKey, true)
											}
										}

										if (scheduledNewWork) {
											yield* onCleanup.cancel(cleanupJobId(eventId))
										} else {
											yield* scheduleCleanupIfSettled(eventId, scanDone, pendingCount)
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
