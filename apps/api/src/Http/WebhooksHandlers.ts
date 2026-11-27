import { ClaimWebhookIdempotencyKey } from "@checkfu/domain/Webhook/ClaimWebhookIdempotencyKey.command"
import { CreateWebhookEndpoint } from "@checkfu/domain/Webhook/CreateWebhookEndpoint.command"
import { DeleteWebhookEndpoint } from "@checkfu/domain/Webhook/DeleteWebhookEndpoint.command"
import { PauseWebhookEndpoint } from "@checkfu/domain/Webhook/PauseWebhookEndpoint.command"
import { ResumeWebhookEndpoint } from "@checkfu/domain/Webhook/ResumeWebhookEndpoint.command"
import { RotateWebhookSecret } from "@checkfu/domain/Webhook/RotateWebhookSecret.command"
import { UpdateWebhookEndpoint } from "@checkfu/domain/Webhook/UpdateWebhookEndpoint.command"
import { WebhookEndpoint } from "@checkfu/domain/Webhook/WebhookEndpoint.aggregate"
import type { WebhookEndpointState } from "@checkfu/domain/Webhook/WebhookEndpoint.aggregate"
import {
	decodeWebhookEventTypes,
	encodeWebhookEventTypes,
} from "@checkfu/domain/Webhook/WebhookTypes"
import {
	WebhookDeliveryId,
	WebhookEndpointStatus,
	WebhookEventId,
	WebhookId,
} from "@checkfu/sdk/Schemas"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Digest from "effect/crypto/Digest"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Schema from "effect/Schema"
import {
	WebhookDeliveryStore,
	buildWebhookEventEnvelopeJson,
} from "../Webhooks/WebhookDeliveryStore.ts"
import type {
	WebhookDeliveryRecord,
	WebhookDeliveryStoreError,
} from "../Webhooks/WebhookDeliveryStore.ts"
import {
	WebhookSigningMasterKey,
	deriveWebhookSigningSecret,
	newWebhookSecretSalt,
} from "../Webhooks/WebhookSigning.ts"
import { CheckfuApi } from "./Api.ts"
import {
	reusedKey,
	handled,
	idempotentCommandId,
	idempotentId,
	randomId,
	reject,
	sha256Json,
} from "./HttpHelpers.ts"
import { WebhookListingQuery, hydrateListingPage } from "./Listing.ts"

export const keyedWebhookId = (digest: Digest.Digest["Service"], idempotencyKey: string) =>
	Effect.map(idempotentId(digest, "whe", ["create", "webhook", "id", idempotencyKey]), (id) =>
		WebhookId.make(id.slice(0, "whe_".length + 24)),
	)

const dedupeEventTypes = (eventTypes: ReadonlyArray<string>): ReadonlyArray<string> => [
	...new Set(eventTypes),
]

const publicWebhookUrl = Effect.fnUntraced(function* (url: string) {
	const { parsePublicHttpsWebhookUrl } = yield* Effect.promise(
		() => import("@checkfu/domain/Webhook/WebhookUrl"),
	)
	return (
		parsePublicHttpsWebhookUrl(url) ??
		(yield* reject(
			400,
			"Webhook URL must be a public HTTPS URL without embedded credentials or fragments.",
		))
	)
})

const storedDelivery = <A, E extends { readonly _tag: string }, R>(
	effect: Effect.Effect<A, E | WebhookDeliveryStoreError, R>,
) =>
	effect.pipe(
		Effect.catchTag("WebhookDeliveryStoreError", (error) =>
			Effect.andThen(
				Effect.logError("Webhook delivery store failed", error),
				reject(503, "Webhook delivery storage is unavailable. Retry the request."),
			),
		),
	)

const isWebhookEndpointStatus = Schema.is(WebhookEndpointStatus)

const resolveEndpointStatus = (status: string): WebhookEndpointStatus => {
	if (isWebhookEndpointStatus(status)) {
		return status
	}
	throw new Error(`Unexpected webhook endpoint status: ${status}`)
}

