import { describe, expect, it } from "@effect/vitest"
import * as Redacted from "effect/Redacted"
import { createPiModels } from "../src/Pi/PiModels.ts"

const MODELS = [
	["openai", "gpt-4o-mini", "authorization"],
	["anthropic", "claude-sonnet-4-5", "x-api-key"],
] as const

// For each provider: the key header of the request it sent, or null when it sent none.
const sentKeys = async (keys: Parameters<typeof createPiModels>[0]) => {
	const models = createPiModels(keys)
	const sent: Array<string | null> = []
	for (const [provider, modelId, header] of MODELS) {
		const model = models.getModel(provider, modelId)
		if (model === undefined) {
			throw new Error(`No model ${provider}/${modelId}`)
		}
		const requests: Array<Headers> = []
		const result = await models.completeSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				maxRetries: 0,
				fetch: (_input, init) => {
					requests.push(new Headers(init?.headers))
					return Promise.resolve(new Response("{}", { status: 400 }))
				},
			},
		)
		expect([provider, result.stopReason]).toEqual([provider, "error"])
		sent.push(requests[0]?.get(header) ?? null)
	}
	return sent
}

describe("provider keys", () => {
	it("sends each provider the key configured for it", async () => {
		expect(
			await sentKeys({
				openai: Redacted.make("sk-openai-test"),
				anthropic: Redacted.make("sk-ant-test"),
			}),
		).toEqual(["Bearer sk-openai-test", "sk-ant-test"])
	})

	it("sends no request to a provider whose key is missing or empty", async () => {
		expect(await sentKeys({ openai: null, anthropic: Redacted.make("") })).toEqual([null, null])
	})
})
