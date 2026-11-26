import { DatabaseSync } from "node:sqlite"
import { RecordWebhookOutcome } from "@checkfu/domain/Webhook/RecordWebhookOutcome.command"
import { WebhookEndpoint } from "@checkfu/domain/Webhook/WebhookEndpoint.aggregate"
import { WebhookId } from "@checkfu/sdk/Schemas"
import * as Clock from "effect/Clock"
import * as Mac from "effect/crypto/Mac"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { WebhookDeliveryEngine } from "./WebhookDeliveryEngine.ts"
import type {
	WebhookHttpRequest,
	WebhookHttpResult,
	WebhookHttpSender,
	WebhookSqlStorage,
} from "./WebhookDeliveryEngine.ts"
import { WebhookDeliveryStore, WebhookDeliveryStoreError } from "./WebhookDeliveryStore.ts"
import type { EnqueueWebhookDeliveryInput, WebhookDeliveryRecord } from "./WebhookDeliveryStore.ts"
import { WebhookSigningMasterKey } from "./WebhookSigning.ts"

const sqliteStorage = (db: DatabaseSync): WebhookSqlStorage => ({
	exec: (query, ...bindings) => {
		const stmt = db.prepare(query)
		const trimmed = query.trimStart().toUpperCase()
		if (trimmed.startsWith("SELECT")) {
			const rows = stmt.all(...bindings)
			return { toArray: () => rows }
		}
		stmt.run(...bindings)
		return { toArray: () => [] }
	},
	transaction: (fn) => {
		db.exec("BEGIN IMMEDIATE")
		try {
			const result = fn()
			db.exec("COMMIT")
			return result
		} catch (error) {
			db.exec("ROLLBACK")
			throw error
		}
	},
})

const storeError = (cause: unknown) => new WebhookDeliveryStoreError({ cause })

export interface MemoryWebhookDeliveryOptions {
	readonly sender?: WebhookHttpSender
	readonly autoDrain?: boolean
}

interface EndpointEngineEntry {
	readonly db: DatabaseSync
	readonly engine: WebhookDeliveryEngine
}

const pendingRowCount = (entry: EndpointEngineEntry): number => {
	const row = entry.db
		.prepare("SELECT COUNT(*) AS count FROM webhook_deliveries WHERE status = 'pending'")
		.get() as { readonly count?: number } | undefined
	return Number(row?.count ?? 0)
}

