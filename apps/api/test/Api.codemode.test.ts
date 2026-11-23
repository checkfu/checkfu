import { MAX_TOOL_INPUT_JSON_LENGTH } from "@checkfu/domain/Session/SessionTypes"
import type { AssistantMessage, Api, Model, TranscriptContext } from "@earendil-works/pi-ai"
import { CodemodeSandbox } from "@earendil-works/pi-codemode"
import type { Extension } from "@earendil-works/pi-durable"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import { makeApiHandler } from "../src/Http/Router.ts"
import { loadToolSurface, withScriptDeadline } from "../src/Pi/PiCodemode.ts"
import { createCheckfuRegistry } from "../src/Pi/PiRefusals.ts"
import {
	AUTH_HEADERS,
	createIdleSession,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendAndSettle,
	sendRequest,
} from "./helpers/ApiHarness.ts"

const lookup: Extension = {
	name: "probe",
	tools: [
		{
			name: "lookup",
			description: "Look a key up.",
			parameters: { type: "object", properties: { key: { type: "string" } } },
			replay: "safe",
			execute: (args) =>
				Promise.resolve({ output: [{ type: "text", text: `value of ${JSON.stringify(args)}` }] }),
		},
		{
			name: "stall",
			description: "Never answers.",
			parameters: { type: "object", properties: {} },
			execute: (_args, _api, context) =>
				new Promise((_resolve, reject) => {
					context.abortSignal?.addEventListener("abort", () => reject(new Error("stopped")))
				}),
		},
	],
}

const tickets: Extension = {
	name: "tickets",
	namespace: { name: "tickets", description: "The support desk." },
	tools: [
		{
			name: "ticket_lookup",
			description: "Read a support ticket by its id.",
			parameters: { type: "object", properties: { id: { type: "string" } } },
			deferred: true,
			replay: "safe",
			execute: (args) =>
				Promise.resolve({ output: [{ type: "text", text: `ticket ${JSON.stringify(args)}` }] }),
		},
	],
}

const withToolSurface = await loadToolSurface()

const withSandbox = (
	extensions: ReadonlyArray<Extension>,
	deadline?: Parameters<typeof withScriptDeadline>[1],
) => {
	const sandboxes: Array<CodemodeSandbox> = []
	return {
		registry: () => {
			const sandbox = withScriptDeadline(new CodemodeSandbox(), deadline)
			sandboxes.push(sandbox)
			const registry = createCheckfuRegistry()
			for (const extension of withToolSurface(sandbox, extensions)) {
				registry.install(extension)
			}
			return registry
		},
		close: () => Promise.all(sandboxes.map((sandbox) => sandbox.close())),
	}
}

const call = (model: Model<Api>, name: string, args: Schema.JsonObject): AssistantMessage => ({
	...makeAssistantReply(model, null, "", 3, 2),
	content: [{ type: "toolCall" as const, id: `call-${name}`, name, arguments: args }],
	stopReason: "toolUse",
})

const toolResults = (context: TranscriptContext) =>
	context.messages.filter((message) => message.role === "toolResult")

const runTurn = async (
	handler: (model: Model<Api>, context: TranscriptContext) => AssistantMessage,
	surface: ReturnType<typeof withSandbox>,
): Promise<ReadonlyArray<Schema.JsonObject>> => {
	const { layer, closeAll } = makePiDurableTestLayer(
		(model, context) => Promise.resolve(handler(model, context)),
		undefined,
		undefined,
		surface.registry,
	)
	try {
		return await Effect.runPromise(
			Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				const session = yield* createIdleSession(apiFetch)
				yield* sendAndSettle(apiFetch, session.id, ["go"], 1)
				const res = yield* sendRequest(apiFetch, {
					method: "GET",
					path: `/v1/sessions/${session.id}/events?limit=100`,
					headers: AUTH_HEADERS,
				})
				const body = (yield* Effect.promise(() => res.json())) as {
					readonly data: ReadonlyArray<Schema.JsonObject>
				}
				return body.data.filter((event) => String(event["type"]).startsWith("agent."))
			}).pipe(Effect.scoped, Effect.provide(layer)),
		)
	} finally {
		await closeAll()
		await surface.close()
	}
}

const resultText = (event: Schema.JsonObject | undefined): string =>
	((event?.["content"] ?? []) as ReadonlyArray<{ readonly text: string }>)
		.map((block) => block.text)
		.join("")

