import { RecordWebhookOutcome } from "@checkfu/domain/Webhook/RecordWebhookOutcome.command"
import { WebhookEndpoint } from "@checkfu/domain/Webhook/WebhookEndpoint.aggregate"
import type { WebhookEndpointState } from "@checkfu/domain/Webhook/WebhookEndpoint.aggregate"
import { parsePublicHttpsWebhookUrl } from "@checkfu/domain/Webhook/WebhookUrl"
import { WebhookId } from "@checkfu/sdk/Schemas"
import type {
	WebhookDeliveryId,
	WebhookDeliveryOutcome,
	WebhookDeliveryStatus,
	WebhookEventId,
} from "@checkfu/sdk/Schemas"
import * as Clock from "effect/Clock"
import * as Mac from "effect/crypto/Mac"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
	STANDARD_WEBHOOK_HEADERS,
	WebhookSigningMasterKey,
	deriveWebhookSigningSecret,
	signStandardWebhook,
} from "./WebhookSigning.ts"
import {
	WEBHOOK_DELIVERY_TIMEOUT_MS,
	WEBHOOK_MAX_ATTEMPTS,
	WEBHOOK_MAX_ERROR_LENGTH,
	WEBHOOK_MAX_STORED_DELIVERIES,
	WEBHOOK_RETENTION_MS,
	WEBHOOK_USER_AGENT,
	retryDelayMsForAttempt,
} from "./WebhookDeliveryEngine.ts"
import type {
	WebhookHttpRequest,
	WebhookHttpResult,
	WebhookHttpSender,
} from "./WebhookDeliveryEngine.ts"
import { WebhookDeliveryStore } from "./WebhookDeliveryStore.ts"
import type {
	EnqueueWebhookDeliveryInput,
	ListWebhookDeliveriesPage,
	ListWebhookDeliveriesQuery,
	WebhookDeliveryRecord,
} from "./WebhookDeliveryStore.ts"

interface MemoryDeliveryRow {
	delivery_id: WebhookDeliveryId
	webhook_id: WebhookId
	event_id: WebhookEventId
	event_type: string
	dedupe_key: string
	payload_json: string
	status: WebhookDeliveryStatus
	attempt_count: number
	max_attempts: number
	next_attempt_at: number | null
	last_attempt_at: number | null
	last_http_status: number | null
	last_outcome: WebhookDeliveryOutcome | null
	last_error: string | null
	created_at: number
	updated_at: number
	completed_at: number | null
}

const toRecord = (row: MemoryDeliveryRow): WebhookDeliveryRecord => ({
	id: row.delivery_id,
	webhook_id: row.webhook_id,
	event_id: row.event_id,
	event_type: row.event_type,
	status: row.status,
	attempt_count: row.attempt_count,
	max_attempts: row.max_attempts,
	next_attempt_at: row.next_attempt_at,
	last_attempt_at: row.last_attempt_at,
	last_http_status: row.last_http_status,
	last_outcome: row.last_outcome,
	last_error: row.last_error,
	created_at: row.created_at,
	updated_at: row.updated_at,
	completed_at: row.completed_at,
})

const truncate = (text: string): string =>
	text.length <= WEBHOOK_MAX_ERROR_LENGTH ? text : `${text.slice(0, WEBHOOK_MAX_ERROR_LENGTH - 1)}…`

const parseCursor = (
	cursor: string,
): { readonly created_at: number; readonly delivery_id: string } | null => {
	const split = cursor.indexOf(":")
	if (split <= 0) {
		return null
	}
	const createdAt = Number(cursor.slice(0, split))
	const deliveryId = cursor.slice(split + 1)
	return Number.isInteger(createdAt) && createdAt >= 0 && deliveryId.length > 0
		? { created_at: createdAt, delivery_id: deliveryId }
		: null
}

export interface MemoryWebhookDeliveryOptions {
	readonly sender?: WebhookHttpSender
	readonly autoDrain?: boolean
}

