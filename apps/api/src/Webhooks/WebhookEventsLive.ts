import * as Cloudflare from "@alchemy.run/cloudflare"
import type * as Query from "@alchemy.run/domain/Query"
import { ListingStore } from "@checkfu/domain/Listing/ListingStore"
import type { ListingEntry, ListingFilter } from "@checkfu/domain/Listing/ListingStore"
import { WebhookEndpoint } from "@checkfu/domain/Webhook/WebhookEndpoint.aggregate"
import { WebhookEvents } from "@checkfu/domain/Webhook/WebhookEvents.external"
import type { WebhookEventPublication } from "@checkfu/domain/Webhook/WebhookEvents.external"
import { matchesWebhookSubscription } from "@checkfu/domain/Webhook/WebhookTypes"
import { WebhookDeliveryId, WebhookEventId, WebhookId } from "@checkfu/sdk/Schemas"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import {
	WebhookDeliveryStore,
	WebhookDeliveryStoreError,
	buildWebhookEventEnvelopeJson,
} from "./WebhookDeliveryStore.ts"

export const WEBHOOK_FANOUT_CONCURRENCY = 10
export const WEBHOOK_FANOUT_PAGE_SIZE = 15

const utf8 = new TextEncoder()

export const deterministicDeliveryId = (
	digest: Digest.Digest["Service"],
	webhookId: WebhookId,
	eventId: string,
): Effect.Effect<WebhookDeliveryId> =>
	Effect.map(digest.digestHex(Digest.sha256, utf8.encode(`wdel:${webhookId}:${eventId}`)), (hash) =>
		WebhookDeliveryId.make(`wdel_${hash.slice(0, 24)}`),
	)

export interface WebhookFanoutWork {
	readonly afterCursor: string | null
	readonly retryWebhookIds: ReadonlyArray<WebhookId>
}

export interface WebhookFanoutContinuationService {
	readonly continueFanout: (
		event: WebhookEventPublication,
		work: WebhookFanoutWork,
	) => Effect.Effect<void, WebhookDeliveryStoreError>
}

export class WebhookFanoutContinuation extends Context.Service<
	WebhookFanoutContinuation,
	WebhookFanoutContinuationService
>()("@checkfu/api/WebhookFanoutContinuation") {}

export type ReadWebhookListingPage = (
	filter: ListingFilter,
	page: Query.PageRequest,
) => Effect.Effect<Query.Page<ListingEntry>>

export interface FanoutWebhookPageDeps {
	readonly webhooks: WebhookEndpoint["Service"]
	readonly deliveries: WebhookDeliveryStore["Service"]
	readonly digest: Digest.Digest["Service"]
}

export interface FanoutWebhookPageResult {
	readonly failedWebhookIds: ReadonlyArray<WebhookId>
	readonly reachedEventTimeBound: boolean
}

export const WEBHOOK_FANOUT_LISTING_FILTER: ListingFilter = {
	kind: "webhook",
	include_archived: false,
	agent_id: null,
	order: "asc",
}

/**
 * Enqueues a single event for one subscriber, enforcing the event-time registration
 * bound (`endpoint.created_at <= event.occurred_at`), active status, and subscription filter.
 */
export const enqueueWebhookSubscriber = (
	event: WebhookEventPublication,
	webhookId: WebhookId,
	payloadJson: string,
	deps: FanoutWebhookPageDeps,
): Effect.Effect<void, WebhookDeliveryStoreError> =>
	Effect.gen(function* () {
		const endpoint = yield* deps.webhooks.get(webhookId)
		if (
			endpoint.status !== "active" ||
			endpoint.created_at > event.occurred_at ||
			!matchesWebhookSubscription(endpoint.event_types, event.event_type)
		) {
			return
		}
		const deliveryId = yield* deterministicDeliveryId(deps.digest, webhookId, event.event_id)
		yield* deps.deliveries.enqueue(webhookId, {
			delivery_id: deliveryId,
			event_id: WebhookEventId.make(event.event_id),
			event_type: event.event_type,
			dedupe_key: event.event_id,
			payload_json: payloadJson,
		})
	})

/**
 * Enqueues a single page of registered webhooks for `event`, bounded to endpoints
 * registered at or before `event.occurred_at`. Individual subscriber failures
 * (such as a saturated pending queue or transient deliverer failure) are captured
 * in `failedWebhookIds` for independent retry so one receiver never blocks other
 * subscribers on this page or later pages.
 */
