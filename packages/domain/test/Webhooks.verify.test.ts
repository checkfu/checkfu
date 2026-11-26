import { Story } from "@alchemy.run/domain/Story"
import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ListingStore } from "../src/Listing/ListingStore.ts"
import { ExpirePreviousWebhookSecrets } from "../src/Webhook/ExpirePreviousWebhookSecrets.policy.ts"
import { WebhookListingLive } from "../src/Webhook/WebhookListing.projection.ts"
import { Webhooks, WebhooksDomainApi } from "../src/Webhooks.model.ts"

const story = Story.make(Webhooks, {
	layer: Layer.mergeAll(
		ExpirePreviousWebhookSecrets.toLayer(Effect.succeed(() => Effect.void)),
		WebhookListingLive.pipe(Layer.provide(ListingStore.memory)),
	),
})

const STANDING = {
	"WebhookEndpoint.StatusIsKnown": "proved",
	"WebhookEndpoint.CreatedExactlyWhenRevised": "proved",
	"WebhookEndpoint.LiveEndpointHoldsSecretSalt": "proved",
	"WebhookEndpoint.LiveEndpointUsesHttps": "proved",
	"WebhookEndpoint.DeletedHoldsNoSecrets": "proved",
	"WebhookEndpoint.PreviousSecretConsistency": "proved",
	"WebhookEndpoint.FailureWindowOrdered": "proved",
	"WebhookEndpoint.NoWindowImpliesZeroConsecutiveFailures": "proved",
	"WebhookEndpoint.CreatedNeverReturnsToUninitialized": "proved",
	"WebhookEndpoint.DeletedStaysDeleted": "proved",
	"WebhookEndpoint.SecretRevisionMonotonic": "proved",
	"WebhookEndpoint.OnlyCreateOrRotateChangesSecretRevision": "proved",
	"WebhookEndpoint.DefinitionRevisionMonotonic": "proved",
	"WebhookEndpoint.StaleOrInactiveOutcomeIgnored": "proved",
	"WebhookEndpoint.RedirectImmediatelyDisablesActiveEndpoint": "proved",
	"WebhookEndpoint.SustainedFailureDisablesActiveEndpoint": "proved",
	"WebhookEndpoint.StaleSecretExpiryLeavesPreviousSecretUntouched": "proved",
	"WebhookEndpoint.ClaimingKeyChangesNoState": "proved",
	"Webhooks.AnEndpointIsCreated": "reached",
	"Webhooks.AnEndpointRotatesItsSecret": "reached",
	"Webhooks.AnEndpointExpiresItsPreviousSecret": "reached",
	"Webhooks.AnEndpointIsPaused": "reached",
	"Webhooks.AnEndpointIsDisabledByRedirect": "reached",
	"Webhooks.AnEndpointIsDisabledBySustainedFailure": "reached",
	"Webhooks.AnEndpointIsDeleted": "reached",
} as const

const PROVED = Object.entries(STANDING)
	.filter(([, standing]) => standing === "proved")
	.map(([name]) => name)

describe("Webhooks model Z3 formal verification", () => {
	it.live(
		"proves every WebhookEndpoint invariant and transition in Z3",
		() =>
			Effect.gen(function* () {
				const report = yield* Verify.model(Webhooks, {
					apis: [WebhooksDomainApi],
					story,
					instances: 1,
					depth: 3,
					faults: { redeliver: false, reorder: false, rerun: false },
					walks: { count: 50 },
					allow: { skipped: ["ExpirePreviousWebhookSecrets"] },
					lock: "./Webhooks.verify.lock.json",
					require: { proved: PROVED },
				})
				expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
					STANDING,
				)
				expect(report.undone).toEqual([])
				expect(report.explored.truncated).toBe(false)
				expect(report.explored.complete).toBe(3)
				expect(report.explored.disagreements).toEqual([])
				expect(report.explored.agreement.compared).toBeGreaterThan(0)
			}).pipe(Effect.provide(NodeServices.layer)),
		120_000,
	)
})
