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
const program = Effect.gen(function* () {
	const effectClient = yield* CheckfuClient
	return yield* effectClient.agents.retrieve("agent_types")
})
export { CheckfuApi, created, yielded, program }
