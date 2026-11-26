import * as Cloudflare from "@alchemy.run/cloudflare"
import { ListingStore } from "@checkfu/domain/Listing/ListingStore"
import { WebhookEndpoint } from "@checkfu/domain/Webhook/WebhookEndpoint.aggregate"
import type { WebhookEventPublication } from "@checkfu/domain/Webhook/WebhookEvents.external"
import * as Alchemy from "alchemy"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Cause from "effect/Cause"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { placedStub, placement } from "../Placement.ts"
import { WebhookDeliveryStore, WebhookDeliveryStoreError } from "./WebhookDeliveryStore.ts"
import {
	WEBHOOK_FANOUT_LISTING_FILTER,
	WEBHOOK_FANOUT_PAGE_SIZE,
	WebhookFanoutContinuation,
	fanoutWebhookPage,
} from "./WebhookEventsLive.ts"

const storeError = (cause: unknown) => new WebhookDeliveryStoreError({ cause })

const overWire = <A, R>(effect: Effect.Effect<A, WebhookDeliveryStoreError, R>) =>
	Effect.mapError(effect, (error) => storeError(String(error.cause)))

interface FanoutPagePayload {
	readonly event: WebhookEventPublication
	readonly cursor: string
	readonly step: number
}

export interface WebhookFanoutShape {
	readonly enqueue: (
		event: WebhookEventPublication,
		afterCursor: string,
	) => Effect.Effect<void, WebhookDeliveryStoreError, RuntimeContext>
}

export class WebhookFanout extends Cloudflare.DurableObject<WebhookFanout, WebhookFanoutShape>()(
	"WebhookFanout",
) {}

const FANOUT_CALLBACK = "fanoutPage"
const FANOUT_JOB_ID = "fanout"
const STARTED_KEY = "started"

interface FanoutCallbackSlot {
	current: Alchemy.Callback<FanoutPagePayload> | undefined
}

/**
 * Durable continuation object for large webhook fan-outs (> 1 page).
 * Keyed by `event.event_id`, each alarm invocation drains a single page of
 * registered webhooks (bounded subrequest count) and persists the next cursor
 * via `Cloudflare.DurableObjectCallbacks` with monotonic `progress` so a failed
 * page retries cleanly without re-scanning earlier pages or exhausting Worker
 * subrequest limits.
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
				const callbackRef: FanoutCallbackSlot = { current: undefined }
				const onPage = yield* Alchemy.makeCallback(
					FANOUT_CALLBACK,
					Effect.fn(function* (payload: FanoutPagePayload) {
						const page = yield* listing.page(WEBHOOK_FANOUT_LISTING_FILTER, {
							take: WEBHOOK_FANOUT_PAGE_SIZE,
							after: payload.cursor,
						})
						yield* fanoutWebhookPage(payload.event, page.entries, {
							webhooks,
							deliveries,
							digest,
						}).pipe(Effect.orDie)
						if (page.cursor !== null && callbackRef.current !== undefined) {
							yield* callbackRef.current
								.schedule(FANOUT_JOB_ID, {
									after: "0 seconds",
									payload: {
										event: payload.event,
										cursor: page.cursor,
										step: payload.step + 1,
									},
									progress: payload.step + 1,
								})
								.pipe(Effect.orDie)
						}
					}),
				)
				callbackRef.current = onPage

				return {
					enqueue: (event, afterCursor) =>
						overWire(
							state.storage
								.transaction(
									Effect.gen(function* () {
										const started = yield* state.storage.get<boolean>(STARTED_KEY)
										if (started === true) {
											return
										}
										yield* state.storage.put(STARTED_KEY, true)
										yield* onPage.schedule(FANOUT_JOB_ID, {
											after: "0 seconds",
											payload: { event, cursor: afterCursor, step: 1 },
											progress: 1,
										})
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
			continueFanout: (event, afterCursor) =>
				Effect.suspend(() => fanouts(event.event_id).enqueue(event, afterCursor)).pipe(
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