export const makeWebhookDeliveryStoreMemory = (options: MemoryWebhookDeliveryOptions = {}) => {
	const engines = new Map<string, EndpointEngineEntry>()
	const sentRequests: Array<WebhookHttpRequest> = []
	let activeSender: WebhookHttpSender = options.sender ?? {
		send: () => Effect.succeed<WebhookHttpResult>({ kind: "response", status: 200 }),
	}
	const autoDrain = options.autoDrain ?? true

	const entryFor = (webhookId: WebhookId): EndpointEngineEntry => {
		const existing = engines.get(webhookId)
		if (existing !== undefined) {
			return existing
		}
		const db = new DatabaseSync(":memory:")
		const engine = new WebhookDeliveryEngine(webhookId, sqliteStorage(db))
		const entry = { db, engine }
		engines.set(webhookId, entry)
		return entry
	}

	const recordingSender: WebhookHttpSender = {
		send: (request) =>
			Effect.suspend(() => {
				sentRequests.push(request)
				return activeSender.send(request)
			}),
	}

	const drainEndpoint = (
		webhookId: WebhookId,
		webhooks: WebhookEndpoint["Service"],
		mac: Mac.Mac["Service"],
		masterKeyService: WebhookSigningMasterKey["Service"],
	): Effect.Effect<number> =>
		Effect.gen(function* () {
			const entry = engines.get(webhookId)
			if (entry === undefined) {
				return 0
			}
			const result = yield* entry.engine.drainDue({
				readEndpoint: webhooks.get(webhookId),
				recordOutcome: (input) =>
					Effect.andThen(
						webhooks.send(
							new RecordWebhookOutcome({
								webhook_id: webhookId,
								definition_revision: input.definition_revision,
								outcome: input.outcome,
								observed_at: input.observed_at,
							}),
							{ commandId: `webhook-health:${input.outcome_id}` },
						),
						webhooks.get(webhookId),
					),
				mac,
				masterKey: masterKeyService.key,
				sender: recordingSender,
			})
			if (result.purged) {
				entry.db.close()
				engines.delete(webhookId)
			}
			return result.processed
		})

	const enqueueImpl = (
		webhookId: WebhookId,
		input: EnqueueWebhookDeliveryInput,
		webhooks: WebhookEndpoint["Service"],
		mac: Mac.Mac["Service"],
		masterKeyService: WebhookSigningMasterKey["Service"],
	): Effect.Effect<WebhookDeliveryRecord, WebhookDeliveryStoreError> =>
		Effect.gen(function* () {
			const nowMillis = yield* Clock.currentTimeMillis
			const { engine } = entryFor(webhookId)
			const { record } = yield* Effect.try({
				try: () => engine.enqueue(input, nowMillis),
				catch: storeError,
			})
			if (autoDrain) {
				yield* drainEndpoint(webhookId, webhooks, mac, masterKeyService)
			}
			const latest = engines.get(webhookId)?.engine.getDelivery(record.id, nowMillis)
			return latest ?? record
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
				listDeliveries: (webhookId, query) =>
					Effect.gen(function* () {
						const entry = engines.get(webhookId)
						if (entry === undefined) {
							return { data: [], next_page: null }
						}
						const nowMillis = yield* Clock.currentTimeMillis
						return yield* Effect.try({
							try: () => entry.engine.listDeliveries(query, nowMillis),
							catch: storeError,
						})
					}),
				getDelivery: (webhookId, deliveryId) =>
					Effect.gen(function* () {
						const entry = engines.get(webhookId)
						if (entry === undefined) {
							return null
						}
						const nowMillis = yield* Clock.currentTimeMillis
						return yield* Effect.try({
							try: () => entry.engine.getDelivery(deliveryId, nowMillis),
							catch: storeError,
						})
					}),
				redeliver: (webhookId, deliveryId, newDeliveryId) =>
					Effect.gen(function* () {
						const entry = engines.get(webhookId)
						if (entry === undefined) {
							return null
						}
						const nowMillis = yield* Clock.currentTimeMillis
						const res = yield* Effect.try({
							try: () => entry.engine.redeliver(deliveryId, newDeliveryId, nowMillis),
							catch: storeError,
						})
						if (res === null) {
							return null
						}
						if (autoDrain) {
							yield* drainEndpoint(webhookId, webhooks, mac, masterKeyService)
						}
						return (
							engines.get(webhookId)?.engine.getDelivery(res.record.id, nowMillis) ?? res.record
						)
					}),
				purge: (webhookId) =>
					Effect.sync(() => {
						const entry = engines.get(webhookId)
						if (entry !== undefined) {
							entry.engine.purge()
							entry.db.close()
							engines.delete(webhookId)
						}
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
				for (const id of Array.from(engines.keys())) {
					total += yield* drainEndpoint(WebhookId.make(id), webhooks, mac, masterKeyService)
				}
				return total
			}),
		setSender: (sender: WebhookHttpSender) => {
			activeSender = sender
		},
		pendingCount: (webhookId?: WebhookId) => {
			if (webhookId !== undefined) {
				const entry = engines.get(webhookId)
				return entry === undefined ? 0 : pendingRowCount(entry)
			}
			let total = 0
			for (const entry of engines.values()) {
				total += pendingRowCount(entry)
			}
			return total
		},
		nextAlarmAt: (webhookId: WebhookId): number | null => {
			const entry = engines.get(webhookId)
			return entry === undefined ? null : entry.engine.nextAlarmAt()
		},
	}
}
