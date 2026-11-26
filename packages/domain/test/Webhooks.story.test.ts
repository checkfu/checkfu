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
import { WebhookSecretRotationInProgress } from "../src/Webhook/WebhookSecretRotationInProgress.rejection.ts"
import {
	SUSTAINED_FAILURE_DISABLE_WINDOW_MS,
	WEBHOOK_SECRET_ROTATION_GRACE_MS,
} from "../src/Webhook/WebhookTypes.ts"
import { isPublicIpAddress, parsePublicHttpsWebhookUrl } from "../src/Webhook/WebhookUrl.ts"
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
			"https://[2001:0db8::1]/hook",
			"https://[2002:7f00:1::]/hook",
			// Canonicalizes via UTF-8 percent-encoding past the 2048-byte limit.
			`https://hooks.example.com/${"é".repeat(400)}`,
		]) {
			expect(parsePublicHttpsWebhookUrl(bad), bad).toBeNull()
		}

		expect(isPublicIpAddress("1.1.1.1")).toBe(true)
		expect(isPublicIpAddress("93.184.216.34")).toBe(true)
		expect(isPublicIpAddress("2606:4700:4700::1111")).toBe(true)
		expect(isPublicIpAddress("::ffff:93.184.216.34")).toBe(true)
		for (const badIp of [
			"",
			"not-an-ip",
			"127.0.0.1",
			"10.0.0.1",
			"172.16.0.1",
			"192.168.1.1",
			"169.254.169.254",
			"100.64.0.1",
			"198.18.0.1",
			"224.0.0.1",
			"::1",
			"::",
			"fc00::1",
			"fd12:3456::1",
			"fe80::1",
			"fe80::1%eth0",
			"::ffff:127.0.0.1",
			"::ffff:7f00:1",
			"0:0:0:0:0:ffff:7f00:1",
			"2001:db8::1",
			"2001:0db8::1",
			"2002::1",
			"64:ff9b::127.0.0.1",
		]) {
			expect(isPublicIpAddress(badIp), badIp).toBe(false)
		}
	})
})

describe("Webhooks model stories", () => {
	it.effect(
		"rotates secrets with 24h dual-secret grace, auto-expires via scheduled alarm, and ignores stale expirations",
		() => {
			const endpoint = WebhookEndpoint.ref(WebhookId.make("whe_rotate_1"))
			const grace1 = t0Ms + WEBHOOK_SECRET_ROTATION_GRACE_MS
			const grace2 = grace1 + WEBHOOK_SECRET_ROTATION_GRACE_MS
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
						rotated_at: t0Ms,
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

				// Overlapping rotation 1 hour later is refused so revision 1's advertised 24h grace period stays intact.
				Story.clock(DateTime.makeUnsafe(t0Ms + 3_600_000)),
				Story.when(
					new RotateWebhookSecret({
						webhook_id: endpoint.id,
						next_secret_salt: SALT_3,
						rotated_at: t0Ms + 3_600_000,
					}),
				),
				Story.rejected(
					new WebhookSecretRotationInProgress({
						webhook_id: endpoint.id,
						previous_secret_expires_at: grace1,
					}),
				),
				Story.state(endpoint, {
					secret_revision: 2,
					secret_salt: SALT_2,
					previous_secret_revision: 1,
					previous_secret_salt: SALT_1,
					previous_secret_expires_at: grace1,
				}),

				// Once grace1 elapses, the expiry alarm clears rev 1, and a second rotation succeeds.
				Story.clock(DateTime.makeUnsafe(grace1)),
				Story.then(endpoint, new WebhookPreviousSecretExpired({ expired_revision: 1 })),
				Story.when(
					new RotateWebhookSecret({
						webhook_id: endpoint.id,
						next_secret_salt: SALT_3,
						rotated_at: grace1,
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
				// Stale expiry for revision 2 is ignored while revision 3's alarm fires at grace2.
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

				// Failures at T1=5000 and T2=9000 open failure window [5000, 9000].
				// A delayed success before T1 (2000) is ignored; a success between T1 and T2 (7000)
				// reanchors the window to [9000, 9000]; a newer success (10000) clears it.
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
						outcome: "failed",
						observed_at: t0Ms + 9000,
					}),
				),
				Story.then(
					endpoint,
					new WebhookHealthDegraded({
						window_started_at: t0Ms + 5000,
						last_failure_at: t0Ms + 9000,
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
				Story.then(endpoint),
				Story.state(endpoint, {
					failure_window_started_at: t0Ms + 5000,
					last_failure_at: t0Ms + 9000,
					consecutive_failures: 2,
				}),
				Story.when(
					new RecordWebhookOutcome({
						webhook_id: endpoint.id,
						definition_revision: 1,
						outcome: "delivered",
						observed_at: t0Ms + 7000,
					}),
				),
				Story.then(
					endpoint,
					new WebhookHealthReanchored({
						window_started_at: t0Ms + 9000,
						last_failure_at: t0Ms + 9000,
					}),
				),
				Story.state(endpoint, {
					failure_window_started_at: t0Ms + 9000,
					last_failure_at: t0Ms + 9000,
					consecutive_failures: 1,
				}),
				Story.when(
					new RecordWebhookOutcome({
						webhook_id: endpoint.id,
						definition_revision: 1,
						outcome: "delivered",
						observed_at: t0Ms + 10_000,
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
						event_types: null,
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
					url: "https://hooks.example.com/health-v2",
					description: "Fixed URL",
					event_types: "*",
					definition_revision: 2,
					failure_window_started_at: 0,
					consecutive_failures: 0,
				}),

				// Partial description-only update preserves url and event_types atomically.
				Story.when(
					new UpdateWebhookEndpoint({
						webhook_id: endpoint.id,
						url: null,
						description: "Renamed sink",
						event_types: null,
						reactivate: false,
					}),
				),
				Story.then(
					endpoint,
					new WebhookEndpointUpdated({
						url: "https://hooks.example.com/health-v2",
						description: "Renamed sink",
						event_types: "*",
						reactivated: false,
					}),
				),
				Story.state(endpoint, {
					status: "active",
					url: "https://hooks.example.com/health-v2",
					description: "Renamed sink",
					event_types: "*",
					definition_revision: 3,
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
						definition_revision: 3,
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
						definition_revision: 3,
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
					definition_revision: 4,
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
					definition_revision: 5,
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
					rotated_at: t0Ms,
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
