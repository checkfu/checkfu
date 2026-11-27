import Checkfu, { CheckfuClient, NotFoundError } from "@checkfu/sdk"
import type { BodyOf, JsonAgent, Op } from "@checkfu/sdk"
import { CheckfuApi } from "@checkfu/sdk/Api"
import * as Effect from "effect/Effect"

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
export { CheckfuApi, created, yielded, program, redeliveryForbidsKey, responseType }
