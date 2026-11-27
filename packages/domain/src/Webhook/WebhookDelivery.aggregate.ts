import * as Domain from "@alchemy.run/domain"
import { WebhookDeliveryId } from "@checkfu/sdk/Schemas"
import { QueueWebhookDelivery, WebhookDeliveryQueued } from "./QueueWebhookDelivery.command.ts"
import { RecordWebhookAttempt, WebhookAttemptRecorded } from "./RecordWebhookAttempt.command.ts"
import { SkipWebhookDelivery, WebhookDeliverySkipped } from "./SkipWebhookDelivery.command.ts"
import {
	DeliveryLifecycle,
	WEBHOOK_MAX_ATTEMPTS,
	queueDelivery,
	recordDeliveryAttempt,
	skipDelivery,
} from "./WebhookDeliveryLifecycle.ts"

const eventState = (_state: DeliveryLifecycle, event: DeliveryLifecycle): DeliveryLifecycle => ({
	status: event.status,
	attempts: event.attempts,
	max_attempts: event.max_attempts,
	next_attempt_at: event.next_attempt_at,
	completed_at: event.completed_at,
})

export class WebhookDelivery extends Domain.Aggregate("WebhookDelivery", {
	id: WebhookDeliveryId,
	state: DeliveryLifecycle,
	initial: { status: "", attempts: 0, max_attempts: 0, next_attempt_at: null, completed_at: null },
	commands: [QueueWebhookDelivery, RecordWebhookAttempt, SkipWebhookDelivery],
	keyOf: (cmd) => cmd.delivery_id,
	invariants: {
		AttemptsStayWithinTheLimit: (s) =>
			[s.attempts <= s.max_attempts, s.max_attempts <= WEBHOOK_MAX_ATTEMPTS].every((ok) => ok),
		PendingDeliveryHasAnAttemptLeft: (s) => s.status !== "pending" || s.attempts < s.max_attempts,
		PendingExactlyWhenANextAttemptIsSet: (s) =>
			(s.status === "pending") === (s.next_attempt_at !== null),
		FinishedExactlyWhenCompleted: (s) =>
			[s.status === "succeeded", s.status === "failed", s.status === "skipped"].some((ok) => ok) ===
			(s.completed_at !== null),
	},
	transitions: {
		AFinishedDeliveryNeverChanges: ({ before, after }) =>
			[
				before.status === "",
				before.status === "pending",
				[
					after.status === before.status,
					after.attempts === before.attempts,
					after.max_attempts === before.max_attempts,
					after.next_attempt_at === before.next_attempt_at,
					after.completed_at === before.completed_at,
				].every((ok) => ok),
			].some((ok) => ok),
		AnAttemptCountsOnce: ({ before, after, command }) => {
			if (command._tag !== "RecordWebhookAttempt") {
				return true
			}
			return (
				after.attempts === (before.status === "pending" ? before.attempts + 1 : before.attempts)
			)
		},
		ARetryNeedsARetryableResultBelowTheLimit: ({ before, after, command }) => {
			if (command._tag !== "RecordWebhookAttempt" || before.status !== "pending") {
				return true
			}
			return (
				(after.status === "pending") ===
				[
					command.result === "retryable",
					after.attempts < after.max_attempts,
					command.retry_delay_ms > 0,
				].every((ok) => ok)
			)
		},
		ADeliveredAttemptSucceeds: ({ before, after, command }) => {
			if (command._tag !== "RecordWebhookAttempt" || before.status !== "pending") {
				return true
			}
			return (after.status === "succeeded") === (command.result === "delivered")
		},
	},
	decide: {
		QueueWebhookDelivery: (state, cmd) =>
			state.status === ""
				? [new WebhookDeliveryQueued(queueDelivery(cmd.max_attempts, cmd.at))]
				: [],
		RecordWebhookAttempt: (state, cmd) =>
			state.status === "pending"
				? [
						new WebhookAttemptRecorded(
							recordDeliveryAttempt(state, cmd.result, cmd.at, cmd.retry_delay_ms),
						),
					]
				: [],
		SkipWebhookDelivery: (state, cmd) =>
			state.status === "pending" ? [new WebhookDeliverySkipped(skipDelivery(state, cmd.at))] : [],
	},
	evolve: {
		"webhook_delivery.queued": eventState,
		"webhook_delivery.attempt_recorded": eventState,
		"webhook_delivery.skipped": eventState,
	},
}) {}
