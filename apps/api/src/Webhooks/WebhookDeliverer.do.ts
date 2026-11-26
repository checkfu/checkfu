import * as Cloudflare from "@alchemy.run/cloudflare"
import { RecordWebhookOutcome } from "@checkfu/domain/Webhook/RecordWebhookOutcome.command"
import { WebhookEndpoint } from "@checkfu/domain/Webhook/WebhookEndpoint.aggregate"
import { WebhookId } from "@checkfu/sdk/Schemas"
import type { WebhookDeliveryId } from "@checkfu/sdk/Schemas"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { placedStub, placement } from "../Placement.ts"
import type * as WebhookDeliveryEngineModule from "./WebhookDeliveryEngine.ts"
import type { WebhookDeliveryEngine, WebhookHttpSender } from "./WebhookDeliveryEngine.ts"
import { WebhookDeliveryStore, WebhookDeliveryStoreError } from "./WebhookDeliveryStore.ts"
import type {
	EnqueueWebhookDeliveryInput,
	ListWebhookDeliveriesPage,
	ListWebhookDeliveriesQuery,
	WebhookDeliveryRecord,
} from "./WebhookDeliveryStore.ts"
import { WebhookSigningMasterKey } from "./WebhookSigning.ts"

const storeError = (cause: unknown) => new WebhookDeliveryStoreError({ cause })

const overWire = <A, R>(effect: Effect.Effect<A, WebhookDeliveryStoreError, R>) =>
	Effect.mapError(effect, (error) => storeError(String(error.cause)))

export interface WebhookDelivererShape {
	readonly alarm: (
		info?: Cloudflare.AlarmInvocationInfo,
	) => Effect.Effect<void, never, RuntimeContext>
	readonly enqueue: (
		webhookId: WebhookId,
		input: EnqueueWebhookDeliveryInput,
	) => Effect.Effect<WebhookDeliveryRecord, WebhookDeliveryStoreError, RuntimeContext>
	readonly listDeliveries: (
		webhookId: WebhookId,
		query: ListWebhookDeliveriesQuery,
	) => Effect.Effect<ListWebhookDeliveriesPage, WebhookDeliveryStoreError, RuntimeContext>
	readonly getDelivery: (
		webhookId: WebhookId,
		deliveryId: WebhookDeliveryId,
	) => Effect.Effect<WebhookDeliveryRecord | null, WebhookDeliveryStoreError, RuntimeContext>
	readonly redeliver: (
		webhookId: WebhookId,
		deliveryId: WebhookDeliveryId,
		newDeliveryId: WebhookDeliveryId,
	) => Effect.Effect<WebhookDeliveryRecord | null, WebhookDeliveryStoreError, RuntimeContext>
	readonly purge: (
		webhookId: WebhookId,
	) => Effect.Effect<void, WebhookDeliveryStoreError, RuntimeContext>
}

export class WebhookDeliverer extends Cloudflare.DurableObject<
	WebhookDeliverer,
	WebhookDelivererShape
>()("WebhookDeliverer") {}

const randomJitterFraction = (
	random: SecureRandom.SecureRandom["Service"],
): Effect.Effect<number> =>
	Effect.map(random.randomBytes(2), (bytes) => {
		const value = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)
		return (value / 65_535) * 0.2 - 0.1
	})

const WEBHOOK_ID_STORAGE_KEY = "webhook_id"

