import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { WebhookDelivery } from "../src/Webhook/WebhookDelivery.aggregate.ts"

const STANDING = {
	AttemptsStayWithinTheLimit: "proved",
	PendingDeliveryHasAnAttemptLeft: "proved",
	PendingExactlyWhenANextAttemptIsSet: "proved",
	FinishedExactlyWhenCompleted: "proved",
	AFinishedDeliveryNeverChanges: "proved",
	AnAttemptCountsOnce: "proved",
	ARetryNeedsARetryableResultBelowTheLimit: "proved",
	ADeliveredAttemptSucceeds: "proved",
} as const

it.live(
	"proves the transitions used by webhook delivery storage",
	() =>
		Effect.gen(function* () {
			const report = yield* Verify.aggregate(WebhookDelivery, {
				lock: "./WebhookDelivery.verify.lock.json",
				require: { proved: Object.keys(STANDING) },
			})
			yield* Effect.logInfo(Verify.render(report))
			expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
				STANDING,
			)
			expect(report.undone).toEqual([])
		}).pipe(Effect.provide(NodeServices.layer)),
	120_000,
)