describe("Code mode and tool search", () => {
	it("runs a script that calls the session's tools and logs it as one call", async () => {
		const code = [
			'const a = await tools.lookup({ key: "alpha" });',
			'const b = await tools.lookup({ key: "beta" });',
			'return [a, b].join(" + ");',
		].join("\n")
		const events = await runTurn(
			(model, context) =>
				toolResults(context).length === 0
					? call(model, "codemode", { code })
					: makeAssistantReply(model, null, "Done.", 5, 4),
			withSandbox([lookup]),
		)

		expect(events.map((event) => event["type"])).toEqual([
			"agent.tool_use",
			"agent.tool_result",
			"agent.message",
		])
		expect(events[0]).toMatchObject({ name: "codemode", input: { code } })
		expect(events[1]).toMatchObject({ is_error: false })
		expect(resultText(events[1])).toContain('value of {"key":"alpha"} + value of {"key":"beta"}')
	})

	it("keeps a turn whose script emits a 2 MiB image, with a note in the image's place", async () => {
		// A PNG signature, then zero bytes: about 2 MiB once decoded.
		const code = `image("data:image/png;base64,iVBORw0KGgoA" + "A".repeat(${4 * Math.ceil((2 * 1024 * 1024) / 3)})); return "drew"`
		const seen: Array<ReadonlyArray<string>> = []
		const events = await runTurn(
			(model, context) => {
				const results = toolResults(context)
				if (results.length === 0) {
					return call(model, "codemode", { code })
				}
				for (const message of results) {
					seen.push(message.content.map((part) => (part.type === "text" ? part.text : part.type)))
				}
				return makeAssistantReply(model, null, "Done.", 5, 4)
			},
			withSandbox([lookup]),
		)
		expect(events.map((event) => event["type"])).toContain("agent.message")
		expect(seen.flat().some((text) => text.includes("left out"))).toBe(true)
		expect(seen.flat()).not.toContain("image")
	})

	it("runs a script longer than the log keeps and marks the logged input cut", async () => {
		const code = `const pad = "${"x".repeat(MAX_TOOL_INPUT_JSON_LENGTH)}";\nreturn pad.length;`
		const events = await runTurn(
			(model, context) =>
				toolResults(context).length === 0
					? call(model, "codemode", { code })
					: makeAssistantReply(model, null, "Done.", 5, 4),
			withSandbox([lookup]),
		)

		expect(events[0]).toMatchObject({ name: "codemode", input: {}, truncated: true })
		expect(events[1]).toMatchObject({ is_error: false })
		expect(resultText(events[1])).toContain(String(MAX_TOOL_INPUT_JSON_LENGTH))
	})

	it("does not offer tool search when no tool is deferred", async () => {
		const events = await runTurn(
			(model, context) =>
				toolResults(context).length === 0
					? call(model, "tool_search", { query: "ticket" })
					: makeAssistantReply(model, null, "Done.", 5, 4),
			withSandbox([lookup]),
		)

		expect(events[1]).toMatchObject({ is_error: true })
	})

	it("keeps a deferred tool from the model until tool search loads it", async () => {
		const events = await runTurn(
			(model, context) => {
				switch (toolResults(context).length) {
					case 0:
						return call(model, "ticket_lookup", { id: "T-1" })
					case 1:
						return call(model, "tool_search", { query: "support ticket" })
					case 2:
						return call(model, "ticket_lookup", { id: "T-1" })
					default:
						return makeAssistantReply(model, null, "Done.", 5, 4)
				}
			},
			withSandbox([lookup, tickets]),
		)

		const results = events.filter((event) => event["type"] === "agent.tool_result")
		expect(results[0]).toMatchObject({ is_error: true })
		expect(results[1]).toMatchObject({ is_error: false })
		expect(resultText(results[1])).toContain("ticket_lookup")
		expect(results[2]).toMatchObject({ is_error: false })
		expect(resultText(results[2])).toContain('ticket {"id":"T-1"}')
	})

	it("lets a script find and call a deferred tool that was never loaded", async () => {
		const code = [
			'const [found] = await searchTools("support ticket");',
			'return found.name + ": " + (await tools.ticket_lookup({ id: "T-2" }));',
		].join("\n")
		const events = await runTurn(
			(model, context) =>
				toolResults(context).length === 0
					? call(model, "codemode", { code })
					: makeAssistantReply(model, null, "Done.", 5, 4),
			withSandbox([lookup, tickets]),
		)

		expect(events[1]).toMatchObject({ is_error: false })
		expect(resultText(events[1])).toContain('ticket_lookup: ticket {"id":"T-2"}')
	})

	it.each([
		[
			"a script that names no deadline",
			"await tools.stall({});",
			{ defaultMs: 200, maxMs: 60_000 },
		],
		[
			"a script that asks for more than the cap",
			'// @options: {"timeout_ms": 600000}\nawait tools.stall({});',
			{ defaultMs: 60_000, maxMs: 200 },
		],
	])("ends %s at the deadline", async (_name, code, deadline) => {
		const events = await runTurn(
			(model, context) =>
				toolResults(context).length === 0
					? call(model, "codemode", { code })
					: makeAssistantReply(model, null, "Done.", 5, 4),
			withSandbox([lookup], deadline),
		)

		expect(events[1]).toMatchObject({ is_error: true })
		expect(resultText(events[1])).toContain("timed out")
		expect(events[2]).toMatchObject({ content: [{ type: "text", text: "Done." }] })
	})
})
