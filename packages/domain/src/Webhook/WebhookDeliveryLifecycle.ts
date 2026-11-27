import { WebhookDeliveryStatus } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import { NonNegativeInt, PositiveInt } from "./WebhookTypes.ts"

export const WEBHOOK_MAX_ATTEMPTS = 6

export const WebhookAttemptLimit = PositiveInt.check(
	Schema.isLessThanOrEqualTo(WEBHOOK_MAX_ATTEMPTS),
)

export const AttemptResult = Schema.Literals(["delivered", "retryable", "permanent"])
export type AttemptResult = typeof AttemptResult.Type

export const DeliveryLifecycleFields = {
	status: Schema.Union([Schema.Literal(""), WebhookDeliveryStatus]),
	attempts: NonNegativeInt,
	max_attempts: NonNegativeInt,
	next_attempt_at: Schema.NullOr(NonNegativeInt),
	completed_at: Schema.NullOr(NonNegativeInt),
}

export const DeliveryLifecycle = Schema.Struct(DeliveryLifecycleFields)
export type DeliveryLifecycle = typeof DeliveryLifecycle.Type

export const queueDelivery = (max_attempts: number, at: number): DeliveryLifecycle => ({
	status: "pending",
	attempts: 0,
	max_attempts,
	next_attempt_at: at,
	completed_at: null,
})

export const recordDeliveryAttempt = (
	state: DeliveryLifecycle,
	result: AttemptResult,
	at: number,
	retry_delay_ms: number,
): DeliveryLifecycle => {
	if (state.status !== "pending") {
		return state
	}
	const attempts = state.attempts + 1
	if (result === "retryable" && attempts < state.max_attempts && retry_delay_ms > 0) {
		return { ...state, attempts, next_attempt_at: at + retry_delay_ms }
	}
	return {
		...state,
		status: result === "delivered" ? "succeeded" : "failed",
		attempts,
		next_attempt_at: null,
		completed_at: at,
	}
}

export const skipDelivery = (state: DeliveryLifecycle, at: number): DeliveryLifecycle =>
	state.status === "pending"
		? { ...state, status: "skipped", next_attempt_at: null, completed_at: at }
		: state
