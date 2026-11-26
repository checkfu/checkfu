import { MAX_TOOL_INPUT_JSON_LENGTH } from "@checkfu/domain/Session/SessionTypes"
import type { AssistantMessage, Api, Model, TranscriptContext } from "@earendil-works/pi-ai"
import { CodemodeSandbox } from "@earendil-works/pi-codemode"
import type { Extension } from "@earendil-works/pi-durable"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import { makeApiHandler } from "../src/Http/Router.ts"
import {
	SCRIPT_LIMITS,
	loadToolSurface,
	scriptOutputEnv,
	withScriptBounds,
} from "../src/Pi/PiCodemode.ts"
import type { ScriptDeadline, ScriptLimits } from "../src/Pi/PiCodemode.ts"
import { createCheckfuRegistry } from "../src/Pi/PiRefusals.ts"
import {
	AUTH_HEADERS,
	createIdleSession,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendAndSettle,
	sendRequest,
} from "./helpers/ApiHarness.ts"
import { storedWrites } from "./helpers/InMemoryPiBackend.ts"
import { STORAGE_ROW_BYTES } from "../src/Pi/PiResultBounds.ts"

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
			name: "cut",
			description: "Return output its own bounds already cut.",
			parameters: { type: "object", properties: {} },
			replay: "safe",
			execute: () =>
				Promise.resolve({
					output: [{ type: "text", text: "the beginning" }],
					diagnostics: [{ severity: "warn", code: "truncated", message: "Output truncated." }],
				}),
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
	deadline?: ScriptDeadline,
	failWrites = false,
	limits: ScriptLimits = SCRIPT_LIMITS,
) => {
	const sandboxes: Array<CodemodeSandbox> = []
	const files = new Map<string, string | Uint8Array>()
	const write = (path: string, content: string | Uint8Array) => {
		if (failWrites) {
			return Promise.reject(new Error("/workspace/.scripts is not a directory"))
		}
		files.set(path, content)
		return Promise.resolve(undefined)
	}
	return {
		files,
		env: scriptOutputEnv(write),
		registry: () => {
			const sandbox = withScriptBounds(new CodemodeSandbox(), limits)
			sandboxes.push(sandbox)
			const surface = withToolSurface(
				sandbox,
				extensions,
				deadline === undefined ? { limits } : { deadline, limits },
			)
			const registry = createCheckfuRegistry()
			for (const extension of surface) {
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
		{ registry: surface.registry, executionEnv: surface.env },
	)
	try {
		return await Effect.runPromise(
			Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				const session = yield* createIdleSession(apiFetch)
				yield* sendAndSettle(apiFetch, session.id, ["go"], 1)
				const events: Array<Schema.JsonObject> = []
				let after: number | null = null
				while (true) {
					const res = yield* sendRequest(apiFetch, {
						method: "GET",
						path: `/v1/sessions/${session.id}/events?limit=100${after === null ? "" : `&after=${after}`}`,
						headers: AUTH_HEADERS,
					})
					const body = (yield* Effect.promise(() => res.json())) as {
						readonly data: ReadonlyArray<Schema.JsonObject>
						readonly has_more: boolean
						readonly next_cursor: number | null
					}
					events.push(...body.data)
					if (!body.has_more || body.next_cursor === null) {
						break
					}
					after = body.next_cursor
				}
				return events.filter((event) => String(event["type"]).startsWith("agent."))
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
		expect(events[1]).toMatchObject({ tool_use_id: events[0]?.["tool_use_id"], is_error: false })
		expect(resultText(events[1])).toContain('value of {"key":"alpha"} + value of {"key":"beta"}')
	})

	const answering =
		(seen: Array<string>, code: string) => (model: Model<Api>, context: TranscriptContext) => {
			const results = toolResults(context)
			if (results.length === 0) {
				return call(model, "codemode", { code })
			}
			for (const message of results) {
				seen.push(message.content.map((part) => (part.type === "text" ? part.text : "")).join(""))
			}
			return makeAssistantReply(model, null, "Done.", 5, 4)
		}

	const settlesWithin = async (code: string, surface = withSandbox([lookup])) => {
		const written = storedWrites.length
		const seen: Array<string> = []
		const events = await runTurn(answering(seen, code), surface)
		expect(events.at(-1)?.["type"]).toBe("agent.message")
		for (const write of storedWrites.slice(written)) {
			expect(write.bytes, write.kind).toBeLessThanOrEqual(STORAGE_ROW_BYTES)
		}
		return { events, seen: seen.join("") }
	}

	const over = SCRIPT_LIMITS.resultBytes + 1024

	it.each([
		["text", `text("x".repeat(${over})); return "ok"`],
		["value", `return "x".repeat(${over})`],
		["error", `throw new Error("\\u0001".repeat(${over}))`],
		["image", `image("data:image/png;base64,iVBORw0KGgoA" + "A".repeat(${over})); return "drew"`],
	])(
		"replaces a script result whose %s is past the budget with one error, and the turn settles",
		async (_kind, code) => {
			const { events, seen } = await settlesWithin(code)
			const [ran] = events.filter((event) => event["type"] === "agent.tool_result")
			expect(ran).toMatchObject({ is_error: true })
			expect(seen).toContain(`the limit is ${SCRIPT_LIMITS.resultBytes}`)
			expect(seen).toContain("Write large output to a file in /workspace")
		},
	)

	it.each([
		[
			"passes too many argument bytes in one call",
			`await tools.lookup({ key: "x".repeat(${SCRIPT_LIMITS.callArgumentBytes + 1}) })\nreturn "finished"`,
			String(SCRIPT_LIMITS.callArgumentBytes),
		],
		[
			"passes too many argument bytes in total",
			`for (let index = 0; index < 3; index++) await tools.lookup({ key: "x".repeat(${SCRIPT_LIMITS.callArgumentBytes - 64}) })\nreturn "finished"`,
			String(SCRIPT_LIMITS.argumentBytes),
		],
		[
			"makes too many tool calls",
			`for (let index = 0; index < ${SCRIPT_LIMITS.toolCalls + 6}; index++) await tools.lookup({ key: String(index) })\nreturn "finished"`,
			`${SCRIPT_LIMITS.toolCalls} tool calls`,
		],
	])("ends a script that %s with its error, and the turn settles", async (_name, code, limit) => {
		const { events, seen } = await settlesWithin(code)
		const [ran] = events.filter((event) => event["type"] === "agent.tool_result")
		expect(ran).toMatchObject({ is_error: true })
		expect(seen).toContain("The script was stopped")
		expect(seen).toContain(limit)
		expect(seen).not.toContain("finished")
		expect(events.filter((event) => event["type"] === "agent.tool_use")).toHaveLength(1)
	})

	it("caps the output budget a script asks for, so Pi cuts and saves its text within one row", async () => {
		const code = `// @options: {"max_output_tokens": 1000000}\ntext("é".repeat(${4 * SCRIPT_LIMITS.maxOutputTokens + 50_000})); return "ok"`
		const surface = withSandbox([lookup])
		const { events, seen } = await settlesWithin(code, surface)
		expect(seen).toContain("[Full output: /workspace/.scripts/")
		const [ran] = events.filter((event) => event["type"] === "agent.tool_result")
		expect(ran?.["truncated"]).toBe(true)
		expect(
			[...surface.files.values()].some(
				(content) => typeof content === "string" && content.includes("é".repeat(1000)),
			),
		).toBe(true)
	})

	it("keeps a script's result when its full output cannot be saved", async () => {
		const code = `text("x".repeat(${4 * SCRIPT_LIMITS.maxOutputTokens + 50_000})); return "ok"`
		const seen: Array<string> = []
		const events = await runTurn(answering(seen, code), withSandbox([lookup], undefined, true))
		expect(events.at(-1)?.["type"]).toBe("agent.message")
		expect(seen.join("")).toContain("Could not save the full output")
		expect(seen.join("")).toContain("x".repeat(1000))
	})

	it("runs the code tool on its own in a round, so two scripts never race on the store", async () => {
		const surface = withSandbox([lookup])
		const tool = surface
			.registry()
			.snapshot()
			.tools()
			.find(({ tool: registered }) => registered.name === "codemode")
		expect(tool?.tool.executionMode).toBe("sequential")
		await surface.close()
	})

	it("keeps no store writes of multibyte text that would pass the store's budget", async () => {
		const half = Math.ceil(SCRIPT_LIMITS.storeBytes / 6) + 1
		const code = `store("a", "漢".repeat(${half})); store("b", "漢".repeat(${half})); return "kept"`
		const { events, seen } = await settlesWithin(code)
		const [ran] = events.filter((event) => event["type"] === "agent.tool_result")
		expect(ran).toMatchObject({ is_error: true })
		expect(seen).toContain("store() writes were not kept")
	})

	it("saves a small image to a file the script's result names", async () => {
		const code = `image("data:image/png;base64,iVBORw0KGgo="); return "drew"`
		const surface = withSandbox([lookup])
		const seen: Array<string> = []
		const events = await runTurn(answering(seen, code), surface)
		expect(events.at(-1)?.["type"]).toBe("agent.message")
		expect(seen.join("")).toContain("[Image saved to /workspace/.scripts/")
		const saved = [...surface.files.entries()].find(([path]) => path.endsWith(".png"))
		expect(saved?.[1]).toBeInstanceOf(Uint8Array)
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