export const fanoutWebhookPage = (
	event: WebhookEventPublication,
	entries: ReadonlyArray<ListingEntry>,
	deps: FanoutWebhookPageDeps,
): Effect.Effect<FanoutWebhookPageResult> => {
	if (entries.length === 0) {
		return Effect.succeed({ failedWebhookIds: [], reachedEventTimeBound: false })
	}
	const eligible = entries.filter((entry) => entry.created_at <= event.occurred_at)
	const reachedEventTimeBound = eligible.length < entries.length
	if (eligible.length === 0) {
		return Effect.succeed({ failedWebhookIds: [], reachedEventTimeBound })
	}
	const payloadJson = buildWebhookEventEnvelopeJson(event)
	const failedWebhookIds: Array<WebhookId> = []
	return Stream.fromIterable(eligible).pipe(
		Stream.mapEffect(
			(entry) =>
				Effect.gen(function* () {
					const webhookId = WebhookId.make(entry.id)
					const outcome = yield* Effect.exit(
						enqueueWebhookSubscriber(event, webhookId, payloadJson, deps),
					)
					if (Exit.isFailure(outcome)) {
						if (Cause.hasInterruptsOnly(outcome.cause)) {
							return yield* Effect.interrupt
						}
						yield* Effect.logError(
							"Failed to enqueue webhook delivery; scheduling isolated retry",
							{
								webhook_id: webhookId,
								event_id: event.event_id,
								cause: Cause.squash(outcome.cause),
							},
						)
						failedWebhookIds.push(webhookId)
					}
				}),
			{ concurrency: WEBHOOK_FANOUT_CONCURRENCY },
		),
		Stream.runDrain,
		Effect.as({ failedWebhookIds, reachedEventTimeBound }),
	)
}

export const makeInlineWebhookFanoutContinuation = (
	readPage: ReadWebhookListingPage,
	pageSize: number = WEBHOOK_FANOUT_PAGE_SIZE,
) =>
	Layer.effect(
		WebhookFanoutContinuation,
		Effect.gen(function* () {
			const webhooks = yield* WebhookEndpoint
			const deliveries = yield* WebhookDeliveryStore
			const digest = yield* Digest.Digest
			const deps: FanoutWebhookPageDeps = { webhooks, deliveries, digest }
			return {
				continueFanout: (event, work) =>
					Effect.gen(function* () {
						const failed = new Set<WebhookId>(work.retryWebhookIds)
						let after: string | null = work.afterCursor
						while (after !== null) {
							const page: Query.Page<ListingEntry> = yield* readPage(
								WEBHOOK_FANOUT_LISTING_FILTER,
								{
									take: pageSize,
									after,
								},
							)
							const result = yield* fanoutWebhookPage(event, page.entries, deps)
							for (const id of result.failedWebhookIds) {
								failed.add(id)
							}
							after = result.reachedEventTimeBound ? null : page.cursor
						}
						if (failed.size > 0) {
							const payloadJson = buildWebhookEventEnvelopeJson(event)
							let firstError: WebhookDeliveryStoreError | undefined
							for (const webhookId of failed) {
								const retryExit = yield* Effect.exit(
									enqueueWebhookSubscriber(event, webhookId, payloadJson, deps),
								)
								if (Exit.isFailure(retryExit) && firstError === undefined) {
									if (Cause.hasInterruptsOnly(retryExit.cause)) {
										return yield* Effect.interrupt
									}
									firstError = new WebhookDeliveryStoreError({
										cause: Cause.squash(retryExit.cause),
									})
								}
							}
							if (firstError !== undefined) {
								return yield* firstError
							}
						}
					}),
			}
		}),
	)

export const makeWebhookEventsLive = (
	readPage: ReadWebhookListingPage,
	options?: { readonly pageSize?: number },
) => {
	const pageSize = options?.pageSize ?? WEBHOOK_FANOUT_PAGE_SIZE
	return Layer.effect(
		WebhookEvents,
		Effect.gen(function* () {
			const webhooks = yield* WebhookEndpoint
			const deliveries = yield* WebhookDeliveryStore
			const digest = yield* Digest.Digest
			const continuation = yield* WebhookFanoutContinuation
			const deps: FanoutWebhookPageDeps = { webhooks, deliveries, digest }
			return {
				publish: (event) =>
					Effect.gen(function* () {
						const firstPage = yield* readPage(WEBHOOK_FANOUT_LISTING_FILTER, {
							take: pageSize,
							after: undefined,
						})
						if (firstPage.entries.length === 0) {
							return
						}
						const result = yield* fanoutWebhookPage(event, firstPage.entries, deps)
						const nextCursor = result.reachedEventTimeBound ? null : firstPage.cursor
						if (nextCursor !== null || result.failedWebhookIds.length > 0) {
							yield* continuation.continueFanout(event, {
								afterCursor: nextCursor,
								retryWebhookIds: result.failedWebhookIds,
							})
						}
					}).pipe(Effect.orDie),
			}
		}),
	)
}

export const WebhookEventsLive = Layer.unwrap(
	Effect.gen(function* () {
		const listing = yield* ListingStore
		const runtime = yield* Cloudflare.Worker
		return makeWebhookEventsLive((filter, page) =>
			listing.page(filter, page).pipe(Effect.provideService(RuntimeContext, runtime)),
		)
	}),
)
