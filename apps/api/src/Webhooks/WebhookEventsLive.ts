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
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { WebhookDeliveryStore, buildWebhookEventEnvelopeJson } from "./WebhookDeliveryStore.ts"
import type { WebhookDeliveryStoreError } from "./WebhookDeliveryStore.ts"

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

export interface WebhookFanoutContinuationService {
	readonly continueFanout: (
		event: WebhookEventPublication,
		afterCursor: string,
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

export const WEBHOOK_FANOUT_LISTING_FILTER: ListingFilter = {
	kind: "webhook",
	include_archived: false,
	agent_id: null,
	order: "asc",
}

/**
 * Enqueues a single page of registered webhooks for `event`. Fails on the first
 * enqueue error so the caller (either `PublishWebhookEvents` policy retry or a
 * durable `WebhookFanout` continuation pass) retries the page safely using
 * deterministic delivery IDs.
 */
export const fanoutWebhookPage = (
	event: WebhookEventPublication,
	entries: ReadonlyArray<ListingEntry>,
	deps: FanoutWebhookPageDeps,
): Effect.Effect<void, WebhookDeliveryStoreError> => {
	if (entries.length === 0) {
		return Effect.void
	}
	const payloadJson = buildWebhookEventEnvelopeJson(event)
	return Stream.fromIterable(entries).pipe(
		Stream.mapEffect(
			(entry) =>
				Effect.gen(function* () {
					const webhookId = WebhookId.make(entry.id)
					const endpoint = yield* deps.webhooks.get(webhookId)
					if (
						endpoint.status !== "active" ||
						!matchesWebhookSubscription(endpoint.event_types, event.event_type)
					) {
						return
					}
					const deliveryId = yield* deterministicDeliveryId(deps.digest, webhookId, event.event_id)
					yield* deps.deliveries
						.enqueue(webhookId, {
							delivery_id: deliveryId,
							event_id: WebhookEventId.make(event.event_id),
							event_type: event.event_type,
							dedupe_key: event.event_id,
							payload_json: payloadJson,
						})
						.pipe(
							Effect.tapError((error) =>
								Effect.logError("Failed to enqueue webhook delivery", {
									webhook_id: webhookId,
									event_id: event.event_id,
									cause: error.cause,
								}),
							),
						)
				}),
			{ concurrency: WEBHOOK_FANOUT_CONCURRENCY },
		),
		Stream.runDrain,
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
				continueFanout: (event, initialCursor) =>
					Effect.gen(function* () {
						let after: string | null = initialCursor
						while (after !== null) {
							const page: Query.Page<ListingEntry> = yield* readPage(
								WEBHOOK_FANOUT_LISTING_FILTER,
								{
									take: pageSize,
									after,
								},
							)
							yield* fanoutWebhookPage(event, page.entries, deps)
							after = page.cursor
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
						yield* fanoutWebhookPage(event, firstPage.entries, deps)
						if (firstPage.cursor !== null) {
							yield* continuation.continueFanout(event, firstPage.cursor)
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
