import * as InMemory from "@alchemy.run/domain/InMemory"
import { Story } from "@alchemy.run/domain/Story"
import { describe, expect, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ListingStore } from "../src/Listing/ListingStore.ts"
import {
	CreateWebhookEndpoint,
	WebhookEndpointCreated,
} from "../src/Webhook/CreateWebhookEndpoint.command.ts"
import {
	DeleteWebhookEndpoint,
	WebhookEndpointDeleted,
} from "../src/Webhook/DeleteWebhookEndpoint.command.ts"
import {
	ExpirePreviousWebhookSecret,
	WebhookPreviousSecretExpired,
} from "../src/Webhook/ExpirePreviousWebhookSecret.command.ts"
import { EXPIRE_PREVIOUS_SECRET } from "../src/Webhook/ExpirePreviousWebhookSecrets.policy.ts"
import {
	PauseWebhookEndpoint,
	WebhookEndpointPaused,
} from "../src/Webhook/PauseWebhookEndpoint.command.ts"
import {
	RecordWebhookOutcome,
	WebhookDisabledByHealth,
	WebhookHealthCleared,
	WebhookHealthDegraded,
	WebhookHealthReanchored,
} from "../src/Webhook/RecordWebhookOutcome.command.ts"
import {
	ResumeWebhookEndpoint,
	WebhookEndpointResumed,
} from "../src/Webhook/ResumeWebhookEndpoint.command.ts"
import {
	RotateWebhookSecret,
	WebhookSecretRotated,
} from "../src/Webhook/RotateWebhookSecret.command.ts"
import {
	UpdateWebhookEndpoint,
	WebhookEndpointUpdated,
} from "../src/Webhook/UpdateWebhookEndpoint.command.ts"
import { WebhookId } from "../src/Webhook/Webhook.id.ts"
import { WebhookAlreadyExists } from "../src/Webhook/WebhookAlreadyExists.rejection.ts"
import { WebhookDeletedError } from "../src/Webhook/WebhookDeleted.rejection.ts"
import { WebhookEndpoint } from "../src/Webhook/WebhookEndpoint.aggregate.ts"
import { WebhookInvalidUrl } from "../src/Webhook/WebhookInvalidUrl.rejection.ts"
import { WebhookNotFound } from "../src/Webhook/WebhookNotFound.rejection.ts"
import {
	SUSTAINED_FAILURE_DISABLE_WINDOW_MS,
	WEBHOOK_SECRET_ROTATION_GRACE_MS,
} from "../src/Webhook/WebhookTypes.ts"
import { parsePublicHttpsWebhookUrl } from "../src/Webhook/WebhookUrl.ts"
import { Webhooks, WebhooksHandlersLive } from "../src/Webhooks.model.ts"

const story = Story.make(Webhooks, {
	layer: WebhooksHandlersLive.pipe(Layer.provide(ListingStore.memory)),
})

const at = (iso: string) => DateTime.makeUnsafe(iso)
const ms = (iso: string) => DateTime.toEpochMillis(at(iso))
const t0 = at("2026-01-01T00:00:00.000Z")
const t0Ms = ms("2026-01-01T00:00:00.000Z")

const SALT_1 = "salt_0123456789abcdef"
const SALT_2 = "salt_fedcba9876543210"
const SALT_3 = "salt_abcdef0123456789"

describe("WebhookUrl SSRF validation", () => {
	it("accepts public HTTPS URLs including query parameters and rejects unsafe destinations", () => {
		expect(parsePublicHttpsWebhookUrl("https://hooks.example.com/v1/events?source=checkfu")).toBe(
			"https://hooks.example.com/v1/events?source=checkfu",
		)
		expect(parsePublicHttpsWebhookUrl("https://1.1.1.1/hook")).toBe("https://1.1.1.1/hook")
		expect(parsePublicHttpsWebhookUrl("https://[2606:4700:4700::1111]/hook")).toBe(
			"https://[2606:4700:4700::1111]/hook",
		)
		for (const bad of [
			"http://hooks.example.com/hook",
			"https://localhost/hook",
			"https://api.localhost/hook",
			"https://printer.local/hook",
			"https://metadata.internal/hook",
			"https://metadata/hook",
			"https://user:pass@hooks.example.com/hook",
			"https://hooks.example.com/hook#frag",
			"https://127.0.0.1/hook",
			"https://10.0.0.1/hook",
			"https://172.16.0.1/hook",
			"https://192.168.1.1/hook",
			"https://169.254.169.254/latest/meta-data/",
			"https://100.64.0.1/hook",
			"https://[::1]/hook",
			"https://[fc00::1]/hook",
			"https://[fe80::1]/hook",
			"https://[::ffff:127.0.0.1]/hook",
			"https://[::ffff:7f00:1]/hook",
			"https://[64:ff9b::127.0.0.1]/hook",
			"https://[2001:db8::1]/hook",
			"https://[2002:7f00:1::]/hook",
		]) {
			expect(parsePublicHttpsWebhookUrl(bad), bad).toBeNull()
		}
	})
})

