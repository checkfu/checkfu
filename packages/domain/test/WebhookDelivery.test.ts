import { expect, it } from "vitest"
import {
	WEBHOOK_MAX_ATTEMPTS,
	queueDelivery,
	recordDeliveryAttempt,
	skipDelivery,
} from "../src/Webhook/WebhookDeliveryLifecycle.ts"
import type { DeliveryLifecycle } from "../src/Webhook/WebhookDeliveryLifecycle.ts"

const results = ["delivered", "retryable", "permanent"] as const
const delays = [0, 30_000]
const attemptAt = 1000

it("records one attempt and makes exactly the eligible failures due again", () => {
	for (let limit = 1; limit <= WEBHOOK_MAX_ATTEMPTS; limit++) {
		const queued = queueDelivery(limit, 0)
		expect(queued).toEqual({
			status: "pending",
			attempts: 0,
			max_attempts: limit,
			next_attempt_at: 0,
			completed_at: null,
		})
		for (let attempts = 0; attempts < limit; attempts++) {
			const pending = { ...queued, attempts }
			for (const result of results) {
				for (const delay of delays) {
					const retries = result === "retryable" && delay > 0 && attempts + 1 < limit
					expect(recordDeliveryAttempt(pending, result, attemptAt, delay)).toEqual({
						status: retries ? "pending" : result === "delivered" ? "succeeded" : "failed",
						attempts: attempts + 1,
						max_attempts: limit,
						next_attempt_at: retries ? attemptAt + delay : null,
						completed_at: retries ? null : attemptAt,
					})
				}
			}
			expect(skipDelivery(pending, attemptAt)).toEqual({
				status: "skipped",
				attempts,
				max_attempts: limit,
				next_attempt_at: null,
				completed_at: attemptAt,
			})
		}
	}
})

it("leaves unqueued and terminal deliveries untouched and treats timestamp zero as a real time", () => {
	const initial: DeliveryLifecycle = {
		status: "",
		attempts: 0,
		max_attempts: 0,
		next_attempt_at: null,
		completed_at: null,
	}
	const terminal = (["succeeded", "failed", "skipped"] as const).flatMap((status) =>
		Array.from({ length: WEBHOOK_MAX_ATTEMPTS + 1 }, (_, attempts) => ({
			status,
			attempts,
			max_attempts: WEBHOOK_MAX_ATTEMPTS,
			next_attempt_at: null,
			completed_at: 0,
		})),
	)
	for (const state of [initial, ...terminal]) {
		for (const result of results) {
			for (const delay of delays) {
				expect(recordDeliveryAttempt(state, result, attemptAt, delay)).toBe(state)
			}
		}
		expect(skipDelivery(state, attemptAt)).toBe(state)
	}
	expect(recordDeliveryAttempt(queueDelivery(1, 0), "delivered", 0, 0).completed_at).toBe(0)
	expect(skipDelivery(queueDelivery(1, 0), 0).completed_at).toBe(0)
})
