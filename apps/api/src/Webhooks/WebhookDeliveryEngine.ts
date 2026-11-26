import type { WebhookEndpointState } from "@checkfu/domain/Webhook/WebhookEndpoint.aggregate"
import type { WebhookOutcomeKind } from "@checkfu/domain/Webhook/WebhookTypes"
import { parsePublicHttpsWebhookUrl } from "@checkfu/domain/Webhook/WebhookUrl"
import {
	WebhookDeliveryId,
	WebhookDeliveryOutcome,
	WebhookDeliveryStatus,
	WebhookEventId,
} from "@checkfu/sdk/Schemas"
import type { WebhookId } from "@checkfu/sdk/Schemas"
import * as Clock from "effect/Clock"
import type * as Mac from "effect/crypto/Mac"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type {
	EnqueueWebhookDeliveryInput,
	ListWebhookDeliveriesPage,
	ListWebhookDeliveriesQuery,
	WebhookDeliveryRecord,
} from "./WebhookDeliveryStore.ts"
import { signingIdForDelivery } from "./WebhookDeliveryStore.ts"
import {
	STANDARD_WEBHOOK_HEADERS,
	deriveWebhookSigningSecret,
	signStandardWebhook,
} from "./WebhookSigning.ts"

export const WEBHOOK_MAX_ATTEMPTS = 6
export const WEBHOOK_RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000, 14_400_000] as const
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000
export const WEBHOOK_MAX_STORED_DELIVERIES = 500
export const WEBHOOK_MAX_PENDING_DELIVERIES = 1000
export const WEBHOOK_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
export const WEBHOOK_MAX_ERROR_LENGTH = 512
export const WEBHOOK_BATCH_PER_ALARM = 25
export const WEBHOOK_USER_AGENT = "Checkfu-Webhooks/1.0"

export const WEBHOOK_DELIVERIES_TABLE =
	"CREATE TABLE IF NOT EXISTS webhook_deliveries (" +
	"delivery_id TEXT PRIMARY KEY, " +
	"event_id TEXT NOT NULL, " +
	"event_type TEXT NOT NULL, " +
	"dedupe_key TEXT NOT NULL UNIQUE, " +
	"payload_json TEXT NOT NULL, " +
	"status TEXT NOT NULL, " +
	"attempt_count INTEGER NOT NULL DEFAULT 0, " +
	"max_attempts INTEGER NOT NULL DEFAULT 6, " +
	"next_attempt_at INTEGER, " +
	"last_attempt_at INTEGER, " +
	"last_http_status INTEGER, " +
	"last_outcome TEXT, " +
	"last_error TEXT, " +
	"created_at INTEGER NOT NULL, " +
	"updated_at INTEGER NOT NULL, " +
	"completed_at INTEGER" +
	")"

export const WEBHOOK_HEALTH_OUTCOMES_TABLE =
	"CREATE TABLE IF NOT EXISTS webhook_health_outcomes (" +
	"outcome_id TEXT PRIMARY KEY, " +
	"definition_revision INTEGER NOT NULL, " +
	"outcome TEXT NOT NULL, " +
	"observed_at INTEGER NOT NULL, " +
	"created_at INTEGER NOT NULL" +
	")"

const WEBHOOK_DELIVERIES_DUE_INDEX =
	"CREATE INDEX IF NOT EXISTS webhook_deliveries_due " +
	"ON webhook_deliveries (next_attempt_at, created_at) " +
	"WHERE status = 'pending' AND next_attempt_at IS NOT NULL"

const WEBHOOK_DELIVERIES_RECENT_INDEX =
	"CREATE INDEX IF NOT EXISTS webhook_deliveries_recent " +
	"ON webhook_deliveries (created_at DESC, delivery_id DESC)"

const WEBHOOK_HEALTH_OUTCOMES_ORDER_INDEX =
	"CREATE INDEX IF NOT EXISTS webhook_health_outcomes_order " +
	"ON webhook_health_outcomes (created_at ASC, outcome_id ASC)"

export type WebhookSqlBinding = string | number | null
export type WebhookSqlValue = string | number | bigint | ArrayBuffer | Uint8Array | null
export type WebhookSqlRow = Readonly<Record<string, WebhookSqlValue>>

export interface WebhookSqlCursor {
	toArray(): ReadonlyArray<WebhookSqlRow>
}

export interface WebhookSqlStorage {
	exec(query: string, ...bindings: ReadonlyArray<WebhookSqlBinding>): WebhookSqlCursor
	transaction?<A>(fn: () => A): A
}

