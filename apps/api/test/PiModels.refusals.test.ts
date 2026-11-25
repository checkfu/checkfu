import type { AssistantMessage } from "@earendil-works/pi-ai"
import { describe, expect, it } from "@effect/vitest"
import * as Redacted from "effect/Redacted"
import { OPENAI_REFUSAL_ERROR, createPiModels } from "../src/Pi/PiModels.ts"
import { isRefusalAssistantMessage } from "../src/Pi/PiRefusals.ts"

const sse = (events: ReadonlyArray<{ readonly type: string }>): string =>
	events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")

const complete = (
	provider: "openai" | "anthropic",
	modelId: string,
	events: ReadonlyArray<{ readonly type: string }>,
): Promise<AssistantMessage> => {
	const models = createPiModels({
		openai: Redacted.make("sk-openai-test"),
		anthropic: Redacted.make("sk-ant-test"),
	})
	const model = models.getModel(provider, modelId)
	if (model === undefined) {
		throw new Error(`No model ${provider}/${modelId}`)
	}
	return models.complete(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
		{
			fetch: () =>
				Promise.resolve(
					new Response(sse(events), {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
				),
		},
	)
}

const anthropicStop = (stop_reason: "refusal" | "sensitive") => [
	{
		type: "message_start",
		message: {
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 0 },
		},
	},
	{
		type: "message_delta",
		delta: { stop_sequence: null, stop_reason },
		usage: { output_tokens: 1 },
	},
	{ type: "message_stop" },
]

const openAIMessage = (content: ReadonlyArray<object>) => ({
	id: "msg_1",
	type: "message",
	role: "assistant",
	status: "completed",
	content,
})

const openAICompleted = (content: ReadonlyArray<object>) => [
	{ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
	{
		type: "response.output_item.added",
		output_index: 0,
		item: { ...openAIMessage([]), status: "in_progress" },
	},
	{ type: "response.output_item.done", output_index: 0, item: openAIMessage(content) },
	{
		type: "response.completed",
		response: {
			id: "resp_1",
			status: "completed",
			output: [openAIMessage(content)],
			usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
		},
	},
]

const openAIFiltered = [
	{ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
	{
		type: "response.incomplete",
		response: {
			id: "resp_1",
			status: "incomplete",
			incomplete_details: { reason: "content_filter" },
			output: [],
			usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
		},
	},
]

describe("pi-ai's refusal reports", () => {
	it("reports an Anthropic refusal or sensitive stop as an error that keeps the stop reason", async () => {
		const refusal = await complete("anthropic", "claude-sonnet-4-5", anthropicStop("refusal"))
		expect(refusal).toMatchObject({
			stopReason: "error",
			rawStopReason: "refusal",
			errorMessage: "The model refused to complete the request",
		})
		expect(isRefusalAssistantMessage(refusal)).toBe(true)

		const sensitive = await complete("anthropic", "claude-sonnet-4-5", anthropicStop("sensitive"))
		expect(sensitive).toMatchObject({
			stopReason: "error",
			rawStopReason: "sensitive",
			errorMessage: "Provider stopped with: sensitive",
		})
		expect(isRefusalAssistantMessage(sensitive)).toBe(true)
	})

	it("reports an OpenAI content filter stop as an error that keeps the stop reason and the usage", async () => {
		const filtered = await complete("openai", "gpt-4o-mini", openAIFiltered)
		expect(filtered).toMatchObject({
			stopReason: "error",
			rawStopReason: "incomplete.content_filter",
			errorMessage: "Response incomplete: content_filter",
			usage: { input: 10, output: 1 },
		})
		expect(isRefusalAssistantMessage(filtered)).toBe(true)
	})

	it("turns a completed OpenAI reply with a refusal part into a refusal that carries only that part", async () => {
		const refused = await complete(
			"openai",
			"gpt-4o-mini",
			openAICompleted([
				{ type: "output_text", text: "Partial answer. " },
				{ type: "refusal", refusal: "I can't help with that." },
			]),
		)
		expect(refused).toMatchObject({
			stopReason: "error",
			rawStopReason: "refusal",
			errorMessage: OPENAI_REFUSAL_ERROR,
			content: [{ type: "text", text: "I can't help with that." }],
			usage: { input: 10, output: 3 },
		})
		expect(isRefusalAssistantMessage(refused)).toBe(true)

		const answered = await complete(
			"openai",
			"gpt-4o-mini",
			openAICompleted([{ type: "output_text", text: "A plain answer." }]),
		)
		expect(answered).toMatchObject({
			stopReason: "stop",
			rawStopReason: "completed",
			content: [{ type: "text", text: "A plain answer." }],
		})
	})

	it("leaves an OpenAI stream that fails after a completed refusal as a provider error", async () => {
		const failed = await complete("openai", "gpt-4o-mini", [
			...openAICompleted([{ type: "refusal", refusal: "I can't help with that." }]),
			{ type: "error" },
		])
		expect(failed).toMatchObject({ stopReason: "error", rawStopReason: "completed" })
		expect(isRefusalAssistantMessage(failed)).toBe(false)
	})
})
