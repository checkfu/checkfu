import type { WebhookEventType } from "@checkfu/sdk/Schemas"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

export const WebhookResourceType = Schema.Literals([
	"agent",
	"environment",
	"session",
	"automation",
	"automation_run",
	"artifact",
	"vault",
	"vault_credential",
	"memory_store",
	"webhook",
])
export type WebhookResourceType = typeof WebhookResourceType.Type

export interface WebhookEventPublication {
	readonly event_id: string
	readonly event_type: WebhookEventType
	readonly resource_type: WebhookResourceType
	readonly resource_id: string
	readonly occurred_at: number
	readonly vault_id?: string
	readonly automation_id?: string
	readonly data_json?: string
}

export interface WebhookEventsService {
	readonly publish: (event: WebhookEventPublication) => Effect.Effect<void>
}

export class WebhookEvents extends Context.Service<WebhookEvents, WebhookEventsService>()(
	"Checkfu/WebhookEvents",
) {}

export const WebhookEventsNoop: Layer.Layer<WebhookEvents> = Layer.succeed(WebhookEvents, {
	publish: () => Effect.void,
})
