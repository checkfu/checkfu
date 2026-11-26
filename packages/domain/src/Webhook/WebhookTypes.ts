import * as Schema from "effect/Schema"
import {
	MAX_WEBHOOK_DESCRIPTION_LENGTH,
	MAX_WEBHOOK_EVENT_TYPES,
	MAX_WEBHOOK_URL_LENGTH,
	NonEmptyString,
	NonNegativeInt,
	PositiveInt,
} from "@checkfu/sdk/Schemas"

export {
	MAX_WEBHOOK_DESCRIPTION_LENGTH,
	MAX_WEBHOOK_EVENT_TYPES,
	MAX_WEBHOOK_URL_LENGTH,
	NonEmptyString,
	NonNegativeInt,
	PositiveInt,
}

export const WEBHOOK_SECRET_ROTATION_GRACE_MS = 86_400_000
export const SUSTAINED_FAILURE_DISABLE_WINDOW_MS = 86_400_000
export const WEBHOOK_SECRET_SALT_MAX_LENGTH = 128
export const WEBHOOK_EVENT_FILTERS_MAX_LENGTH = 4096

export const WebhookUrl = NonEmptyString
export const WebhookDescription = Schema.String
export const WebhookEventFilterList = NonEmptyString
export const WebhookSecretSalt = NonEmptyString

export const WebhookOutcomeKind = Schema.Literals(["delivered", "redirect", "failed"])
export type WebhookOutcomeKind = typeof WebhookOutcomeKind.Type

export const WebhookDisableReason = Schema.Literals(["redirect", "sustained_failure"])
export type WebhookDisableReason = typeof WebhookDisableReason.Type

export const encodeWebhookEventTypes = (eventTypes: ReadonlyArray<string>): string => {
	const unique = new Set<string>()
	for (const raw of eventTypes) {
		const trimmed = raw.trim()
		if (trimmed.length > 0) {
			unique.add(trimmed)
		}
	}
	return Array.from(unique).join(",")
}

export const decodeWebhookEventTypes = (encoded: string): ReadonlyArray<string> => {
	if (encoded.length === 0) {
		return []
	}
	const out: Array<string> = []
	for (const raw of encoded.split(",")) {
		const trimmed = raw.trim()
		if (trimmed.length > 0) {
			out.push(trimmed)
		}
	}
	return out
}

export const matchesWebhookSubscription = (
	eventTypes: string | ReadonlyArray<string>,
	eventType: string,
): boolean => {
	const list = typeof eventTypes === "string" ? decodeWebhookEventTypes(eventTypes) : eventTypes
	return list.includes("*") || list.includes(eventType)
}
