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

const SCAN_JOB_ID = "scan"
const CLEANUP_JOB_ID = "cleanup"

const SCAN_STARTED_KEY = "scan_started"
const SCAN_DONE_KEY = "scan_done"
const PENDING_RETRIES_KEY = "pending_retries"

interface FanoutCallbackSlot<P> {
	current: Alchemy.Callback<P> | undefined
}

/**
 * Durable continuation object for large or partially saturated webhook fan-outs.
 * Keyed by `event.event_id`:
 * - `"fanoutPage"` drains one creation-ordered page at a time, bounded to
 *   endpoints registered at or before `event.occurred_at`.
 * - `"retrySubscriber"` retries each individual failed/saturated subscriber
 *   independently with exponential backoff so one receiver never blocks others.
 * - `"cleanup"` reclaims per-event deduplication state after `WEBHOOK_FANOUT_DEDUPE_TTL_MS`
 *   once both the page scan and all subscriber retries have settled.
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
					pendingRetries: ReadonlyArray<WebhookId>,
				) =>
					Effect.gen(function* () {
						const cleanup = cleanupRef.current
						if (cleanup === undefined || !scanDone || pendingRetries.length > 0) {
							return
						}
						const now = yield* Clock.currentTimeMillis
						yield* cleanup.schedule(CLEANUP_JOB_ID, {
							at: now + WEBHOOK_FANOUT_DEDUPE_TTL_MS,
							payload: { eventId },
						})
					})

				const onPage = yield* Alchemy.makeCallback(
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
									const pending = new Set<WebhookId>(
										(yield* state.storage.get<ReadonlyArray<WebhookId>>(PENDING_RETRIES_KEY)) ?? [],
									)
									const retryCb = retryRef.current
									for (const webhookId of result.failedWebhookIds) {
										if (!pending.has(webhookId)) {
											pending.add(webhookId)
											if (retryCb !== undefined) {
												yield* retryCb.schedule(webhookId, {
													after: "2 seconds",
													payload: { event: payload.event, webhookId },
												})
											}
										}
									}
									const pendingList = [...pending]
									yield* state.storage.put(PENDING_RETRIES_KEY, pendingList)

									if (nextCursor !== null && pageRef.current !== undefined) {
										yield* pageRef.current.schedule(SCAN_JOB_ID, {
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
									yield* state.storage.put(SCAN_DONE_KEY, true)
									yield* scheduleCleanupIfSettled(payload.event.event_id, true, pendingList)
								}),
							)
							.pipe(Effect.orDie)
					}),
				)
				pageRef.current = onPage

				const onRetrySubscriber = yield* Alchemy.makeCallback(
					RETRY_SUBSCRIBER_CALLBACK,
					Effect.fn(function* (payload: RetrySubscriberPayload) {
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
									event_id: payload.event.event_id,
								},
							)
						}

						yield* state.storage
							.transaction(
								Effect.gen(function* () {
									const pending = (
										(yield* state.storage.get<ReadonlyArray<WebhookId>>(PENDING_RETRIES_KEY)) ?? []
									).filter((id) => id !== payload.webhookId)
									yield* state.storage.put(PENDING_RETRIES_KEY, pending)
									const scanDone = (yield* state.storage.get<boolean>(SCAN_DONE_KEY)) === true
									yield* scheduleCleanupIfSettled(payload.event.event_id, scanDone, pending)
								}),
							)
							.pipe(Effect.orDie)
					}),
				)
				retryRef.current = onRetrySubscriber

				const onCleanup = yield* Alchemy.makeCallback(
					CLEANUP_CALLBACK,
					Effect.fn(function* (_payload: CleanupPayload) {
						yield* state.storage
							.transaction(
								Effect.gen(function* () {
									const scanDone = (yield* state.storage.get<boolean>(SCAN_DONE_KEY)) === true
									const pending =
										(yield* state.storage.get<ReadonlyArray<WebhookId>>(PENDING_RETRIES_KEY)) ?? []
									if (!scanDone || pending.length > 0) {
										return
									}
									yield* state.storage.delete([
										SCAN_STARTED_KEY,
										SCAN_DONE_KEY,
										PENDING_RETRIES_KEY,
									])
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
										const scanStarted =
											(yield* state.storage.get<boolean>(SCAN_STARTED_KEY)) === true
										let scanDone = (yield* state.storage.get<boolean>(SCAN_DONE_KEY)) === true
										const pending = new Set<WebhookId>(
											(yield* state.storage.get<ReadonlyArray<WebhookId>>(PENDING_RETRIES_KEY)) ??
												[],
										)
										let scheduledNewWork = false

										for (const webhookId of work.retryWebhookIds) {
											if (!pending.has(webhookId)) {
												pending.add(webhookId)
												scheduledNewWork = true
												yield* onRetrySubscriber.schedule(webhookId, {
													after: "2 seconds",
													payload: { event, webhookId },
												})
											}
										}
										const pendingList = [...pending]
										if (pendingList.length > 0) {
											yield* state.storage.put(PENDING_RETRIES_KEY, pendingList)
										}

										if (!scanStarted) {
											yield* state.storage.put(SCAN_STARTED_KEY, true)
											if (work.afterCursor !== null) {
												scanDone = false
												scheduledNewWork = true
												yield* state.storage.put(SCAN_DONE_KEY, false)
												yield* onPage.schedule(SCAN_JOB_ID, {
													after: "0 seconds",
													payload: { event, cursor: work.afterCursor, step: 1 },
													progress: 1,
												})
											} else {
												scanDone = true
												yield* state.storage.put(SCAN_DONE_KEY, true)
											}
										}

										if (scheduledNewWork) {
											yield* onCleanup.cancel(CLEANUP_JOB_ID)
										} else {
											yield* scheduleCleanupIfSettled(event.event_id, scanDone, pendingList)
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
				Effect.suspend(() => fanouts(event.event_id).enqueue(event, work)).pipe(
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
