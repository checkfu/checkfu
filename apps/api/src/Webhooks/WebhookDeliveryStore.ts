import type {
	WebhookDeliveryId,
	WebhookDeliveryOutcome,
	WebhookDeliveryStatus,
	WebhookEventId,
	WebhookId,
} from "@checkfu/sdk/Schemas"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import type * as Effect from "effect/Effect"

export class WebhookDeliveryStoreError extends Data.TaggedError("WebhookDeliveryStoreError")<{
	readonly cause: unknown
}> {}

export interface WebhookDeliveryRecord {
	readonly id: WebhookDeliveryId
	readonly webhook_id: WebhookId
	readonly event_id: WebhookEventId
	readonly event_type: string
	readonly status: WebhookDeliveryStatus
	readonly attempt_count: number
	readonly max_attempts: number
	readonly next_attempt_at: number | null
	readonly last_attempt_at: number | null
	readonly last_http_status: number | null
	readonly last_outcome: WebhookDeliveryOutcome | null
	readonly last_error: string | null
	readonly created_at: number
	readonly updated_at: number
	readonly completed_at: number | null
}

export interface EnqueueWebhookDeliveryInput {
	readonly delivery_id: WebhookDeliveryId
	readonly event_id: WebhookEventId
	readonly event_type: string
	readonly dedupe_key: string
	readonly payload_json: string
}

export interface ListWebhookDeliveriesQuery {
	readonly after?: string | undefined
	readonly limit?: number | undefined
}

export interface ListWebhookDeliveriesPage {
	readonly data: ReadonlyArray<WebhookDeliveryRecord>
	readonly has_more: boolean
	readonly next_cursor: string | null
}

export interface WebhookDeliveryStoreService {
	readonly enqueue: (
		webhookId: WebhookId,
		input: EnqueueWebhookDeliveryInput,
	) => Effect.Effect<WebhookDeliveryRecord, WebhookDeliveryStoreError>
	readonly listDeliveries: (
		webhookId: WebhookId,
		query: ListWebhookDeliveriesQuery,
	) => Effect.Effect<ListWebhookDeliveriesPage, WebhookDeliveryStoreError>
	readonly getDelivery: (
		webhookId: WebhookId,
		deliveryId: WebhookDeliveryId,
	) => Effect.Effect<WebhookDeliveryRecord | null, WebhookDeliveryStoreError>
	readonly redeliver: (
		webhookId: WebhookId,
		deliveryId: WebhookDeliveryId,
		newDeliveryId: WebhookDeliveryId,
	) => Effect.Effect<WebhookDeliveryRecord | null, WebhookDeliveryStoreError>
	readonly purge: (webhookId: WebhookId) => Effect.Effect<void, WebhookDeliveryStoreError>
}

export class WebhookDeliveryStore extends Context.Service<
	WebhookDeliveryStore,
	WebhookDeliveryStoreService
>()("@checkfu/api/WebhookDeliveryStore") {}

export interface WebhookEventEnvelopeInput {
	readonly event_id: string
	readonly event_type: string
	readonly resource_type: string
	readonly resource_id: string
	readonly occurred_at: number
	readonly data_json: string
}

const isValidJson = (raw: string): boolean => {
	try {
		JSON.parse(raw)
		return true
	} catch {
		return false
	}
}

export const buildWebhookEventEnvelopeJson = (input: WebhookEventEnvelopeInput): string => {
	const head = JSON.stringify({
		id: input.event_id,
		type: input.event_type,
		resource_type: input.resource_type,
		resource_id: input.resource_id,
		created_at: DateTime.formatIso(DateTime.makeUnsafe(input.occurred_at)),
	})
	const dataJson = isValidJson(input.data_json) ? input.data_json : "{}"
	return `${head.slice(0, -1)},"data":${dataJson}}`
}