describe("Webhooks model stories", () => {
	it.effect(
		"rotates secrets with 24h dual-secret grace, auto-expires via scheduled alarm, and ignores stale expirations",
		() => {
			const endpoint = WebhookEndpoint.ref(WebhookId.make("whe_rotate_1"))
			const grace1 = t0Ms + WEBHOOK_SECRET_ROTATION_GRACE_MS
			const grace2 = t0Ms + 3_600_000 + WEBHOOK_SECRET_ROTATION_GRACE_MS
			return story(
				Story.clock(t0),
				Story.when(
					new CreateWebhookEndpoint({
						webhook_id: endpoint.id,
						url: "http://hooks.example.com/insecure",
						description: "",
						event_types: "*",
						secret_salt: SALT_1,
					}),
				),
				Story.rejected(new WebhookInvalidUrl({ url: "http://hooks.example.com/insecure" })),
				Story.when(
					new CreateWebhookEndpoint({
						webhook_id: endpoint.id,
						url: "https://hooks.example.com/events",
						description: "Primary sink",
						event_types: "session.status_idle,automation.run_failed",
						secret_salt: SALT_1,
					}),
				),
				Story.then(
					endpoint,
					new WebhookEndpointCreated({
						url: "https://hooks.example.com/events",
						description: "Primary sink",
						event_types: "session.status_idle,automation.run_failed",
						secret_salt: SALT_1,
					}),
				),
				Story.when(
					new CreateWebhookEndpoint({
						webhook_id: endpoint.id,
						url: "https://hooks.example.com/dup",
						description: "",
						event_types: "*",
						secret_salt: SALT_2,
					}),
				),
				Story.rejected(new WebhookAlreadyExists({ webhook_id: endpoint.id })),

				Story.when(
					new RotateWebhookSecret({
						webhook_id: endpoint.id,
						next_secret_salt: SALT_2,
						grace_until: grace1,
					}),
				),
				Story.then(
					endpoint,
					new WebhookSecretRotated({
						secret_revision: 2,
						secret_salt: SALT_2,
						previous_secret_revision: 1,
						previous_secret_salt: SALT_1,
						previous_secret_expires_at: grace1,
					}),
				),
				Story.state(endpoint, {
					status: "active",
					secret_revision: 2,
					secret_salt: SALT_2,
					previous_secret_revision: 1,
					previous_secret_salt: SALT_1,
					previous_secret_expires_at: grace1,
				}),

				// Rotate again an hour later; stale expiry for revision 2 is ignored, while revision 3's alarm fires.
				Story.clock(DateTime.makeUnsafe(t0Ms + 3_600_000)),
				Story.when(
					new RotateWebhookSecret({
						webhook_id: endpoint.id,
						next_secret_salt: SALT_3,
						grace_until: grace2,
					}),
				),
				Story.then(
					endpoint,
					new WebhookSecretRotated({
						secret_revision: 3,
						secret_salt: SALT_3,
						previous_secret_revision: 2,
						previous_secret_salt: SALT_2,
						previous_secret_expires_at: grace2,
					}),
				),
				Story.when(
					new ExpirePreviousWebhookSecret({
						webhook_id: endpoint.id,
						for_revision: 2,
					}),
				),
				Story.then(endpoint),
				Story.state(endpoint, {
					secret_revision: 3,
					previous_secret_revision: 2,
					previous_secret_salt: SALT_2,
					previous_secret_expires_at: grace2,
				}),

				Story.clock(DateTime.makeUnsafe(grace2)),
				Story.then(endpoint, new WebhookPreviousSecretExpired({ expired_revision: 2 })),
				Story.state(endpoint, {
					secret_revision: 3,
					secret_salt: SALT_3,
					previous_secret_revision: 0,
					previous_secret_salt: "",
					previous_secret_expires_at: 0,
				}),
			)
		},
	)

	it.effect(
		"enforces redirect disable, sustained failure disable, re-anchoring on late success, recovery, and delete",
		() => {
			const endpoint = WebhookEndpoint.ref(WebhookId.make("whe_health_1"))
			return story(
				Story.clock(t0),
				Story.when(new PauseWebhookEndpoint({ webhook_id: endpoint.id })),
				Story.rejected(new WebhookNotFound({ webhook_id: endpoint.id })),

				Story.when(
					new CreateWebhookEndpoint({
						webhook_id: endpoint.id,
						url: "https://hooks.example.com/health",
						description: "",
						event_types: "*",
						secret_salt: SALT_1,
					}),
				),
				Story.then(
					endpoint,
					new WebhookEndpointCreated({
						url: "https://hooks.example.com/health",
						description: "",
						event_types: "*",
						secret_salt: SALT_1,
					}),
				),

				// Healthy delivery with no failure window is a zero-event no-op.
				Story.when(
					new RecordWebhookOutcome({
						webhook_id: endpoint.id,
						definition_revision: 1,
						outcome: "delivered",
						observed_at: t0Ms + 1000,
					}),
				),
				Story.then(endpoint),

				// Failure opens failure window; earlier success re-anchors window; newer success clears it.
				Story.when(
					new RecordWebhookOutcome({
						webhook_id: endpoint.id,
						definition_revision: 1,
						outcome: "failed",
						observed_at: t0Ms + 5000,
					}),
				),
				Story.then(
					endpoint,
					new WebhookHealthDegraded({
						window_started_at: t0Ms + 5000,
						last_failure_at: t0Ms + 5000,
					}),
				),
				Story.when(
					new RecordWebhookOutcome({
						webhook_id: endpoint.id,
						definition_revision: 1,
						outcome: "delivered",
						observed_at: t0Ms + 2000,
					}),
				),
				Story.then(
					endpoint,
					new WebhookHealthReanchored({
						window_started_at: t0Ms + 5000,
						last_failure_at: t0Ms + 5000,
					}),
				),
				Story.when(
					new RecordWebhookOutcome({
						webhook_id: endpoint.id,
						definition_revision: 1,
						outcome: "delivered",
						observed_at: t0Ms + 6000,
					}),
				),
				Story.then(endpoint, new WebhookHealthCleared()),

				// Redirect disables immediately; stale revision outcomes are ignored after reactivation.
				Story.when(
					new RecordWebhookOutcome({
						webhook_id: endpoint.id,
						definition_revision: 1,
						outcome: "redirect",
						observed_at: t0Ms + 7000,
					}),
				),
				Story.then(
					endpoint,
					new WebhookDisabledByHealth({
						reason: "redirect",
						window_started_at: t0Ms + 7000,
						last_failure_at: t0Ms + 7000,
					}),
				),
				Story.state(endpoint, { status: "disabled_redirect", definition_revision: 1 }),

				Story.when(
					new UpdateWebhookEndpoint({
						webhook_id: endpoint.id,
						url: "https://hooks.example.com/health-v2",
						description: "Fixed URL",
						event_types: "*",
						reactivate: true,
					}),
				),
				Story.then(
					endpoint,
					new WebhookEndpointUpdated({
						url: "https://hooks.example.com/health-v2",
						description: "Fixed URL",
						event_types: "*",
						reactivated: true,
					}),
				),
				Story.state(endpoint, {
					status: "active",
					definition_revision: 2,
					failure_window_started_at: 0,
					consecutive_failures: 0,
				}),

				// Stale outcome from revision 1 is ignored.
				Story.when(
					new RecordWebhookOutcome({
						webhook_id: endpoint.id,
						definition_revision: 1,
						outcome: "redirect",
						observed_at: t0Ms + 8000,
					}),
				),
				Story.then(endpoint),

				// Failures spanning >= 24h disable with disabled_sustained_failure.
				Story.when(
					new RecordWebhookOutcome({
						webhook_id: endpoint.id,
						definition_revision: 2,
						outcome: "failed",
						observed_at: t0Ms + 10_000,
					}),
				),
				Story.then(
					endpoint,
					new WebhookHealthDegraded({
						window_started_at: t0Ms + 10_000,
						last_failure_at: t0Ms + 10_000,
					}),
				),
				Story.when(
					new RecordWebhookOutcome({
						webhook_id: endpoint.id,
						definition_revision: 2,
						outcome: "failed",
						observed_at: t0Ms + 10_000 + SUSTAINED_FAILURE_DISABLE_WINDOW_MS,
					}),
				),
				Story.then(
					endpoint,
					new WebhookDisabledByHealth({
						reason: "sustained_failure",
						window_started_at: t0Ms + 10_000,
						last_failure_at: t0Ms + 10_000 + SUSTAINED_FAILURE_DISABLE_WINDOW_MS,
					}),
				),
				Story.state(endpoint, { status: "disabled_sustained_failure" }),

				// Resume bumps definition_revision and clears health.
				Story.when(new ResumeWebhookEndpoint({ webhook_id: endpoint.id })),
				Story.then(endpoint, new WebhookEndpointResumed()),
				Story.state(endpoint, {
					status: "active",
					definition_revision: 3,
					failure_window_started_at: 0,
					last_failure_at: 0,
					consecutive_failures: 0,
				}),

				// Pause and resume round-trip.
				Story.when(new PauseWebhookEndpoint({ webhook_id: endpoint.id })),
				Story.then(endpoint, new WebhookEndpointPaused()),
				Story.state(endpoint, { status: "paused" }),
				Story.when(new ResumeWebhookEndpoint({ webhook_id: endpoint.id })),
				Story.then(endpoint, new WebhookEndpointResumed()),
				Story.state(endpoint, {
					status: "active",
					definition_revision: 4,
					failure_window_started_at: 0,
					last_failure_at: 0,
					consecutive_failures: 0,
				}),

				// Delete clears all secrets and refuses subsequent mutations.
				Story.when(new DeleteWebhookEndpoint({ webhook_id: endpoint.id })),
				Story.then(endpoint, new WebhookEndpointDeleted()),
				Story.state(endpoint, {
					status: "deleted",
					secret_salt: "",
					previous_secret_revision: 0,
					previous_secret_salt: "",
					previous_secret_expires_at: 0,
				}),
				Story.when(new PauseWebhookEndpoint({ webhook_id: endpoint.id })),
				Story.rejected(new WebhookDeletedError({ webhook_id: endpoint.id })),
			)
		},
	)

	it.effect("cancels the secret expiry alarm when a rotated endpoint is deleted", () => {
		const platform = InMemory.make({ manual: true, now: () => t0Ms })
		const id = WebhookId.make("whe_alarm_cancel")
		return Effect.gen(function* () {
			const webhooks = yield* WebhookEndpoint
			yield* webhooks.send(
				new CreateWebhookEndpoint({
					webhook_id: id,
					url: "https://hooks.example.com/alarm",
					description: "",
					event_types: "*",
					secret_salt: SALT_1,
				}),
			)
			yield* platform.control.drain
			yield* webhooks.send(
				new RotateWebhookSecret({
					webhook_id: id,
					next_secret_salt: SALT_2,
					grace_until: t0Ms + WEBHOOK_SECRET_ROTATION_GRACE_MS,
				}),
			)
			yield* platform.control.drain
			yield* webhooks.send(new DeleteWebhookEndpoint({ webhook_id: id }))
			yield* platform.control.drain
			const cancelled = yield* Effect.flip(webhooks.unschedule(id, EXPIRE_PREVIOUS_SECRET))
			expect(cancelled._tag).toBe("AlreadyCancelled")
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Webhooks.layer(WebhooksHandlersLive.pipe(Layer.provide(ListingStore.memory))).pipe(
					Layer.provide(platform.layer),
				),
			),
		)
	})
})