export interface WebhookHttpRequest {
	readonly url: string
	readonly headers: Readonly<Record<string, string>>
	readonly body: string
	readonly timeoutMs: number
}

export type WebhookHttpResult =
	| { readonly kind: "response"; readonly status: number }
	| { readonly kind: "timeout" }
	| { readonly kind: "invalid_destination"; readonly message: string }
	| { readonly kind: "network_error"; readonly message: string }
	| { readonly kind: "egress_error"; readonly message: string }
	| { readonly kind: "egress_unconfigured"; readonly message: string }

export interface WebhookHttpSender {
	readonly send: (request: WebhookHttpRequest) => Effect.Effect<WebhookHttpResult>
}

const truncateError = (message: string): string =>
	message.length <= WEBHOOK_MAX_ERROR_LENGTH
		? message
		: `${message.slice(0, WEBHOOK_MAX_ERROR_LENGTH - 1)}…`

export const retryDelayMsForAttempt = (
	completedAttempts: number,
	jitterFraction = 0,
): number | null => {
	const base = WEBHOOK_RETRY_DELAYS_MS[completedAttempts - 1]
	if (base === undefined) {
		return null
	}
	const clampedJitter = Math.max(-0.1, Math.min(0.1, jitterFraction))
	return Math.max(1000, Math.round(base * (1 + clampedJitter)))
}

interface StoredRow {
	readonly delivery_id: string
	readonly event_id: string
	readonly event_type: string
	readonly dedupe_key: string
	readonly payload_json: string
	readonly status: WebhookDeliveryStatus
	readonly attempt_count: number
	readonly max_attempts: number
	readonly next_attempt_at: number | null
	readonly last_attempt_at: number | null
	readonly last_http_status: number | null
	readonly last_outcome: WebhookDeliveryOutcome | null
	readonly last_error: string | null
	readonly created_at: number
	readonly updated_at: number
	readonly completed_at: number | null
}

interface StoredHealthOutcome {
	readonly outcome_id: string
	readonly definition_revision: number
	readonly outcome: WebhookOutcomeKind
	readonly observed_at: number
	readonly created_at: number
}

const isDeliveryStatus = Schema.is(WebhookDeliveryStatus)
const isDeliveryOutcome = Schema.is(WebhookDeliveryOutcome)

const asString = (value: WebhookSqlValue | undefined): string =>
	typeof value === "string" ? value : String(value ?? "")
const asNumber = (value: WebhookSqlValue | undefined): number =>
	typeof value === "number" ? value : Number(value ?? 0)
const asNullableNumber = (value: WebhookSqlValue | undefined): number | null =>
	value === null || value === undefined ? null : asNumber(value)
const asNullableString = (value: WebhookSqlValue | undefined): string | null =>
	value === null || value === undefined ? null : asString(value)

const parseDeliveryStatus = (value: WebhookSqlValue | undefined): WebhookDeliveryStatus => {
	const raw = asString(value)
	if (isDeliveryStatus(raw)) {
		return raw
	}
	throw new Error(`Invalid stored webhook delivery status: ${raw}`)
}

const parseDeliveryOutcome = (
	value: WebhookSqlValue | undefined,
): WebhookDeliveryOutcome | null => {
	const raw = asNullableString(value)
	if (raw === null) {
		return null
	}
	if (isDeliveryOutcome(raw)) {
		return raw
	}
	throw new Error(`Invalid stored webhook delivery outcome: ${raw}`)
}

const parseHealthOutcomeKind = (value: WebhookSqlValue | undefined): WebhookOutcomeKind => {
	const raw = asString(value)
	if (raw === "delivered" || raw === "failed" || raw === "redirect") {
		return raw
	}
	throw new Error(`Invalid stored webhook health outcome: ${raw}`)
}

const rowFromRaw = (raw: WebhookSqlRow): StoredRow => ({
	delivery_id: asString(raw.delivery_id),
	event_id: asString(raw.event_id),
	event_type: asString(raw.event_type),
	dedupe_key: asString(raw.dedupe_key),
	payload_json: asString(raw.payload_json),
	status: parseDeliveryStatus(raw.status),
	attempt_count: asNumber(raw.attempt_count),
	max_attempts: asNumber(raw.max_attempts),
	next_attempt_at: asNullableNumber(raw.next_attempt_at),
	last_attempt_at: asNullableNumber(raw.last_attempt_at),
	last_http_status: asNullableNumber(raw.last_http_status),
	last_outcome: parseDeliveryOutcome(raw.last_outcome),
	last_error: asNullableString(raw.last_error),
	created_at: asNumber(raw.created_at),
	updated_at: asNumber(raw.updated_at),
	completed_at: asNullableNumber(raw.completed_at),
})

