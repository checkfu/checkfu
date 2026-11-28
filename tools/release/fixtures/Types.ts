import Checkfu, { CheckfuClient, NotFoundError } from "@checkfu/sdk"
import type { BodyOf, JsonAgent, Op } from "@checkfu/sdk"
import { CheckfuApi } from "@checkfu/sdk/Api"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

const body: BodyOf<Op<"agents.create">> = { name: "Published SDK", model: "gpt-4o-mini" }
const client = new Checkfu({ apiKey: "type-check", baseUrl: "https://example.com" })
const created = async (): Promise<JsonAgent> =>
	client.waitForPending(await client.agents.create(body))
const error = new NotFoundError({ status: 404, message: "Missing" })
const yielded: Effect.Effect<never, NotFoundError> = error
type PromiseRedeliveryOptions = NonNullable<
	Parameters<typeof client.webhooks.deliveries.redeliver>[2]
>
type EffectClient = typeof CheckfuClient.Service
type EffectRedeliveryOptions = NonNullable<
	Parameters<EffectClient["webhooks"]["deliveries"]["redeliver"]>[2]
>
const redeliveryForbidsKey: [
	PromiseRedeliveryOptions["idempotencyKey"],
	EffectRedeliveryOptions["idempotencyKey"],
] extends [undefined, undefined]
	? true
	: false = true
const responseType = () =>
	client.webhooks.deliveries
		.redeliver("whe_test", "wdel_old", {
			headers: { "x-trace": "type-check" },
			signal: new AbortController().signal,
			idempotencyKey: undefined,
		})
		.withResponse()
const program = Effect.gen(function* () {
	const effectClient = yield* CheckfuClient
	const delivery = yield* effectClient.webhooks.deliveries.redeliver("whe_test", "wdel_old", {
		withResponse: true,
	})
	yield* effectClient.agents.create(body, { idempotencyKey: "type-check" })
	return { id: delivery.data.id, status: delivery.status }
})
const promiseWaits = async (sessionId: string) => {
	for await (const event of await client.sessions.events.stream(sessionId)) {
		if (event.type === "session.status_terminated") {
			break
		}
		if (event.type === "session.status_idle") {
			return event.stop_reason.type === "requires_action"
				? {
						waiting: event.stop_reason.event_ids,
						resume: () => client.sessions.events.stream(sessionId, { after: event.seq }),
					}
				: undefined
		}
	}
	return undefined
}
const effectWaits = (sessionId: string) =>
	Effect.gen(function* () {
		const effectClient = yield* CheckfuClient
		const event = yield* effectClient.sessions.events.stream(sessionId).pipe(
			Stream.filter(
				(event) =>
					event.type === "session.status_idle" || event.type === "session.status_terminated",
			),
			Stream.runHead,
		)
		if (
			event._tag === "Some" &&
			event.value.type === "session.status_idle" &&
			event.value.stop_reason.type === "requires_action"
		) {
			return {
				waiting: event.value.stop_reason.event_ids,
				resume: () => effectClient.sessions.events.stream(sessionId, { after: event.value.seq }),
			}
		}
	})
const vaultErased = async (vaultId: string): Promise<boolean> => {
	const vault = await client.vaults.delete(vaultId)
	return vault.secrets === "erased"
}
const credentialErased = async (vaultId: string, credentialId: string): Promise<boolean> => {
	const credential = await client.vaults.credentials.delete(vaultId, credentialId)
	return credential.custody === "erased"
}
export {
	CheckfuApi,
	created,
	yielded,
	program,
	promiseWaits,
	effectWaits,
	redeliveryForbidsKey,
	responseType,
	vaultErased,
	credentialErased,
}