const webhookResource = (id: WebhookId, state: WebhookEndpointState) => ({
	id,
	type: "webhook" as const,
	status: resolveEndpointStatus(state.status),
	url: state.url,
	description: state.description,
	event_types: [...decodeWebhookEventTypes(state.event_types)],
	definition_revision: state.definition_revision,
	secret_revision: state.secret_revision,
	previous_secret_expires_at:
		state.previous_secret_expires_at > 0
			? DateTime.makeUnsafe(state.previous_secret_expires_at)
			: null,
	consecutive_failures: state.consecutive_failures,
	last_failure_at: state.last_failure_at > 0 ? DateTime.makeUnsafe(state.last_failure_at) : null,
	created_at: DateTime.makeUnsafe(state.created_at),
	updated_at: DateTime.makeUnsafe(state.updated_at),
})

const deliveryResource = (record: WebhookDeliveryRecord) => ({
	id: record.id,
	type: "webhook_delivery" as const,
	webhook_id: record.webhook_id,
	event_id: record.event_id,
	event_type: record.event_type,
	status: record.status,
	attempt_count: record.attempt_count,
	max_attempts: record.max_attempts,
	next_attempt_at:
		record.next_attempt_at === null ? null : DateTime.makeUnsafe(record.next_attempt_at),
	last_attempt_at:
		record.last_attempt_at === null ? null : DateTime.makeUnsafe(record.last_attempt_at),
	last_http_status: record.last_http_status,
	last_outcome: record.last_outcome,
	last_error: record.last_error,
	created_at: DateTime.makeUnsafe(record.created_at),
	updated_at: DateTime.makeUnsafe(record.updated_at),
	completed_at: record.completed_at === null ? null : DateTime.makeUnsafe(record.completed_at),
})