export const WebhookDelivererLive = WebhookDeliverer.make(
	Effect.map(
		Effect.gen(function* () {
			const state = yield* Cloudflare.DurableObjectState
			const webhooks = yield* WebhookEndpoint
			const mac = yield* Mac.Mac
			const random = yield* SecureRandom.SecureRandom
			const masterKey = yield* WebhookSigningMasterKey
			return { state, webhooks, mac, random, masterKey }
		}),
		({ state, webhooks, mac, random, masterKey }) =>
			Effect.sync((): WebhookDelivererShape => {
				const rawStorage = state.raw.storage
				let cachedEngine:
					| { readonly id: WebhookId; readonly engine: WebhookDeliveryEngine }
					| undefined
				let cachedModule: Promise<typeof WebhookDeliveryEngineModule> | undefined
				let cachedSender: WebhookHttpSender | undefined

				const loadEngineModule = () =>
					Effect.promise(() => {
						cachedModule ??= import("./WebhookDeliveryEngine.ts")
						return cachedModule
					})

				const engineFor = (webhookId: WebhookId): Effect.Effect<WebhookDeliveryEngine> =>
					Effect.map(loadEngineModule(), (mod) => {
						if (cachedEngine !== undefined && cachedEngine.id === webhookId) {
							return cachedEngine.engine
						}
						rawStorage.kv.put(WEBHOOK_ID_STORAGE_KEY, webhookId)
						const engine = new mod.WebhookDeliveryEngine(webhookId, {
							exec: (query, ...bindings) => rawStorage.sql.exec(query, ...bindings),
						})
						cachedEngine = { id: webhookId, engine }
						return engine
					})

				const senderEffect: Effect.Effect<WebhookHttpSender> = Effect.gen(function* () {
					if (cachedSender !== undefined) {
						return cachedSender
					}
					const mod = yield* loadEngineModule()
					cachedSender = yield* mod.makeDefaultFetchWebhookHttpSender
					return cachedSender
				})

				const syncAlarm = (nextAlarmAt: number | null): Effect.Effect<void> =>
					Effect.promise(async () => {
						if (nextAlarmAt === null) {
							await rawStorage.deleteAlarm()
						} else {
							await rawStorage.setAlarm(nextAlarmAt)
						}
					})

				const resolveWebhookId = (): WebhookId | null => {
					if (cachedEngine !== undefined) {
						return cachedEngine.id
					}
					const stored = rawStorage.kv.get<string>(WEBHOOK_ID_STORAGE_KEY)
					if (typeof stored === "string" && stored.length > 0) {
						return WebhookId.make(stored)
					}
					return null
				}

				return {
					alarm: () =>
						Effect.gen(function* () {
							const webhookId = resolveWebhookId()
							if (webhookId === null) {
								yield* syncAlarm(null)
								return
							}
							const engine = yield* engineFor(webhookId)
							const sender = yield* senderEffect
							const result = yield* engine.drainDue({
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
										),
										webhooks.get(webhookId),
									),
								mac,
								masterKey: masterKey.key,
								sender,
								jitterFraction: randomJitterFraction(random),
							})
							if (result.purged) {
								rawStorage.kv.delete(WEBHOOK_ID_STORAGE_KEY)
								cachedEngine = undefined
							}
							yield* syncAlarm(result.nextAlarmAt)
						}).pipe(
							Effect.catchCause((cause) =>
								Cause.hasInterruptsOnly(cause)
									? Effect.interrupt
									: Effect.logError("Webhook delivery alarm failed", cause),
							),
						),
					enqueue: (webhookId, input) =>
						overWire(
							Effect.gen(function* () {
								const nowMillis = yield* Clock.currentTimeMillis
								const engine = yield* engineFor(webhookId)
								const { record, nextAlarmAt } = yield* Effect.try({
									try: () => engine.enqueue(input, nowMillis),
									catch: storeError,
								})
								yield* syncAlarm(nextAlarmAt)
								return record
							}),
						),
					listDeliveries: (webhookId, query) =>
						overWire(
							Effect.gen(function* () {
								const engine = yield* engineFor(webhookId)
								return yield* Effect.try({
									try: () => engine.listDeliveries(query),
									catch: storeError,
								})
							}),
						),
					getDelivery: (webhookId, deliveryId) =>
						overWire(
							Effect.gen(function* () {
								const engine = yield* engineFor(webhookId)
								return yield* Effect.try({
									try: () => engine.getDelivery(deliveryId),
									catch: storeError,
								})
							}),
						),
					redeliver: (webhookId, deliveryId, newDeliveryId) =>
						overWire(
							Effect.gen(function* () {
								const nowMillis = yield* Clock.currentTimeMillis
								const engine = yield* engineFor(webhookId)
								const result = yield* Effect.try({
									try: () => engine.redeliver(deliveryId, newDeliveryId, nowMillis),
									catch: storeError,
								})
								if (result === null) {
									return null
								}
								yield* syncAlarm(result.nextAlarmAt)
								return result.record
							}),
						),
					purge: (webhookId) =>
						overWire(
							Effect.gen(function* () {
								const engine = yield* engineFor(webhookId)
								yield* Effect.try({
									try: () => {
										engine.purge()
										rawStorage.kv.delete(WEBHOOK_ID_STORAGE_KEY)
										cachedEngine = undefined
									},
									catch: storeError,
								})
								yield* syncAlarm(null)
							}),
						),
				}
			}),
	),
)

export const WebhookDeliveryStoreDo = Layer.effect(
	WebhookDeliveryStore,
	Effect.gen(function* () {
		const placed = yield* placement
		const deliverers = placedStub(yield* WebhookDeliverer, placed)
		const runtime = yield* Cloudflare.Worker
		const call = <A, E>(effect: () => Effect.Effect<A, E, RuntimeContext>) =>
			Effect.suspend(effect).pipe(
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.fail(storeError(Cause.squash(cause))),
				),
				Effect.provideService(RuntimeContext, runtime),
			)
		return {
			enqueue: (webhookId, input) => call(() => deliverers(webhookId).enqueue(webhookId, input)),
			listDeliveries: (webhookId, query) =>
				call(() => deliverers(webhookId).listDeliveries(webhookId, query)),
			getDelivery: (webhookId, deliveryId) =>
				call(() => deliverers(webhookId).getDelivery(webhookId, deliveryId)),
			redeliver: (webhookId, deliveryId, newDeliveryId) =>
				call(() => deliverers(webhookId).redeliver(webhookId, deliveryId, newDeliveryId)),
			purge: (webhookId) => call(() => deliverers(webhookId).purge(webhookId)),
		}
	}),
)
