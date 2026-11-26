import * as Cloudflare from "@alchemy.run/cloudflare"
import { RecordWebhookOutcome } from "@checkfu/domain/Webhook/RecordWebhookOutcome.command"
import { WebhookEndpoint } from "@checkfu/domain/Webhook/WebhookEndpoint.aggregate"
import type { WebhookDeliveryId, WebhookId } from "@checkfu/sdk/Schemas"
import * as Alchemy from "alchemy"
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
import type * as WebhookEgressModule from "./WebhookEgress.ts"
import { WebhookSigningMasterKey } from "./WebhookSigning.ts"

const storeError = (cause: unknown) => new WebhookDeliveryStoreError({ cause })

const toStoreError = (
	error: WebhookDeliveryStoreError | Cloudflare.DurableObjectStorageError,
): WebhookDeliveryStoreError =>
	error._tag === "WebhookDeliveryStoreError" ? error : storeError(error)

const overWire = <A, R>(effect: Effect.Effect<A, WebhookDeliveryStoreError, R>) =>
	Effect.mapError(effect, (error) => storeError(String(error.cause)))

export interface WebhookDelivererShape {
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

const DELIVER_CALLBACK = "deliver"
const DELIVER_JOB_ID = "deliver"

interface DeliverCallbackSlot {
	current: Alchemy.Callback<WebhookId> | undefined
}

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
			Effect.gen(function* () {
				const rawStorage = state.raw.storage
				let cachedEngine:
					| { readonly id: WebhookId; readonly engine: WebhookDeliveryEngine }
					| undefined
				let cachedEngineModule: Promise<typeof WebhookDeliveryEngineModule> | undefined
				let cachedEgressModule: Promise<typeof WebhookEgressModule> | undefined
				let cachedSender: WebhookHttpSender | undefined
				let inAsyncTx = false

				const withStorageTx = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
					state.storage
						.transaction(
							Effect.acquireUseRelease(
								Effect.sync(() => {
									const previous = inAsyncTx
									inAsyncTx = true
									return previous
								}),
								() => effect,
								(previous) =>
									Effect.sync(() => {
										inAsyncTx = previous
									}),
							),
						)
						.pipe(
							Effect.tapError(() =>
								Effect.sync(() => {
									cachedEngine = undefined
								}),
							),
						)

				const loadEngineModule = () =>
					Effect.promise(() => {
						cachedEngineModule ??= import("./WebhookDeliveryEngine.ts")
						return cachedEngineModule
					})

				const loadEgressModule = () =>
					Effect.promise(() => {
						cachedEgressModule ??= import("./WebhookEgress.ts")
						return cachedEgressModule
					})

				const engineFor = (webhookId: WebhookId): Effect.Effect<WebhookDeliveryEngine> =>
					Effect.map(loadEngineModule(), (mod) => {
						if (cachedEngine !== undefined && cachedEngine.id === webhookId) {
							return cachedEngine.engine
						}
						const engine = new mod.WebhookDeliveryEngine(webhookId, {
							exec: (query, ...bindings) => rawStorage.sql.exec(query, ...bindings),
							transaction: (fn) => (inAsyncTx ? fn() : rawStorage.transactionSync(fn)),
						})
						cachedEngine = { id: webhookId, engine }
						return engine
					})

				const senderEffect: Effect.Effect<WebhookHttpSender> = Effect.gen(function* () {
					if (cachedSender !== undefined) {
						return cachedSender
					}
					const mod = yield* loadEgressModule()
					const config = yield* mod.readWebhookEgressConfig
					cachedSender = yield* mod.makeDefaultWebhookHttpSender(config)
					return cachedSender
				})

				const callbackRef: DeliverCallbackSlot = { current: undefined }
				const onDeliver = yield* Alchemy.makeCallback(
					DELIVER_CALLBACK,
					Effect.fn(function* (webhookId: WebhookId) {
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
										{ commandId: `webhook-health:${input.outcome_id}` },
									),
									webhooks.get(webhookId),
								),
							mac,
							masterKey: masterKey.key,
							sender,
							jitterFraction: randomJitterFraction(random),
						})
						if (result.purged) {
							cachedEngine = undefined
							return
						}
						const callback = callbackRef.current
						if (callback === undefined) {
							return
						}
						yield* withStorageTx(
							Effect.gen(function* () {
								const nextAlarmAt = engine.nextAlarmAt()
								if (nextAlarmAt === null) {
									return
								}
								const status = yield* callback.getStatus(DELIVER_JOB_ID)
								const nextProgress = (status?.progress ?? 0) + 1
								yield* callback.schedule(DELIVER_JOB_ID, {
									at: Math.max(1, nextAlarmAt),
									payload: webhookId,
									progress: nextProgress,
								})
							}),
						).pipe(Effect.orDie)
					}),
				)
				callbackRef.current = onDeliver

				const scheduleExternal = (webhookId: WebhookId, nextAlarmAt: number | null) =>
					nextAlarmAt === null
						? Effect.void
						: onDeliver
								.schedule(DELIVER_JOB_ID, {
									at: Math.max(1, nextAlarmAt),
									payload: webhookId,
								})
								.pipe(Effect.mapError(storeError))

				return {
					enqueue: (webhookId, input) =>
						overWire(
							Effect.gen(function* () {
								const nowMillis = yield* Clock.currentTimeMillis
								const engine = yield* engineFor(webhookId)
								yield* Effect.try({
									try: () => {
										engine.ensureSchema()
									},
									catch: storeError,
								})
								return yield* withStorageTx(
									Effect.gen(function* () {
										const { record, nextAlarmAt } = yield* Effect.try({
											try: () => engine.enqueue(input, nowMillis),
											catch: storeError,
										})
										yield* scheduleExternal(webhookId, nextAlarmAt)
										return record
									}),
								).pipe(Effect.mapError(toStoreError))
							}),
						),
					listDeliveries: (webhookId, query) =>
						overWire(
							Effect.gen(function* () {
								const nowMillis = yield* Clock.currentTimeMillis
								const engine = yield* engineFor(webhookId)
								return yield* Effect.try({
									try: () => engine.listDeliveries(query, nowMillis),
									catch: storeError,
								})
							}),
						),
					getDelivery: (webhookId, deliveryId) =>
						overWire(
							Effect.gen(function* () {
								const nowMillis = yield* Clock.currentTimeMillis
								const engine = yield* engineFor(webhookId)
								return yield* Effect.try({
									try: () => engine.getDelivery(deliveryId, nowMillis),
									catch: storeError,
								})
							}),
						),
					redeliver: (webhookId, deliveryId, newDeliveryId) =>
						overWire(
							Effect.gen(function* () {
								const nowMillis = yield* Clock.currentTimeMillis
								const engine = yield* engineFor(webhookId)
								yield* Effect.try({
									try: () => {
										engine.ensureSchema()
									},
									catch: storeError,
								})
								return yield* withStorageTx(
									Effect.gen(function* () {
										const result = yield* Effect.try({
											try: () => engine.redeliver(deliveryId, newDeliveryId, nowMillis),
											catch: storeError,
										})
										if (result === null) {
											return null
										}
										yield* scheduleExternal(webhookId, result.nextAlarmAt)
										return result.record
									}),
								).pipe(Effect.mapError(toStoreError))
							}),
						),
					purge: (webhookId) =>
						overWire(
							Effect.gen(function* () {
								const engine = yield* engineFor(webhookId)
								yield* Effect.try({
									try: () => {
										engine.ensureSchema()
									},
									catch: storeError,
								})
								yield* withStorageTx(
									Effect.gen(function* () {
										yield* Effect.try({
											try: () => {
												engine.purge()
											},
											catch: storeError,
										})
										yield* onDeliver.cancel(DELIVER_JOB_ID).pipe(Effect.mapError(storeError))
									}),
								).pipe(Effect.mapError(toStoreError))
								cachedEngine = undefined
							}),
						),
				} satisfies WebhookDelivererShape
			}).pipe(
				Effect.provide(
					Cloudflare.DurableObjectCallbacks.pipe(
						Layer.provide(Layer.succeed(SecureRandom.SecureRandom, random)),
					),
				),
			),
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