export const WebhooksLive = HttpApiBuilder.group(CheckfuApi, "webhooks", (handlers) =>
	Effect.gen(function* () {
		const webhooks = yield* WebhookEndpoint
		const webhookListing = yield* WebhookListingQuery
		const deliveries = yield* WebhookDeliveryStore
		const mac = yield* Mac.Mac
		const masterKeyService = yield* WebhookSigningMasterKey
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom

		const requireLive = (id: WebhookId) =>
			webhooks.get(id).pipe(
				Effect.filterOrElse(
					(state) => state.status !== "" && state.status !== "deleted",
					() => reject(404, `Webhook ${id} not found.`),
				),
			)

		const deriveCurrentSecret = (id: WebhookId, state: WebhookEndpointState) =>
			Effect.flatMap(masterKeyService.key, (masterKey) =>
				deriveWebhookSigningSecret(mac, masterKey, {
					webhookId: id,
					secretRevision: state.secret_revision,
					secretSalt: state.secret_salt,
				}),
			)

		const retrieve = (id: string) =>
			Effect.map(requireLive(WebhookId.make(id)), (state) =>
				webhookResource(WebhookId.make(id), state),
			)

		return handlers
			.handle("create", ({ headers, payload }) =>
				handled(
					Effect.gen(function* () {
						const canonicalUrl = yield* publicWebhookUrl(payload.url)
						const description = payload.description ?? ""
						const eventTypes = dedupeEventTypes(payload.event_types)
						const encodedEventTypes = encodeWebhookEventTypes(eventTypes)
						const idempotencyKey = headers["idempotency-key"]
						const webhookId =
							idempotencyKey === undefined
								? WebhookId.make(yield* randomId(random, "whe"))
								: yield* keyedWebhookId(digest, idempotencyKey)
						const secretSalt = yield* newWebhookSecretSalt(random)
						const commandId =
							idempotencyKey === undefined
								? `create-webhook:${webhookId}`
								: yield* idempotentCommandId(digest, "create-webhook", [
										"create",
										"webhook",
										webhookId,
										idempotencyKey,
										yield* sha256Json(digest, {
											operation: "create",
											url: canonicalUrl,
											description,
											event_types: eventTypes,
										}),
									])

						const receipt = yield* webhooks
							.send(
								new CreateWebhookEndpoint({
									webhook_id: webhookId,
									url: canonicalUrl,
									description,
									event_types: encodedEventTypes,
									secret_salt: secretSalt,
								}),
								{ commandId },
							)
							.pipe(Effect.catchTag("WebhookAlreadyExists", () => reusedKey))

						const state = yield* requireLive(webhookId)
						if (idempotencyKey !== undefined && state.secret_revision !== 1) {
							return yield* reject(
								409,
								"This webhook's signing secret has already been rotated since the original create request.",
							)
						}
						const signingSecret = yield* deriveCurrentSecret(webhookId, state)

						// Wait until WebhookListing commits this registration to ListingStore so
						// 201 guarantees immediate fan-out visibility. On timeout OR any post-commit
						// listing read failure/defect, return 202 PendingWebhook with the committed
						// id and signing_secret so unkeyed callers never lose the webhook or create
						// duplicates on retry.
						const listingReady = yield* webhookListing.waitFor(receipt).pipe(
							Effect.as(true),
							Effect.catchTag("WebhookListingTimeout", () => Effect.succeed(false)),
							Effect.catchCause((cause) =>
								Cause.hasInterruptsOnly(cause)
									? Effect.interrupt
									: Effect.andThen(
											Effect.logError(
												"Webhook listing wait failed after webhook creation committed",
												{
													webhook_id: webhookId,
													cause: Cause.pretty(cause),
												},
											),
											Effect.succeed(false),
										),
							),
						)
						if (!listingReady) {
							return {
								id: webhookId,
								type: "webhook" as const,
								pending: true as const,
								signing_secret: signingSecret,
							}
						}
						return { ...webhookResource(webhookId, state), signing_secret: signingSecret }
					}),
				),
			)
			.handle("list", ({ query }) =>
				handled(
					Effect.gen(function* () {
						const page = yield* (
							query.id !== undefined
								? webhookListing.lookup(query.id)
								: webhookListing.page(query.order ?? "asc", {
										take: query.limit ?? 50,
										...(query.page === undefined ? {} : { after: query.page }),
									})
						).pipe(
							Effect.catchTag("WebhookListingTimeout", () =>
								reject(503, "Webhook listing is temporarily unavailable. Retry the request."),
							),
						)
						return yield* hydrateListingPage(page, {}, retrieve)
					}),
				),
			)
			.handle("get", ({ params }) => handled(retrieve(params.webhook_id)))
			.handle("update", ({ params, payload }) =>
				handled(
					Effect.gen(function* () {
						let nextUrl: string | null = null
						if (payload.url !== undefined) {
							nextUrl = yield* publicWebhookUrl(payload.url)
						}
						const nextDescription = payload.description ?? null
						const nextEventTypes =
							payload.event_types === undefined
								? null
								: encodeWebhookEventTypes(dedupeEventTypes(payload.event_types))
						yield* webhooks
							.send(
								new UpdateWebhookEndpoint({
									webhook_id: params.webhook_id,
									url: nextUrl,
									description: nextDescription,
									event_types: nextEventTypes,
									reactivate: payload.reactivate === true,
								}),
							)
							.pipe(
								Effect.catchTag("WebhookDeletedError", () =>
									reject(404, `Webhook ${params.webhook_id} not found.`),
								),
							)
						const updated = yield* requireLive(params.webhook_id)
						return webhookResource(params.webhook_id, updated)
					}),
				),
			)
			.handle("pause", ({ params }) =>
				handled(
					Effect.gen(function* () {
						yield* requireLive(params.webhook_id)
						yield* webhooks.send(new PauseWebhookEndpoint({ webhook_id: params.webhook_id }))
						const state = yield* requireLive(params.webhook_id)
						return webhookResource(params.webhook_id, state)
					}),
				),
			)
			.handle("resume", ({ params }) =>
				handled(
					Effect.gen(function* () {
						yield* requireLive(params.webhook_id)
						yield* webhooks.send(new ResumeWebhookEndpoint({ webhook_id: params.webhook_id }))
						const state = yield* requireLive(params.webhook_id)
						return webhookResource(params.webhook_id, state)
					}),
				),
			)
			.handle("rotateSecret", ({ params, headers }) =>
				handled(
					Effect.gen(function* () {
						yield* requireLive(params.webhook_id)
						const nowMillis = yield* Clock.currentTimeMillis
						const nextSalt = yield* newWebhookSecretSalt(random)
						const idempotencyKey = headers["idempotency-key"]
						if (idempotencyKey !== undefined) {
							const fingerprint = yield* sha256Json(digest, {
								operation: "rotate-secret",
								webhook_id: params.webhook_id,
							})
							const claim = yield* webhooks.send(
								new ClaimWebhookIdempotencyKey({ webhook_id: params.webhook_id, fingerprint }),
								{
									commandId: yield* idempotentCommandId(digest, "rotate-webhook-secret-claim", [
										params.webhook_id,
										idempotencyKey,
									]),
								},
							)
							if (
								!claim.events.some(
									(event) =>
										event._tag === "webhook.idempotency_key_claimed" &&
										event.fingerprint === fingerprint,
								)
							) {
								return yield* reusedKey
							}
							const commandId = yield* idempotentCommandId(digest, "rotate-webhook-secret", [
								params.webhook_id,
								idempotencyKey,
							])
							const receipt = yield* webhooks
								.send(
									new RotateWebhookSecret({
										webhook_id: params.webhook_id,
										next_secret_salt: nextSalt,
										rotated_at: nowMillis,
									}),
									{ commandId },
								)
								.pipe(
									Effect.catchTag("WebhookSecretRotationInProgress", (refused) =>
										reject(
											409,
											`A previous signing secret is still active until ${DateTime.formatIso(DateTime.makeUnsafe(refused.previous_secret_expires_at))}; wait until its grace period expires before rotating again.`,
										),
									),
								)
							const rotatedEvent = receipt.events.find(
								(event) => event._tag === "webhook.secret_rotated",
							)
							const state = yield* requireLive(params.webhook_id)
							if (
								rotatedEvent !== undefined &&
								state.secret_revision !== rotatedEvent.secret_revision
							) {
								return yield* reject(
									409,
									"This webhook's signing secret has already been rotated again since this request.",
								)
							}
							const signingSecret = yield* deriveCurrentSecret(params.webhook_id, state)
							return { ...webhookResource(params.webhook_id, state), signing_secret: signingSecret }
						}

						const receipt = yield* webhooks
							.send(
								new RotateWebhookSecret({
									webhook_id: params.webhook_id,
									next_secret_salt: nextSalt,
									rotated_at: nowMillis,
								}),
							)
							.pipe(
								Effect.catchTag("WebhookSecretRotationInProgress", (refused) =>
									reject(
										409,
										`A previous signing secret is still active until ${DateTime.formatIso(DateTime.makeUnsafe(refused.previous_secret_expires_at))}; wait until its grace period expires before rotating again.`,
									),
								),
							)
						const rotatedEvent = receipt.events.find(
							(event) => event._tag === "webhook.secret_rotated",
						)
						const state = yield* requireLive(params.webhook_id)
						if (rotatedEvent !== undefined) {
							const masterKey = yield* masterKeyService.key
							const signingSecret = yield* deriveWebhookSigningSecret(mac, masterKey, {
								webhookId: params.webhook_id,
								secretRevision: rotatedEvent.secret_revision,
								secretSalt: rotatedEvent.secret_salt,
							})
							return {
								...webhookResource(params.webhook_id, state),
								secret_revision: rotatedEvent.secret_revision,
								previous_secret_expires_at: DateTime.makeUnsafe(
									rotatedEvent.previous_secret_expires_at,
								),
								signing_secret: signingSecret,
							}
						}
						const signingSecret = yield* deriveCurrentSecret(params.webhook_id, state)
						return { ...webhookResource(params.webhook_id, state), signing_secret: signingSecret }
					}),
				),
			)
			.handle("test", ({ params }) =>
				handled(
					Effect.gen(function* () {
						const state = yield* requireLive(params.webhook_id)
						if (state.status !== "active") {
							return yield* reject(
								409,
								`Webhook ${params.webhook_id} is ${state.status}; resume or reactivate it before sending a test delivery.`,
							)
						}
						const nowMillis = yield* Clock.currentTimeMillis
						const eventId = WebhookEventId.make(yield* randomId(random, "evt"))
						const deliveryId = WebhookDeliveryId.make(yield* randomId(random, "wdel"))
						const payloadJson = buildWebhookEventEnvelopeJson({
							event_id: eventId,
							event_type: "webhook.test",
							resource_type: "webhook",
							resource_id: params.webhook_id,
							occurred_at: nowMillis,
						})
						const record = yield* storedDelivery(
							deliveries.enqueue(params.webhook_id, {
								delivery_id: deliveryId,
								event_id: eventId,
								event_type: "webhook.test",
								dedupe_key: eventId,
								payload_json: payloadJson,
							}),
						)
						return deliveryResource(record)
					}),
				),
			)
			.handle("delete", ({ params }) =>
				handled(
					Effect.gen(function* () {
						const state = yield* webhooks.get(params.webhook_id)
						if (state.status === "") {
							return yield* reject(404, `Webhook ${params.webhook_id} not found.`)
						}
						if (state.status !== "deleted") {
							yield* webhooks
								.send(new DeleteWebhookEndpoint({ webhook_id: params.webhook_id }))
								.pipe(
									Effect.catchTag("WebhookNotFound", (refused) =>
										Effect.flatMap(webhooks.get(params.webhook_id), (now) =>
											now.status === "deleted" ? Effect.void : Effect.fail(refused),
										),
									),
								)
						}
						yield* storedDelivery(deliveries.purge(params.webhook_id))
						return { id: params.webhook_id, type: "webhook_deleted" as const }
					}),
				),
			)
			.handle("listDeliveries", ({ params, query }) =>
				handled(
					Effect.gen(function* () {
						yield* requireLive(params.webhook_id)
						const page = yield* storedDelivery(
							deliveries.listDeliveries(params.webhook_id, {
								page: query.page,
								limit: query.limit,
							}),
						)
						return { data: page.data.map(deliveryResource), next_page: page.next_page }
					}),
				),
			)
			.handle("getDelivery", ({ params }) =>
				handled(
					Effect.gen(function* () {
						yield* requireLive(params.webhook_id)
						const record = yield* storedDelivery(
							deliveries.getDelivery(params.webhook_id, params.delivery_id),
						)
						if (record === null) {
							return yield* reject(404, `Webhook delivery ${params.delivery_id} not found.`)
						}
						return deliveryResource(record)
					}),
				),
			)
			.handle("redeliver", ({ params }) =>
				handled(
					Effect.gen(function* () {
						const state = yield* requireLive(params.webhook_id)
						if (state.status !== "active") {
							return yield* reject(
								409,
								`Webhook ${params.webhook_id} is ${state.status}; resume or reactivate it before redelivering.`,
							)
						}
						const newDeliveryId = WebhookDeliveryId.make(yield* randomId(random, "wdel"))
						const record = yield* storedDelivery(
							deliveries.redeliver(params.webhook_id, params.delivery_id, newDeliveryId),
						)
						if (record === null) {
							return yield* reject(404, `Webhook delivery ${params.delivery_id} not found.`)
						}
						return deliveryResource(record)
					}),
				),
			)
	}),
)