const healthOutcomeFromRaw = (raw: WebhookSqlRow): StoredHealthOutcome => ({
	outcome_id: asString(raw.outcome_id),
	definition_revision: asNumber(raw.definition_revision),
	outcome: parseHealthOutcomeKind(raw.outcome),
	observed_at: asNumber(raw.observed_at),
	created_at: asNumber(raw.created_at),
})

const toRecord = (webhookId: WebhookId, row: StoredRow): WebhookDeliveryRecord => ({
	id: WebhookDeliveryId.make(row.delivery_id),
	webhook_id: webhookId,
	event_id: WebhookEventId.make(row.event_id),
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

const formatCursor = (row: Pick<StoredRow, "created_at" | "delivery_id">): string =>
	`${row.created_at}:${row.delivery_id}`

const parseCursor = (
	cursor: string,
): { readonly created_at: number; readonly delivery_id: string } | null => {
	const colon = cursor.indexOf(":")
	if (colon <= 0) {
		return null
	}
	const createdAt = Number(cursor.slice(0, colon))
	const deliveryId = cursor.slice(colon + 1)
	if (!Number.isInteger(createdAt) || createdAt < 0 || deliveryId.length === 0) {
		return null
	}
	return { created_at: createdAt, delivery_id: deliveryId }
}

const SELECT_COLUMNS =
	"delivery_id, event_id, event_type, dedupe_key, payload_json, status, attempt_count, max_attempts, " +
	"next_attempt_at, last_attempt_at, last_http_status, last_outcome, last_error, created_at, updated_at, completed_at"

export interface RecordWebhookHealthOutcomeInput {
	readonly outcome_id: string
	readonly definition_revision: number
	readonly outcome: WebhookOutcomeKind
	readonly observed_at: number
}

export interface DrainWebhookDeliveriesDeps {
	readonly readEndpoint: Effect.Effect<WebhookEndpointState>
	readonly recordOutcome: (
		input: RecordWebhookHealthOutcomeInput,
	) => Effect.Effect<WebhookEndpointState>
	readonly mac: Mac.Mac["Service"]
	readonly masterKey: Effect.Effect<Mac.Key>
	readonly sender: WebhookHttpSender
	readonly jitterFraction?: Effect.Effect<number>
	readonly batchSize?: number
}

export interface DrainWebhookDeliveriesResult {
	readonly processed: number
	readonly purged: boolean
	readonly nextAlarmAt: number | null
}

export interface EnqueueWebhookResult {
	readonly record: WebhookDeliveryRecord
	readonly nextAlarmAt: number | null
}

interface ClassifiedHttpResult {
	readonly deliveryOutcome: WebhookDeliveryOutcome
	readonly healthOutcome: WebhookOutcomeKind | null
	readonly httpStatus: number | null
	readonly errorMessage: string | null
	readonly retryable: boolean
}

const classifyHttpResult = (result: WebhookHttpResult): ClassifiedHttpResult => {
	if (result.kind === "timeout") {
		return {
			deliveryOutcome: "timeout",
			healthOutcome: "failed",
			httpStatus: null,
			errorMessage: `Webhook request timed out after ${WEBHOOK_DELIVERY_TIMEOUT_MS}ms.`,
			retryable: true,
		}
	}
	if (result.kind === "invalid_destination") {
		return {
			deliveryOutcome: "invalid_destination",
			healthOutcome: "failed",
			httpStatus: null,
			errorMessage: truncateError(result.message),
			retryable: false,
		}
	}
	if (result.kind === "egress_unconfigured") {
		return {
			deliveryOutcome: "network_error",
			healthOutcome: null,
			httpStatus: null,
			errorMessage: truncateError(result.message),
			retryable: false,
		}
	}
	if (result.kind === "egress_error") {
		return {
			deliveryOutcome: "network_error",
			healthOutcome: null,
			httpStatus: null,
			errorMessage: truncateError(result.message),
			retryable: true,
		}
	}
	if (result.kind === "network_error") {
		return {
			deliveryOutcome: "network_error",
			healthOutcome: "failed",
			httpStatus: null,
			errorMessage: truncateError(result.message),
			retryable: true,
		}
	}
	const status = result.status
	if (status >= 200 && status < 300) {
		return {
			deliveryOutcome: "http_2xx",
			healthOutcome: "delivered",
			httpStatus: status,
			errorMessage: null,
			retryable: false,
		}
	}
	if (status >= 300 && status < 400) {
		return {
			deliveryOutcome: "http_redirect",
			healthOutcome: "redirect",
			httpStatus: status,
			errorMessage: `Webhook endpoint returned HTTP ${status} redirect; redirects are not followed.`,
			retryable: false,
		}
	}
	if (status >= 400 && status < 500) {
		return {
			deliveryOutcome: "http_4xx",
			healthOutcome: "failed",
			httpStatus: status,
			errorMessage: `Webhook endpoint returned HTTP ${status}.`,
			retryable: true,
		}
	}
	return {
		deliveryOutcome: "http_5xx",
		healthOutcome: "failed",
		httpStatus: status,
		errorMessage: `Webhook endpoint returned HTTP ${status}.`,
		retryable: true,
	}
}

const minTimestamp = (...values: ReadonlyArray<number | null>): number | null => {
	let min: number | null = null
	for (const value of values) {
		if (value !== null && (min === null || value < min)) {
			min = value
		}
	}
	return min
}

export class WebhookDeliveryEngine {
	readonly #webhookId: WebhookId
	readonly #sql: WebhookSqlStorage
	#initialized = false

	constructor(webhookId: WebhookId, sql: WebhookSqlStorage) {
		this.#webhookId = webhookId
		this.#sql = sql
	}

	ensureSchema(): void {
		this.#ensureSchema()
	}

	#ensureSchema(): void {
		if (this.#initialized) {
			return
		}
		this.#sql.exec(WEBHOOK_DELIVERIES_TABLE)
		this.#sql.exec(WEBHOOK_HEALTH_OUTCOMES_TABLE)
		this.#sql.exec(WEBHOOK_DELIVERIES_DUE_INDEX)
		this.#sql.exec(WEBHOOK_DELIVERIES_RECENT_INDEX)
		this.#sql.exec(WEBHOOK_HEALTH_OUTCOMES_ORDER_INDEX)
		this.#initialized = true
	}

	#transaction<A>(fn: () => A): A {
		const wasInitialized = this.#initialized
		try {
			return this.#sql.transaction === undefined ? fn() : this.#sql.transaction(fn)
		} catch (error) {
			this.#initialized = wasInitialized
			throw error
		}
	}

	nextAlarmAt(): number | null {
		this.#ensureSchema()
		const pendingHealthRow = this.#sql
			.exec("SELECT MIN(created_at) AS next_at FROM webhook_health_outcomes")
			.toArray()[0]
		const nextHealthAt =
			pendingHealthRow === undefined ? null : asNullableNumber(pendingHealthRow.next_at)

		const pendingDeliveryRow = this.#sql
			.exec(
				"SELECT MIN(next_attempt_at) AS next_at FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at IS NOT NULL",
			)
			.toArray()[0]
		const nextDeliveryAt =
			pendingDeliveryRow === undefined ? null : asNullableNumber(pendingDeliveryRow.next_at)

		const retainedRow = this.#sql
			.exec("SELECT MIN(created_at) AS oldest_at FROM webhook_deliveries WHERE status != 'pending'")
			.toArray()[0]
		const oldestTerminalAt =
			retainedRow === undefined ? null : asNullableNumber(retainedRow.oldest_at)
		const nextRetentionAt =
			oldestTerminalAt === null ? null : oldestTerminalAt + WEBHOOK_RETENTION_MS

		return minTimestamp(nextHealthAt, nextDeliveryAt, nextRetentionAt)
	}

	enqueue(input: EnqueueWebhookDeliveryInput, nowMillis: number): EnqueueWebhookResult {
		this.#ensureSchema()
		return this.#transaction(() => {
			const existing = this.#sql
				.exec(
					`SELECT ${SELECT_COLUMNS} FROM webhook_deliveries WHERE dedupe_key = ?`,
					input.dedupe_key,
				)
				.toArray()[0]
			if (existing !== undefined) {
				return {
					record: toRecord(this.#webhookId, rowFromRaw(existing)),
					nextAlarmAt: this.nextAlarmAt(),
				}
			}
			const pendingRow = this.#sql
				.exec("SELECT COUNT(*) AS count FROM webhook_deliveries WHERE status = 'pending'")
				.toArray()[0]
			const pendingCount = pendingRow === undefined ? 0 : asNumber(pendingRow.count)
			if (pendingCount >= WEBHOOK_MAX_PENDING_DELIVERIES) {
				throw new Error(
					`Webhook ${this.#webhookId} pending delivery queue is full (${WEBHOOK_MAX_PENDING_DELIVERIES}).`,
				)
			}
			this.#sql.exec(
				"INSERT INTO webhook_deliveries (" +
					"delivery_id, event_id, event_type, dedupe_key, payload_json, status, " +
					"attempt_count, max_attempts, next_attempt_at, created_at, updated_at" +
					") VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)",
				input.delivery_id,
				input.event_id,
				input.event_type,
				input.dedupe_key,
				input.payload_json,
				WEBHOOK_MAX_ATTEMPTS,
				nowMillis,
				nowMillis,
				nowMillis,
			)
			this.prune(nowMillis)
			const inserted = this.#sql
				.exec(
					`SELECT ${SELECT_COLUMNS} FROM webhook_deliveries WHERE delivery_id = ?`,
					input.delivery_id,
				)
				.toArray()[0]
			if (inserted === undefined) {
				throw new Error(`Failed to read inserted delivery ${input.delivery_id}.`)
			}
			return {
				record: toRecord(this.#webhookId, rowFromRaw(inserted)),
				nextAlarmAt: this.nextAlarmAt(),
			}
		})
	}

	getDelivery(deliveryId: WebhookDeliveryId, nowMillis?: number): WebhookDeliveryRecord | null {
		this.#ensureSchema()
		if (nowMillis !== undefined) {
			this.prune(nowMillis)
		}
		const row = this.#sql
			.exec(`SELECT ${SELECT_COLUMNS} FROM webhook_deliveries WHERE delivery_id = ?`, deliveryId)
			.toArray()[0]
		return row === undefined ? null : toRecord(this.#webhookId, rowFromRaw(row))
	}

	listDeliveries(query: ListWebhookDeliveriesQuery, nowMillis?: number): ListWebhookDeliveriesPage {
		this.#ensureSchema()
		if (nowMillis !== undefined) {
			this.prune(nowMillis)
		}
		const limit = Math.max(1, Math.min(100, query.limit ?? 50))
		const cursor = query.page === undefined ? null : parseCursor(query.page)
		const rawRows =
			cursor === null
				? this.#sql
						.exec(
							`SELECT ${SELECT_COLUMNS} FROM webhook_deliveries ORDER BY created_at DESC, delivery_id DESC LIMIT ?`,
							limit + 1,
						)
						.toArray()
				: this.#sql
						.exec(
							`SELECT ${SELECT_COLUMNS} FROM webhook_deliveries ` +
								"WHERE (created_at < ? OR (created_at = ? AND delivery_id < ?)) " +
								"ORDER BY created_at DESC, delivery_id DESC LIMIT ?",
							cursor.created_at,
							cursor.created_at,
							cursor.delivery_id,
							limit + 1,
						)
						.toArray()
		const rows = rawRows.map(rowFromRaw)
		const page = rows.slice(0, limit)
		const hasMore = rows.length > limit
		const last = page.at(-1)
		return {
			data: page.map((row) => toRecord(this.#webhookId, row)),
			next_page: hasMore && last !== undefined ? formatCursor(last) : null,
		}
	}

	redeliver(
		deliveryId: WebhookDeliveryId,
		newDeliveryId: WebhookDeliveryId,
		nowMillis: number,
	): EnqueueWebhookResult | null {
		this.#ensureSchema()
		this.prune(nowMillis)
		const originalRaw = this.#sql
			.exec(`SELECT ${SELECT_COLUMNS} FROM webhook_deliveries WHERE delivery_id = ?`, deliveryId)
			.toArray()[0]
		if (originalRaw === undefined) {
			return null
		}
		const original = rowFromRaw(originalRaw)
		return this.enqueue(
			{
				delivery_id: newDeliveryId,
				event_id: WebhookEventId.make(original.event_id),
				event_type: original.event_type,
				dedupe_key: `redeliver:${newDeliveryId}`,
				payload_json: original.payload_json,
			},
			nowMillis,
		)
	}

	purge(): void {
		this.#ensureSchema()
		this.#transaction(() => {
			this.#sql.exec("DELETE FROM webhook_deliveries")
			this.#sql.exec("DELETE FROM webhook_health_outcomes")
		})
	}

	prune(nowMillis: number): void {
		this.#ensureSchema()
		const cutoff = nowMillis - WEBHOOK_RETENTION_MS
		this.#sql.exec(
			"DELETE FROM webhook_deliveries WHERE status != 'pending' AND created_at <= ?",
			cutoff,
		)
		this.#sql.exec(
			"DELETE FROM webhook_deliveries WHERE status != 'pending' AND delivery_id IN (" +
				"SELECT delivery_id FROM webhook_deliveries " +
				"WHERE status != 'pending' " +
				"ORDER BY created_at DESC, delivery_id DESC " +
				"LIMIT -1 OFFSET ?" +
				")",
			WEBHOOK_MAX_STORED_DELIVERIES,
		)
	}

	pendingHealthOutcomesCount(): number {
		this.#ensureSchema()
		const row = this.#sql.exec("SELECT COUNT(*) AS count FROM webhook_health_outcomes").toArray()[0]
		return row === undefined ? 0 : asNumber(row.count)
	}

	#recordPendingHealthOutcome(input: {
		readonly outcome_id: string
		readonly definition_revision: number
		readonly outcome: WebhookOutcomeKind
		readonly observed_at: number
		readonly created_at: number
	}): void {
		this.#sql.exec(
			"INSERT OR IGNORE INTO webhook_health_outcomes (" +
				"outcome_id, definition_revision, outcome, observed_at, created_at" +
				") VALUES (?, ?, ?, ?, ?)",
			input.outcome_id,
			input.definition_revision,
			input.outcome,
			input.observed_at,
			input.created_at,
		)
	}

	#listPendingHealthOutcomes(): ReadonlyArray<StoredHealthOutcome> {
		return this.#sql
			.exec(
				"SELECT outcome_id, definition_revision, outcome, observed_at, created_at " +
					"FROM webhook_health_outcomes ORDER BY created_at ASC, outcome_id ASC",
			)
			.toArray()
			.map(healthOutcomeFromRaw)
	}

	#deletePendingHealthOutcome(outcomeId: string): void {
		this.#sql.exec("DELETE FROM webhook_health_outcomes WHERE outcome_id = ?", outcomeId)
	}

	#skipAllPending(nowMillis: number, reason: string): void {
		this.#sql.exec(
			"UPDATE webhook_deliveries " +
				"SET status = 'skipped', next_attempt_at = NULL, completed_at = ?, updated_at = ?, last_error = ? " +
				"WHERE status = 'pending'",
			nowMillis,
			nowMillis,
			truncateError(reason),
		)
	}

	#flushHealthOutcomes(
		deps: DrainWebhookDeliveriesDeps,
		currentEndpoint: WebhookEndpointState,
	): Effect.Effect<WebhookEndpointState> {
		const self = this
		return Effect.gen(function* () {
			let endpoint = currentEndpoint
			const pending = self.#listPendingHealthOutcomes()
			for (const entry of pending) {
				endpoint = yield* deps.recordOutcome({
					outcome_id: entry.outcome_id,
					definition_revision: entry.definition_revision,
					outcome: entry.outcome,
					observed_at: entry.observed_at,
				})
				self.#deletePendingHealthOutcome(entry.outcome_id)
			}
			return endpoint
		})
	}

	#deriveSecretsForAttempt(
		deps: DrainWebhookDeliveriesDeps,
		masterKey: Mac.Key,
		endpoint: WebhookEndpointState,
		attemptAt: number,
	): Effect.Effect<ReadonlyArray<string>> {
		const self = this
		return Effect.gen(function* () {
			const secrets: Array<string> = [
				yield* deriveWebhookSigningSecret(deps.mac, masterKey, {
					webhookId: self.#webhookId,
					secretRevision: endpoint.secret_revision,
					secretSalt: endpoint.secret_salt,
				}),
			]
			if (
				endpoint.previous_secret_revision > 0 &&
				endpoint.previous_secret_salt.length > 0 &&
				endpoint.previous_secret_expires_at > attemptAt
			) {
				secrets.push(
					yield* deriveWebhookSigningSecret(deps.mac, masterKey, {
						webhookId: self.#webhookId,
						secretRevision: endpoint.previous_secret_revision,
						secretSalt: endpoint.previous_secret_salt,
					}),
				)
			}
			return secrets
		})
	}

	drainDue(deps: DrainWebhookDeliveriesDeps): Effect.Effect<DrainWebhookDeliveriesResult> {
		const self = this
		return Effect.gen(function* () {
			self.#ensureSchema()
			const nowMillis = yield* Clock.currentTimeMillis
			let endpoint = yield* deps.readEndpoint
			if (endpoint.status === "" || endpoint.status === "deleted") {
				self.purge()
				return { processed: 0, purged: true, nextAlarmAt: null }
			}

			endpoint = yield* self.#flushHealthOutcomes(deps, endpoint)
			if (endpoint.status === "" || endpoint.status === "deleted") {
				self.purge()
				return { processed: 0, purged: true, nextAlarmAt: null }
			}
			if (endpoint.status !== "active") {
				self.#skipAllPending(nowMillis, `Webhook endpoint is ${endpoint.status}.`)
				self.prune(nowMillis)
				return { processed: 0, purged: false, nextAlarmAt: self.nextAlarmAt() }
			}

			const batchSize = deps.batchSize ?? WEBHOOK_BATCH_PER_ALARM
			const dueRows = self.#sql
				.exec(
					`SELECT ${SELECT_COLUMNS} FROM webhook_deliveries ` +
						"WHERE status = 'pending' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? " +
						"ORDER BY next_attempt_at ASC, created_at ASC LIMIT ?",
					nowMillis,
					batchSize,
				)
				.toArray()
				.map(rowFromRaw)
			if (dueRows.length === 0) {
				self.prune(nowMillis)
				return { processed: 0, purged: false, nextAlarmAt: self.nextAlarmAt() }
			}

			let cachedMasterKey: Mac.Key | undefined
			let processed = 0
			for (const [index, row] of dueRows.entries()) {
				if (index > 0) {
					endpoint = yield* deps.readEndpoint
					if (endpoint.status === "" || endpoint.status === "deleted") {
						self.purge()
						return { processed, purged: true, nextAlarmAt: null }
					}
					endpoint = yield* self.#flushHealthOutcomes(deps, endpoint)
					if (endpoint.status === "" || endpoint.status === "deleted") {
						self.purge()
						return { processed, purged: true, nextAlarmAt: null }
					}
				}

				const attemptAt = yield* Clock.currentTimeMillis
				if (endpoint.status !== "active") {
					self.#skipAllPending(attemptAt, `Webhook endpoint is ${endpoint.status}.`)
					break
				}

				const attemptRevision = endpoint.definition_revision
				const nextAttemptCount = row.attempt_count + 1
				const outcomeId = `${row.delivery_id}:${nextAttemptCount}`
				const validatedUrl = parsePublicHttpsWebhookUrl(endpoint.url)
				if (validatedUrl === null) {
					processed += 1
					self.#transaction(() => {
						self.#sql.exec(
							"UPDATE webhook_deliveries " +
								"SET status = 'failed', attempt_count = ?, next_attempt_at = NULL, " +
								"last_attempt_at = ?, last_outcome = 'invalid_destination', last_error = ?, " +
								"updated_at = ?, completed_at = ? WHERE delivery_id = ?",
							nextAttemptCount,
							attemptAt,
							"Webhook destination URL is not a permitted public HTTPS address.",
							attemptAt,
							attemptAt,
							row.delivery_id,
						)
						self.#recordPendingHealthOutcome({
							outcome_id: outcomeId,
							definition_revision: attemptRevision,
							outcome: "failed",
							observed_at: attemptAt,
							created_at: attemptAt,
						})
					})
					endpoint = yield* self.#flushHealthOutcomes(deps, endpoint)
					if (endpoint.status === "" || endpoint.status === "deleted") {
						self.purge()
						return { processed, purged: true, nextAlarmAt: null }
					}
					if (endpoint.status !== "active") {
						self.#skipAllPending(attemptAt, `Webhook endpoint is ${endpoint.status}.`)
						break
					}
					continue
				}

				cachedMasterKey ??= yield* deps.masterKey
				const secrets = yield* self.#deriveSecretsForAttempt(
					deps,
					cachedMasterKey,
					endpoint,
					attemptAt,
				)
				const timestampSeconds = Math.floor(attemptAt / 1000)
				const webhookId = signingIdForDelivery(row)
				const signature = yield* signStandardWebhook(deps.mac, {
					secrets,
					webhookId,
					timestampSeconds,
					payload: row.payload_json,
				})
				const httpResult = yield* deps.sender.send({
					url: validatedUrl,
					headers: {
						"user-agent": WEBHOOK_USER_AGENT,
						[STANDARD_WEBHOOK_HEADERS.id]: webhookId,
						[STANDARD_WEBHOOK_HEADERS.timestamp]: String(timestampSeconds),
						[STANDARD_WEBHOOK_HEADERS.signature]: signature,
					},
					body: row.payload_json,
					timeoutMs: WEBHOOK_DELIVERY_TIMEOUT_MS,
				})
				processed += 1
				const finishedAt = yield* Clock.currentTimeMillis
				const classified = classifyHttpResult(httpResult)

				if (classified.healthOutcome === "delivered") {
					const shouldClearHealth = endpoint.failure_window_started_at !== 0
					self.#transaction(() => {
						self.#sql.exec(
							"UPDATE webhook_deliveries " +
								"SET status = 'succeeded', attempt_count = ?, next_attempt_at = NULL, " +
								"last_attempt_at = ?, last_http_status = ?, last_outcome = ?, last_error = NULL, " +
								"updated_at = ?, completed_at = ? WHERE delivery_id = ?",
							nextAttemptCount,
							finishedAt,
							classified.httpStatus,
							classified.deliveryOutcome,
							finishedAt,
							finishedAt,
							row.delivery_id,
						)
						if (shouldClearHealth) {
							self.#recordPendingHealthOutcome({
								outcome_id: outcomeId,
								definition_revision: attemptRevision,
								outcome: "delivered",
								observed_at: finishedAt,
								created_at: finishedAt,
							})
						}
					})
					if (shouldClearHealth) {
						endpoint = yield* self.#flushHealthOutcomes(deps, endpoint)
						if (endpoint.status === "" || endpoint.status === "deleted") {
							self.purge()
							return { processed, purged: true, nextAlarmAt: null }
						}
						if (endpoint.status !== "active") {
							self.#skipAllPending(finishedAt, `Webhook endpoint is ${endpoint.status}.`)
							break
						}
					}
					continue
				}

				if (classified.healthOutcome === "redirect") {
					self.#transaction(() => {
						self.#sql.exec(
							"UPDATE webhook_deliveries " +
								"SET status = 'failed', attempt_count = ?, next_attempt_at = NULL, " +
								"last_attempt_at = ?, last_http_status = ?, last_outcome = ?, last_error = ?, " +
								"updated_at = ?, completed_at = ? WHERE delivery_id = ?",
							nextAttemptCount,
							finishedAt,
							classified.httpStatus,
							classified.deliveryOutcome,
							classified.errorMessage,
							finishedAt,
							finishedAt,
							row.delivery_id,
						)
						self.#recordPendingHealthOutcome({
							outcome_id: outcomeId,
							definition_revision: attemptRevision,
							outcome: "redirect",
							observed_at: finishedAt,
							created_at: finishedAt,
						})
					})
					endpoint = yield* self.#flushHealthOutcomes(deps, endpoint)
					if (endpoint.status === "" || endpoint.status === "deleted") {
						self.purge()
						return { processed, purged: true, nextAlarmAt: null }
					}
					if (endpoint.status !== "active") {
						self.#skipAllPending(finishedAt, `Webhook endpoint is ${endpoint.status}.`)
						break
					}
					continue
				}

				const jitter = deps.jitterFraction === undefined ? 0 : yield* deps.jitterFraction
				const delay =
					classified.retryable && nextAttemptCount < row.max_attempts
						? retryDelayMsForAttempt(nextAttemptCount, jitter)
						: null

				self.#transaction(() => {
					if (delay !== null) {
						self.#sql.exec(
							"UPDATE webhook_deliveries " +
								"SET status = 'pending', attempt_count = ?, next_attempt_at = ?, " +
								"last_attempt_at = ?, last_http_status = ?, last_outcome = ?, last_error = ?, " +
								"updated_at = ? WHERE delivery_id = ?",
							nextAttemptCount,
							finishedAt + delay,
							finishedAt,
							classified.httpStatus,
							classified.deliveryOutcome,
							classified.errorMessage,
							finishedAt,
							row.delivery_id,
						)
					} else {
						self.#sql.exec(
							"UPDATE webhook_deliveries " +
								"SET status = 'failed', attempt_count = ?, next_attempt_at = NULL, " +
								"last_attempt_at = ?, last_http_status = ?, last_outcome = ?, last_error = ?, " +
								"updated_at = ?, completed_at = ? WHERE delivery_id = ?",
							nextAttemptCount,
							finishedAt,
							classified.httpStatus,
							classified.deliveryOutcome,
							classified.errorMessage,
							finishedAt,
							finishedAt,
							row.delivery_id,
						)
					}
					if (classified.healthOutcome !== null) {
						self.#recordPendingHealthOutcome({
							outcome_id: outcomeId,
							definition_revision: attemptRevision,
							outcome: classified.healthOutcome,
							observed_at: finishedAt,
							created_at: finishedAt,
						})
					}
				})
				if (classified.healthOutcome !== null) {
					endpoint = yield* self.#flushHealthOutcomes(deps, endpoint)
					if (endpoint.status === "" || endpoint.status === "deleted") {
						self.purge()
						return { processed, purged: true, nextAlarmAt: null }
					}
					if (endpoint.status !== "active") {
						self.#skipAllPending(finishedAt, `Webhook endpoint is ${endpoint.status}.`)
						break
					}
				}
			}

			const doneAt = yield* Clock.currentTimeMillis
			self.prune(doneAt)
			return {
				processed,
				purged: false,
				nextAlarmAt: self.nextAlarmAt(),
			}
		})
	}
}
