import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import {
	ClaimWebhookIdempotencyKey,
	WebhookIdempotencyKeyClaimed,
} from "./ClaimWebhookIdempotencyKey.command.ts"
import { CreateWebhookEndpoint, WebhookEndpointCreated } from "./CreateWebhookEndpoint.command.ts"
import { DeleteWebhookEndpoint, WebhookEndpointDeleted } from "./DeleteWebhookEndpoint.command.ts"
import {
	ExpirePreviousWebhookSecret,
	WebhookPreviousSecretExpired,
} from "./ExpirePreviousWebhookSecret.command.ts"
import { PauseWebhookEndpoint, WebhookEndpointPaused } from "./PauseWebhookEndpoint.command.ts"
import {
	RecordWebhookOutcome,
	WebhookDisabledByHealth,
	WebhookHealthCleared,
	WebhookHealthDegraded,
	WebhookHealthReanchored,
} from "./RecordWebhookOutcome.command.ts"
import { ResumeWebhookEndpoint, WebhookEndpointResumed } from "./ResumeWebhookEndpoint.command.ts"
import { RotateWebhookSecret, WebhookSecretRotated } from "./RotateWebhookSecret.command.ts"
import { UpdateWebhookEndpoint, WebhookEndpointUpdated } from "./UpdateWebhookEndpoint.command.ts"
import { WebhookAlreadyExists } from "./WebhookAlreadyExists.rejection.ts"
import { WebhookDeletedError } from "./WebhookDeleted.rejection.ts"
import { WebhookId } from "./Webhook.id.ts"
import { WebhookInvalidUrl } from "./WebhookInvalidUrl.rejection.ts"
import { WebhookNotFound } from "./WebhookNotFound.rejection.ts"
import { NonNegativeInt, SUSTAINED_FAILURE_DISABLE_WINDOW_MS } from "./WebhookTypes.ts"

export const WebhookEndpointState = Schema.Struct({
	status: Schema.String,
	url: Schema.String,
	description: Schema.String,
	event_types: Schema.String,
	definition_revision: NonNegativeInt,
	secret_revision: NonNegativeInt,
	secret_salt: Schema.String,
	previous_secret_revision: NonNegativeInt,
	previous_secret_salt: Schema.String,
	previous_secret_expires_at: NonNegativeInt,
	failure_window_started_at: NonNegativeInt,
	last_failure_at: NonNegativeInt,
	consecutive_failures: NonNegativeInt,
	created_at: NonNegativeInt,
	updated_at: NonNegativeInt,
})
export type WebhookEndpointState = typeof WebhookEndpointState.Type

export const WEBHOOK_ENDPOINT_STATE_SCHEMA_VERSION = 1 as const

export const WebhookEndpointStateSnapshot = versionedSnapshot({
	current: WEBHOOK_ENDPOINT_STATE_SCHEMA_VERSION,
	schema: WebhookEndpointState,
})

const CLEAR_HEALTH = {
	failure_window_started_at: 0,
	last_failure_at: 0,
	consecutive_failures: 0,
} as const

