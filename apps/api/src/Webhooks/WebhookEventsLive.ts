import * as Cloudflare from "@alchemy.run/cloudflare"
import type * as Query from "@alchemy.run/domain/Query"
import { ListingStore } from "@checkfu/domain/Listing/ListingStore"
import type { ListingEntry, ListingFilter } from "@checkfu/domain/Listing/ListingStore"
import { WebhookEndpoint } from "@checkfu/domain/Webhook/WebhookEndpoint.aggregate"
import { WebhookEvents } from "@checkfu/domain/Webhook/WebhookEvents.external"
import { matchesWebhookSubscription } from "@checkfu/domain/Webhook/WebhookTypes"
import { WebhookDeliveryId, WebhookEventId, WebhookId } from "@checkfu/sdk/Schemas"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { WebhookDeliveryStore, buildWebhookEventEnvelopeJson } from "./WebhookDeliveryStore.ts"

const FANOUT_CONCURRENCY = 10
const LIST_PAGE_SIZE = 100
const utf8 = new TextEncoder()

const deterministicDeliveryId = (
	digest: Digest.Digest["Service"],
	webhookId: WebhookId,
	eventId: string,
): Effect.Effect<WebhookDeliveryId> =>
	Effect.map(digest.digestHex(Digest.sha256, utf8.encode(`wdel:${webhookId}:${eventId}`)), (hash) =>
		WebhookDeliveryId.make(`wdel_${hash.slice(0, 24)}`),
	)

export const listWebhookIdsFromPage = (
	readPage: (
		filter: ListingFilter,
		page: Query.PageRequest,
	) => Effect.Effect<Query.Page<ListingEntry>>,
): Effect.Effect<ReadonlyArray<WebhookId>> =>
	Effect.gen(function* () {
		const ids: Array<WebhookId> = []
		let after: string | undefined
		for (;;) {
			const page = yield* readPage(
				{ kind: "webhook", include_archived: false, agent_id: null, order: "asc" },
				{ take: LIST_PAGE_SIZE, after },
			)
			for (const entry of page.entries) {
				ids.push(WebhookId.make(entry.id))
			}
			if (page.cursor === null) {
				break
			}
			after = page.cursor
		}
		return ids
	})

export const makeWebhookEventsLive = (
	listRegisteredWebhookIds: Effect.Effect<ReadonlyArray<WebhookId>>,
) =>
	Layer.effect(
		WebhookEvents,
		Effect.gen(function* () {
			const webhooks = yield* WebhookEndpoint
			const deliveries = yield* WebhookDeliveryStore
			const digest = yield* Digest.Digest
			return {
				publish: (input) =>
					Effect.gen(function* () {
						const webhookIds = yield* listRegisteredWebhookIds
						if (webhookIds.length === 0) {
							return
						}
						const payloadJson = buildWebhookEventEnvelopeJson({
							event_id: input.event_id,
							event_type: input.event_type,
							resource_type: input.resource_type,
							resource_id: input.resource_id,
							occurred_at: input.occurred_at,
							data_json: input.data_json,
						})
						yield* Stream.fromIterable(webhookIds).pipe(
							Stream.mapEffect(
								(webhookId) =>
									Effect.gen(function* () {
										const endpoint = yield* webhooks.get(webhookId)
										if (
											endpoint.status !== "active" ||
											!matchesWebhookSubscription(endpoint.event_types, input.event_type)
										) {
											return
										}
										const deliveryId = yield* deterministicDeliveryId(
											digest,
											webhookId,
											input.event_id,
										)
										yield* deliveries
											.enqueue(webhookId, {
												delivery_id: deliveryId,
												event_id: WebhookEventId.make(input.event_id),
												event_type: input.event_type,
												dedupe_key: input.event_id,
												payload_json: payloadJson,
											})
											.pipe(
												Effect.catchTag("WebhookDeliveryStoreError", (error) =>
													Effect.logError("Failed to enqueue webhook delivery", {
														webhook_id: webhookId,
														event_id: input.event_id,
														cause: error.cause,
													}),
												),
											)
									}),
								{ concurrency: FANOUT_CONCURRENCY },
							),
							Stream.runDrain,
						)
					}),
			}
		}),
	)

export const WebhookEventsLive = Layer.unwrap(
	Effect.gen(function* () {
		const listing = yield* ListingStore
		const runtime = yield* Cloudflare.Worker
		return makeWebhookEventsLive(
			listWebhookIdsFromPage((filter, page) =>
				listing.page(filter, page).pipe(Effect.provideService(RuntimeContext, runtime)),
			),
		)
	}),
)