export const makeWebhookDeliveryStoreMemory = (options: MemoryWebhookDeliveryOptions = {}) => {
	const byWebhook = new Map<string, Array<MemoryDeliveryRow>>()
	const sentRequests: Array<WebhookHttpRequest> = []
	let activeSender: WebhookHttpSender = options.sender ?? {
		send: () => Effect.succeed<WebhookHttpResult>({ kind: "response", status: 200 }),
	}
	const autoDrain = options.autoDrain ?? true

	const bucketOf = (webhookId: WebhookId): Array<MemoryDeliveryRow> => {
		let rows = byWebhook.get(webhookId)
		if (rows === undefined) {
			rows = []
			byWebhook.set(webhookId, rows)
		}
		return rows
	}

	const prune = (webhookId: WebhookId, nowMillis: number): void => {
		const rows = byWebhook.get(webhookId)
		if (rows === undefined) {
			return
		}
		const cutoff = nowMillis - WEBHOOK_RETENTION_MS
		const kept = rows.filter((row) => row.status === "pending" || row.created_at >= cutoff)
		kept.sort((a, b) => {
			const pendingOrder = (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1)
			if (pendingOrder !== 0) {
				return pendingOrder
			}
			return b.created_at - a.created_at || (b.delivery_id > a.delivery_id ? 1 : -1)
		})
		byWebhook.set(webhookId, kept.slice(0, WEBHOOK_MAX_STORED_DELIVERIES))
	}

	const skipAllPending = (webhookId: WebhookId, nowMillis: number, reason: string): void => {
		const rows = byWebhook.get(webhookId)
		if (rows === undefined) {
			return
		}
		for (const row of rows) {
			if (row.status === "pending") {
				row.status = "skipped"
				row.next_attempt_at = null
				row.completed_at = nowMillis
				row.updated_at = nowMillis
				row.last_error = truncate(reason)
			}
		}
	}

	const drainEndpoint = (
		webhookId: WebhookId,
		webhooks: WebhookEndpoint["Service"],
		mac: Mac.Mac["Service"],
		masterKeyService: WebhookSigningMasterKey["Service"],
	): Effect.Effect<number> =>
		Effect.gen(function* () {
			const nowMillis = yield* Clock.currentTimeMillis
			let endpoint: WebhookEndpointState = yield* webhooks.get(webhookId)
			if (endpoint.status === "" || endpoint.status === "deleted") {
				byWebhook.delete(webhookId)
				return 0
			}
			if (endpoint.status !== "active") {
				skipAllPending(webhookId, nowMillis, `Webhook endpoint is ${endpoint.status}.`)
				prune(webhookId, nowMillis)
				return 0
			}
			const rows = bucketOf(webhookId)
				.filter(
					(row) =>
						row.status === "pending" &&
						row.next_attempt_at !== null &&
						row.next_attempt_at <= nowMillis,
				)
				.sort(
					(a, b) =>
						(a.next_attempt_at ?? 0) - (b.next_attempt_at ?? 0) || a.created_at - b.created_at,
				)
			if (rows.length === 0) {
				prune(webhookId, nowMillis)
				return 0
			}
			const validatedUrl = parsePublicHttpsWebhookUrl(endpoint.url)
			if (validatedUrl === null) {
				for (const row of rows) {
					row.status = "failed"
					row.attempt_count += 1
					row.next_attempt_at = null
					row.last_attempt_at = nowMillis
					row.last_outcome = "invalid_destination"
					row.last_error = "Webhook destination URL is not a permitted public HTTPS address."
					row.updated_at = nowMillis
					row.completed_at = nowMillis
				}
				prune(webhookId, nowMillis)
				return rows.length
			}

			const masterKey = yield* masterKeyService.key
			const secrets: Array<string> = [
				yield* deriveWebhookSigningSecret(mac, masterKey, {
					webhookId,
					secretRevision: endpoint.secret_revision,
					secretSalt: endpoint.secret_salt,
				}),
			]
			if (
				endpoint.previous_secret_revision > 0 &&
				endpoint.previous_secret_salt.length > 0 &&
				endpoint.previous_secret_expires_at > nowMillis
			) {
				secrets.push(
					yield* deriveWebhookSigningSecret(mac, masterKey, {
						webhookId,
						secretRevision: endpoint.previous_secret_revision,
						secretSalt: endpoint.previous_secret_salt,
					}),
				)
			}

			let processed = 0
			for (const row of rows) {
				const attemptAt = yield* Clock.currentTimeMillis
				if (endpoint.status !== "active") {
					skipAllPending(webhookId, attemptAt, `Webhook endpoint is ${endpoint.status}.`)
					break
				}
				const timestampSeconds = Math.floor(attemptAt / 1000)
				const signature = yield* signStandardWebhook(mac, {
					secrets,
					webhookId: row.delivery_id,
					timestampSeconds,
					payload: row.payload_json,
				})
				const request: WebhookHttpRequest = {
					url: validatedUrl,
					headers: {
						"user-agent": WEBHOOK_USER_AGENT,
						[STANDARD_WEBHOOK_HEADERS.id]: row.delivery_id,
						[STANDARD_WEBHOOK_HEADERS.timestamp]: String(timestampSeconds),
						[STANDARD_WEBHOOK_HEADERS.signature]: signature,
					},
					body: row.payload_json,
					timeoutMs: WEBHOOK_DELIVERY_TIMEOUT_MS,
				}
				sentRequests.push(request)
				const result = yield* activeSender.send(request)
				processed += 1
				const finishedAt = yield* Clock.currentTimeMillis
				row.attempt_count += 1
				row.last_attempt_at = finishedAt
				row.updated_at = finishedAt

				if (result.kind === "response" && result.status >= 200 && result.status < 300) {
					row.status = "succeeded"
					row.next_attempt_at = null
					row.last_http_status = result.status
					row.last_outcome = "http_2xx"
					row.last_error = null
					row.completed_at = finishedAt
					if (endpoint.failure_window_started_at !== 0) {
						yield* webhooks.send(
							new RecordWebhookOutcome({
								webhook_id: webhookId,
								definition_revision: endpoint.definition_revision,
								outcome: "delivered",
								observed_at: finishedAt,
							}),
						)
						endpoint = yield* webhooks.get(webhookId)
					}
					continue
				}

				if (result.kind === "response" && result.status >= 300 && result.status < 400) {
					row.status = "failed"
					row.next_attempt_at = null
					row.last_http_status = result.status
					row.last_outcome = "http_redirect"
					row.last_error = `Webhook endpoint returned HTTP ${result.status} redirect; redirects are not followed.`
					row.completed_at = finishedAt
					yield* webhooks.send(
						new RecordWebhookOutcome({
							webhook_id: webhookId,
							definition_revision: endpoint.definition_revision,
							outcome: "redirect",
							observed_at: finishedAt,
						}),
					)
					endpoint = yield* webhooks.get(webhookId)
					if (endpoint.status !== "active") {
						skipAllPending(webhookId, finishedAt, `Webhook endpoint is ${endpoint.status}.`)
						break
					}
					continue
				}

				row.last_http_status = result.kind === "response" ? result.status : null
				row.last_outcome =
					result.kind === "timeout"
						? "timeout"
						: result.kind === "network_error"
							? "network_error"
							: result.status >= 400 && result.status < 500
								? "http_4xx"
								: "http_5xx"
				row.last_error =
					result.kind === "timeout"
						? `Webhook request timed out after ${WEBHOOK_DELIVERY_TIMEOUT_MS}ms.`
						: result.kind === "network_error"
							? truncate(result.message)
							: `Webhook endpoint returned HTTP ${result.status}.`
				const delay =
					row.attempt_count < row.max_attempts ? retryDelayMsForAttempt(row.attempt_count, 0) : null
				if (delay !== null) {
					row.status = "pending"
					row.next_attempt_at = finishedAt + delay
				} else {
					row.status = "failed"
					row.next_attempt_at = null
					row.completed_at = finishedAt
				}
				yield* webhooks.send(
					new RecordWebhookOutcome({
						webhook_id: webhookId,
						definition_revision: endpoint.definition_revision,
						outcome: "failed",
						observed_at: finishedAt,
					}),
				)
				endpoint = yield* webhooks.get(webhookId)
				if (endpoint.status !== "active") {
					skipAllPending(webhookId, finishedAt, `Webhook endpoint is ${endpoint.status}.`)
					break
				}
			}

			prune(webhookId, yield* Clock.currentTimeMillis)
			return processed
		})

	const enqueueImpl = (
		webhookId: WebhookId,
		input: EnqueueWebhookDeliveryInput,
		webhooks: WebhookEndpoint["Service"],
		mac: Mac.Mac["Service"],
		masterKeyService: WebhookSigningMasterKey["Service"],
	): Effect.Effect<WebhookDeliveryRecord> =>
		Effect.gen(function* () {
			const nowMillis = yield* Clock.currentTimeMillis
			const rows = bucketOf(webhookId)
			const existing = rows.find((row) => row.dedupe_key === input.dedupe_key)
			if (existing !== undefined) {
				return toRecord(existing)
			}
			const row: MemoryDeliveryRow = {
				delivery_id: input.delivery_id,
				webhook_id: webhookId,
				event_id: input.event_id,
				event_type: input.event_type,
				dedupe_key: input.dedupe_key,
				payload_json: input.payload_json,
				status: "pending",
				attempt_count: 0,
				max_attempts: WEBHOOK_MAX_ATTEMPTS,
				next_attempt_at: nowMillis,
				last_attempt_at: null,
				last_http_status: null,
				last_outcome: null,
				last_error: null,
				created_at: nowMillis,
				updated_at: nowMillis,
				completed_at: null,
			}
			rows.push(row)
			prune(webhookId, nowMillis)
			if (autoDrain) {
				yield* drainEndpoint(webhookId, webhooks, mac, masterKeyService)
			}
			const latest = bucketOf(webhookId).find((entry) => entry.delivery_id === input.delivery_id)
			return toRecord(latest ?? row)
		})

	const layer = Layer.effect(
		WebhookDeliveryStore,
		Effect.gen(function* () {
			const webhooks = yield* WebhookEndpoint
			const mac = yield* Mac.Mac
			const masterKeyService = yield* WebhookSigningMasterKey
			return {
				enqueue: (webhookId, input) =>
					enqueueImpl(webhookId, input, webhooks, mac, masterKeyService),
				listDeliveries: (webhookId, query: ListWebhookDeliveriesQuery) =>
					Effect.sync((): ListWebhookDeliveriesPage => {
						const limit = Math.max(1, Math.min(100, query.limit ?? 50))
						const cursor = query.after === undefined ? null : parseCursor(query.after)
						const sorted = [...(byWebhook.get(webhookId) ?? [])]
							.filter(
								(row) =>
									cursor === null ||
									row.created_at < cursor.created_at ||
									(row.created_at === cursor.created_at && row.delivery_id < cursor.delivery_id),
							)
							.sort(
								(a, b) =>
									b.created_at - a.created_at ||
									(b.delivery_id > a.delivery_id ? 1 : b.delivery_id < a.delivery_id ? -1 : 0),
							)
						const page = sorted.slice(0, limit)
						const hasMore = sorted.length > limit
						const last = page.at(-1)
						return {
							data: page.map(toRecord),
							has_more: hasMore,
							next_cursor:
								hasMore && last !== undefined ? `${last.created_at}:${last.delivery_id}` : null,
						}
					}),
				getDelivery: (webhookId, deliveryId) =>
					Effect.sync(() => {
						const found = (byWebhook.get(webhookId) ?? []).find(
							(row) => row.delivery_id === deliveryId,
						)
						return found === undefined ? null : toRecord(found)
					}),
				redeliver: (webhookId, deliveryId, newDeliveryId) =>
					Effect.gen(function* () {
						const original = (byWebhook.get(webhookId) ?? []).find(
							(row) => row.delivery_id === deliveryId,
						)
						if (original === undefined) {
							return null
						}
						return yield* enqueueImpl(
							webhookId,
							{
								delivery_id: newDeliveryId,
								event_id: original.event_id,
								event_type: original.event_type,
								dedupe_key: `redeliver:${newDeliveryId}`,
								payload_json: original.payload_json,
							},
							webhooks,
							mac,
							masterKeyService,
						)
					}),
				purge: (webhookId) =>
					Effect.sync(() => {
						byWebhook.delete(webhookId)
					}),
			}
		}),
	)

	return {
		layer,
		sentRequests,
		drain: (webhookId: WebhookId) =>
			Effect.gen(function* () {
				const webhooks = yield* WebhookEndpoint
				const mac = yield* Mac.Mac
				const masterKeyService = yield* WebhookSigningMasterKey
				return yield* drainEndpoint(webhookId, webhooks, mac, masterKeyService)
			}),
		drainAll: () =>
			Effect.gen(function* () {
				const webhooks = yield* WebhookEndpoint
				const mac = yield* Mac.Mac
				const masterKeyService = yield* WebhookSigningMasterKey
				let total = 0
				for (const id of Array.from(byWebhook.keys())) {
					total += yield* drainEndpoint(WebhookId.make(id), webhooks, mac, masterKeyService)
				}
				return total
			}),
		setSender: (sender: WebhookHttpSender) => {
			activeSender = sender
		},
		pendingCount: (webhookId?: WebhookId) => {
			if (webhookId !== undefined) {
				return (byWebhook.get(webhookId) ?? []).filter((row) => row.status === "pending").length
			}
			let total = 0
			for (const rows of byWebhook.values()) {
				total += rows.filter((row) => row.status === "pending").length
			}
			return total
		},
	}
}