export class WebhookEndpoint extends Domain.Aggregate("WebhookEndpoint", {
	id: WebhookId,
	state: WebhookEndpointStateSnapshot,
	initial: {
		status: "",
		url: "",
		description: "",
		event_types: "",
		definition_revision: 0,
		secret_revision: 0,
		secret_salt: "",
		previous_secret_revision: 0,
		previous_secret_salt: "",
		previous_secret_expires_at: 0,
		failure_window_started_at: 0,
		last_failure_at: 0,
		consecutive_failures: 0,
		created_at: 0,
		updated_at: 0,
	},
	commands: [
		CreateWebhookEndpoint,
		UpdateWebhookEndpoint,
		PauseWebhookEndpoint,
		ResumeWebhookEndpoint,
		RotateWebhookSecret,
		ExpirePreviousWebhookSecret,
		RecordWebhookOutcome,
		DeleteWebhookEndpoint,
		ClaimWebhookIdempotencyKey,
	],
	keyOf: (cmd) => cmd.webhook_id,
	invariants: {
		StatusIsKnown: (s) =>
			[
				s.status === "",
				s.status === "active",
				s.status === "paused",
				s.status === "disabled_redirect",
				s.status === "disabled_sustained_failure",
				s.status === "deleted",
			].some((ok) => ok),
		CreatedExactlyWhenRevised: (s) =>
			[
				[s.status === "", s.definition_revision === 0, s.secret_revision === 0, s.url === ""].every(
					(ok) => ok,
				),
				[s.status !== "", s.definition_revision >= 1, s.secret_revision >= 1, s.url !== ""].every(
					(ok) => ok,
				),
			].some((ok) => ok),
		LiveEndpointHoldsSecretSalt: (s) =>
			[s.status === "", s.status === "deleted", s.secret_salt !== ""].some((ok) => ok),
		LiveEndpointUsesHttps: (s) => [s.status === "", s.url.startsWith("https://")].some((ok) => ok),
		DeletedHoldsNoSecrets: (s) =>
			[
				s.status !== "deleted",
				[
					s.secret_salt === "",
					s.previous_secret_revision === 0,
					s.previous_secret_salt === "",
					s.previous_secret_expires_at === 0,
				].every((ok) => ok),
			].some((ok) => ok),
		PreviousSecretConsistency: (s) =>
			[
				[
					s.previous_secret_revision === 0,
					s.previous_secret_salt === "",
					s.previous_secret_expires_at === 0,
				].every((ok) => ok),
				[
					s.previous_secret_revision >= 1,
					s.previous_secret_revision < s.secret_revision,
					s.previous_secret_salt !== "",
					s.previous_secret_expires_at >= 1,
				].every((ok) => ok),
			].some((ok) => ok),
		FailureWindowOrdered: (s) =>
			[s.failure_window_started_at === 0, s.last_failure_at >= s.failure_window_started_at].some(
				(ok) => ok,
			),
		NoWindowImpliesZeroConsecutiveFailures: (s) =>
			[
				s.failure_window_started_at !== 0,
				[s.last_failure_at === 0, s.consecutive_failures === 0].every((ok) => ok),
			].some((ok) => ok),
	},
	transitions: {
		CreatedNeverReturnsToUninitialized: ({ before, after }) =>
			[before.status === "", after.status !== ""].some((ok) => ok),
		DeletedStaysDeleted: ({ before, after }) =>
			[before.status !== "deleted", after.status === "deleted"].some((ok) => ok),
		SecretRevisionMonotonic: ({ before, after }) =>
			[
				after.secret_revision === before.secret_revision,
				after.secret_revision === before.secret_revision + 1,
			].some((ok) => ok),
		OnlyCreateOrRotateChangesSecretRevision: ({ before, after, command }) =>
			[
				after.secret_revision === before.secret_revision,
				command._tag === "CreateWebhookEndpoint",
				command._tag === "RotateWebhookSecret",
			].some((ok) => ok),
		DefinitionRevisionMonotonic: ({ before, after }) =>
			[
				after.definition_revision === before.definition_revision,
				after.definition_revision === before.definition_revision + 1,
			].some((ok) => ok),
		StaleOrInactiveOutcomeIgnored: ({ before, after, command }) => {
			if (command._tag !== "RecordWebhookOutcome") {
				return true
			}
			return [
				[
					before.status === "active",
					command.definition_revision === before.definition_revision,
				].every((ok) => ok),
				[
					after.status === before.status,
					after.failure_window_started_at === before.failure_window_started_at,
					after.last_failure_at === before.last_failure_at,
					after.consecutive_failures === before.consecutive_failures,
				].every((ok) => ok),
			].some((ok) => ok)
		},
		RedirectImmediatelyDisablesActiveEndpoint: ({ before, after, command }) => {
			if (command._tag !== "RecordWebhookOutcome") {
				return true
			}
			return [
				before.status !== "active",
				command.definition_revision !== before.definition_revision,
				command.outcome !== "redirect",
				after.status === "disabled_redirect",
			].some((ok) => ok)
		},
		SustainedFailureDisablesActiveEndpoint: ({ before, after, command }) => {
			if (command._tag !== "RecordWebhookOutcome") {
				return true
			}
			return [
				before.status !== "active",
				command.definition_revision !== before.definition_revision,
				command.outcome !== "failed",
				after.status === "disabled_sustained_failure",
				after.last_failure_at - after.failure_window_started_at <
					SUSTAINED_FAILURE_DISABLE_WINDOW_MS,
			].some((ok) => ok)
		},
		StaleSecretExpiryLeavesPreviousSecretUntouched: ({ before, after, command }) => {
			if (command._tag !== "ExpirePreviousWebhookSecret") {
				return true
			}
			return [
				command.for_revision === before.secret_revision,
				[
					after.previous_secret_revision === before.previous_secret_revision,
					after.previous_secret_expires_at === before.previous_secret_expires_at,
				].every((ok) => ok),
			].some((ok) => ok)
		},
		ClaimingKeyChangesNoState: ({ before, after, command }) =>
			[
				command._tag !== "ClaimWebhookIdempotencyKey",
				[
					after.status === before.status,
					after.url === before.url,
					after.definition_revision === before.definition_revision,
					after.secret_revision === before.secret_revision,
					after.previous_secret_revision === before.previous_secret_revision,
					after.previous_secret_expires_at === before.previous_secret_expires_at,
					after.failure_window_started_at === before.failure_window_started_at,
					after.last_failure_at === before.last_failure_at,
					after.consecutive_failures === before.consecutive_failures,
				].every((ok) => ok),
			].some((ok) => ok),
	},
	decide: {
		CreateWebhookEndpoint: (state, cmd, ctx) => {
			if (state.status !== "") {
				return new WebhookAlreadyExists({ webhook_id: ctx.id })
			}
			if (!cmd.url.startsWith("https://")) {
				return new WebhookInvalidUrl({ url: cmd.url })
			}
			return [
				new WebhookEndpointCreated({
					url: cmd.url,
					description: cmd.description,
					event_types: cmd.event_types,
					secret_salt: cmd.secret_salt,
				}),
			]
		},
		UpdateWebhookEndpoint: (state, cmd, ctx) => {
			if (state.status === "") {
				return new WebhookNotFound({ webhook_id: ctx.id })
			}
			if (state.status === "deleted") {
				return new WebhookDeletedError({ webhook_id: ctx.id })
			}
			if (!cmd.url.startsWith("https://")) {
				return new WebhookInvalidUrl({ url: cmd.url })
			}
			return [
				new WebhookEndpointUpdated({
					url: cmd.url,
					description: cmd.description,
					event_types: cmd.event_types,
					reactivated: cmd.reactivate,
				}),
			]
		},
		PauseWebhookEndpoint: (state, _cmd, ctx) => {
			if (state.status === "") {
				return new WebhookNotFound({ webhook_id: ctx.id })
			}
			if (state.status === "deleted") {
				return new WebhookDeletedError({ webhook_id: ctx.id })
			}
			if (state.status === "paused") {
				return []
			}
			return [new WebhookEndpointPaused()]
		},
		ResumeWebhookEndpoint: (state, _cmd, ctx) => {
			if (state.status === "") {
				return new WebhookNotFound({ webhook_id: ctx.id })
			}
			if (state.status === "deleted") {
				return new WebhookDeletedError({ webhook_id: ctx.id })
			}
			if (state.status === "active") {
				return []
			}
			return [new WebhookEndpointResumed()]
		},
		RotateWebhookSecret: (state, cmd, ctx) => {
			if (state.status === "") {
				return new WebhookNotFound({ webhook_id: ctx.id })
			}
			if (state.status === "deleted") {
				return new WebhookDeletedError({ webhook_id: ctx.id })
			}
			return [
				new WebhookSecretRotated({
					secret_revision: state.secret_revision + 1,
					secret_salt: cmd.next_secret_salt,
					previous_secret_revision: state.secret_revision,
					previous_secret_salt: state.secret_salt,
					previous_secret_expires_at: cmd.grace_until,
				}),
			]
		},
		ExpirePreviousWebhookSecret: (state, cmd) => {
			if (
				state.status === "" ||
				state.status === "deleted" ||
				state.previous_secret_revision === 0 ||
				cmd.for_revision !== state.secret_revision
			) {
				return []
			}
			return [
				new WebhookPreviousSecretExpired({
					expired_revision: state.previous_secret_revision,
				}),
			]
		},
		RecordWebhookOutcome: (state, cmd) => {
			if (state.status !== "active" || cmd.definition_revision !== state.definition_revision) {
				return []
			}
			if (cmd.outcome === "redirect") {
				const existingStart =
					state.failure_window_started_at === 0 ? cmd.observed_at : state.failure_window_started_at
				const effectiveStart = cmd.observed_at < existingStart ? cmd.observed_at : existingStart
				const latest =
					state.failure_window_started_at === 0
						? cmd.observed_at
						: cmd.observed_at > state.last_failure_at
							? cmd.observed_at
							: state.last_failure_at
				return [
					new WebhookDisabledByHealth({
						reason: "redirect",
						window_started_at: effectiveStart,
						last_failure_at: latest,
					}),
				]
			}
			if (cmd.outcome === "delivered") {
				if (state.failure_window_started_at === 0) {
					return []
				}
				if (cmd.observed_at < state.last_failure_at) {
					return [
						new WebhookHealthReanchored({
							window_started_at: state.last_failure_at,
							last_failure_at: state.last_failure_at,
						}),
					]
				}
				return [new WebhookHealthCleared()]
			}
			const existingStart =
				state.failure_window_started_at === 0 ? cmd.observed_at : state.failure_window_started_at
			const effectiveStart = cmd.observed_at < existingStart ? cmd.observed_at : existingStart
			const latest =
				state.failure_window_started_at === 0
					? cmd.observed_at
					: cmd.observed_at > state.last_failure_at
						? cmd.observed_at
						: state.last_failure_at
			if (latest - effectiveStart >= SUSTAINED_FAILURE_DISABLE_WINDOW_MS) {
				return [
					new WebhookDisabledByHealth({
						reason: "sustained_failure",
						window_started_at: effectiveStart,
						last_failure_at: latest,
					}),
				]
			}
			return [
				new WebhookHealthDegraded({
					window_started_at: effectiveStart,
					last_failure_at: latest,
				}),
			]
		},
		DeleteWebhookEndpoint: (state, _cmd, ctx) => {
			if (state.status === "") {
				return new WebhookNotFound({ webhook_id: ctx.id })
			}
			if (state.status === "deleted") {
				return []
			}
			return [new WebhookEndpointDeleted()]
		},
		ClaimWebhookIdempotencyKey: (state, cmd, ctx) => {
			if (state.status === "") {
				return new WebhookNotFound({ webhook_id: ctx.id })
			}
			if (state.status === "deleted") {
				return new WebhookDeletedError({ webhook_id: ctx.id })
			}
			return [new WebhookIdempotencyKeyClaimed({ fingerprint: cmd.fingerprint })]
		},
	},
	evolve: {
		"webhook.created": (state, e, envelope) =>
			state.status === ""
				? {
						...state,
						status: "active",
						url: e.url,
						description: e.description,
						event_types: e.event_types,
						definition_revision: 1,
						secret_revision: 1,
						secret_salt: e.secret_salt,
						created_at: DateTime.toEpochMillis(envelope.at),
						updated_at: DateTime.toEpochMillis(envelope.at),
					}
				: state,
		"webhook.updated": (state, e, envelope) =>
			state.status !== "" && state.status !== "deleted"
				? {
						...state,
						url: e.url,
						description: e.description,
						event_types: e.event_types,
						status: e.reactivated ? "active" : state.status,
						definition_revision: state.definition_revision + 1,
						...CLEAR_HEALTH,
						updated_at: DateTime.toEpochMillis(envelope.at),
					}
				: state,
		"webhook.paused": (state, _e, envelope) =>
			state.status !== "" && state.status !== "deleted"
				? {
						...state,
						status: "paused",
						updated_at: DateTime.toEpochMillis(envelope.at),
					}
				: state,
		"webhook.resumed": (state, _e, envelope) =>
			state.status !== "" && state.status !== "deleted"
				? {
						...state,
						status: "active",
						definition_revision: state.definition_revision + 1,
						...CLEAR_HEALTH,
						updated_at: DateTime.toEpochMillis(envelope.at),
					}
				: state,
		"webhook.secret_rotated": (state, e, envelope) =>
			state.status !== "" && state.status !== "deleted"
				? {
						...state,
						secret_revision: e.secret_revision,
						secret_salt: e.secret_salt,
						previous_secret_revision: e.previous_secret_revision,
						previous_secret_salt: e.previous_secret_salt,
						previous_secret_expires_at: e.previous_secret_expires_at,
						updated_at: DateTime.toEpochMillis(envelope.at),
					}
				: state,
		"webhook.previous_secret_expired": (state, _e, envelope) =>
			state.status !== "" && state.status !== "deleted"
				? {
						...state,
						previous_secret_revision: 0,
						previous_secret_salt: "",
						previous_secret_expires_at: 0,
						updated_at: DateTime.toEpochMillis(envelope.at),
					}
				: state,
		"webhook.health_cleared": (state, _e, envelope) =>
			state.status === "active"
				? {
						...state,
						...CLEAR_HEALTH,
						updated_at: DateTime.toEpochMillis(envelope.at),
					}
				: state,
		"webhook.health_reanchored": (state, e, envelope) =>
			state.status === "active"
				? {
						...state,
						failure_window_started_at: e.window_started_at,
						last_failure_at:
							e.last_failure_at >= e.window_started_at ? e.last_failure_at : e.window_started_at,
						consecutive_failures: 0,
						updated_at: DateTime.toEpochMillis(envelope.at),
					}
				: state,
		"webhook.health_degraded": (state, e, envelope) =>
			state.status === "active"
				? {
						...state,
						failure_window_started_at: e.window_started_at,
						last_failure_at:
							e.last_failure_at >= e.window_started_at ? e.last_failure_at : e.window_started_at,
						consecutive_failures: state.consecutive_failures + 1,
						updated_at: DateTime.toEpochMillis(envelope.at),
					}
				: state,
		"webhook.disabled_by_health": (state, e, envelope) =>
			state.status === "active"
				? {
						...state,
						status: e.reason === "redirect" ? "disabled_redirect" : "disabled_sustained_failure",
						failure_window_started_at: e.window_started_at,
						last_failure_at:
							e.last_failure_at >= e.window_started_at ? e.last_failure_at : e.window_started_at,
						consecutive_failures: state.consecutive_failures + 1,
						updated_at: DateTime.toEpochMillis(envelope.at),
					}
				: state,
		"webhook.deleted": (state, _e, envelope) =>
			state.status !== ""
				? {
						...state,
						status: "deleted",
						secret_salt: "",
						previous_secret_revision: 0,
						previous_secret_salt: "",
						previous_secret_expires_at: 0,
						updated_at: DateTime.toEpochMillis(envelope.at),
					}
				: state,
		"webhook.idempotency_key_claimed": (state) => state,
	},
}) {}
