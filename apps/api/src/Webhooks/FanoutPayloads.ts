import { WebhookResourceType } from "@checkfu/domain/Webhook/WebhookEvents.external"
import { WebhookEventType, WebhookId } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"

export const FANOUT_PAGE_CALLBACK = "fanoutPage"
export const RETRY_SUBSCRIBER_CALLBACK = "retrySubscriber"

const Publication = Schema.Struct({
	event_id: Schema.String,
	event_type: WebhookEventType,
	resource_type: WebhookResourceType,
	resource_id: Schema.String,
	occurred_at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	vault_id: Schema.optionalKey(Schema.String),
	automation_id: Schema.optionalKey(Schema.String),
})

export const FanoutPagePayload = Schema.Struct({
	event: Publication,
	cursor: Schema.String,
	step: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type FanoutPagePayload = typeof FanoutPagePayload.Type

export const RetrySubscriberPayload = Schema.Struct({
	event: Publication,
	webhookId: WebhookId,
})
export type RetrySubscriberPayload = typeof RetrySubscriberPayload.Type

export const WEBHOOK_FANOUT_PAYLOADS = {
	[FANOUT_PAGE_CALLBACK]: FanoutPagePayload,
	[RETRY_SUBSCRIBER_CALLBACK]: RetrySubscriberPayload,
} as const
