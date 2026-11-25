import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import {
	actionsExtension,
	customToolsExtension,
	gateDecision,
	mcpPermission,
} from "../src/Pi/PiActions.ts"
import {
	abortOperation,
	answerPiDurableCall,
	pausePiDurableTurn,
	recoverPiDurableTurn,
	runPiDurableTurn,
} from "../src/Pi/PiDurableEngine.ts"
import { createCheckfuRegistry } from "../src/Pi/PiRefusals.ts"
import { makeAssistantReply, makeScriptedPiModels } from "./helpers/ApiHarness.ts"
import { createInMemoryPiDurableBackend } from "./helpers/InMemoryPiBackend.ts"
import { toolUseOf } from "@checkfu/domain/Session/ToolEventBounds"

const asks = (name: string) =>
	name === "mcp__docs__deploy"
		? { server: "docs", tool: "deploy", permission: "ask" as const }
		: name === "mcp__docs__search"
			? { server: "docs", tool: "search", permission: "allow" as const }
			: undefined

describe("the gate before a tool runs", () => {
	it("asks for a direct call to a tool that asks, and runs everything else", () => {
		expect(gateDecision({ name: "mcp__docs__deploy" }, asks)).toEqual({
			kind: "ask",
			server: "docs",
			tool: "deploy",
		})
		expect(gateDecision({ name: "mcp__docs__search" }, asks)).toEqual({ kind: "run" })
		expect(gateDecision({ name: "read" }, asks)).toEqual({ kind: "run" })
	})

	it("refuses a script's call to a tool that asks, telling the model to call it directly", () => {
		const decision = gateDecision(
			{ name: "mcp__docs__deploy", parent: { taskId: 7 as never, callId: "c1" } },
			asks,
		)
		expect(decision.kind).toBe("refuse")
		expect(decision.kind === "refuse" ? decision.message : "").toContain("Call it directly")
		expect(
			gateDecision(
				{ name: "mcp__docs__search", parent: { taskId: 7 as never, callId: "c1" } },
				asks,
			),
		).toEqual({ kind: "run" })
	})

	it("refuses a call whose tool name the pause could not publish, before it parks", () => {
		const long = "x".repeat(257)
		const toolOf = () => ({ server: "docs", tool: long, permission: "ask" as const })
		const decision = gateDecision({ name: "mcp__docs__alias" }, toolOf)
		expect(decision.kind).toBe("refuse")
		expect(decision.kind === "refuse" ? decision.message : "").toContain("name too long")
		expect(
			gateDecision({ name: "mcp__docs__alias" }, () => ({
				server: "docs",
				tool: "x".repeat(256),
				permission: "ask" as const,
			})).kind,
		).toBe("ask")
	})
})

describe("an MCP tool's permission", () => {
	const tool = { name: "search", annotations: { readOnlyHint: true } }
	it("runs a read-only tool and asks for any other, unless the agent says otherwise", () => {
		expect(mcpPermission([], "docs", tool)).toBe("allow")
		expect(mcpPermission([], "docs", { name: "deploy" })).toBe("ask")
		const toolset = {
			type: "mcp_toolset" as const,
			mcp_server_name: "docs",
			default_config: { permission_policy: { type: "always_allow" as const } },
			configs: [{ name: "search", permission_policy: { type: "always_ask" as const } }],
		}
		expect(mcpPermission([toolset], "docs", tool)).toBe("ask")
		expect(mcpPermission([toolset], "docs", { name: "deploy" })).toBe("allow")
		expect(mcpPermission([toolset], "other", { name: "deploy" })).toBe("ask")
	})
})

describe("an operation that waits on a custom tool", () => {
	const lookup = {
		type: "custom" as const,
		name: "lookup_order",
		description: "Looks an order up",
		input_schema: { type: "object", properties: { order: { type: "integer" } } },
	}
	const models = makeScriptedPiModels(async (model, context) => {
		const last = context.messages.at(-1)
		if (last?.role === "toolResult") {
			const text = last.content.map((part) => (part.type === "text" ? part.text : "")).join("")
			return makeAssistantReply(model, null, `saw ${text}`, 1, 1)
		}
		return {
			...makeAssistantReply(model, null, "", 2, 1),
			content: [{ type: "toolCall", id: "c1", name: "lookup_order", arguments: { order: "7" } }],
			stopReason: "toolUse",
		}
	})
	const open = async () => {
		const registry = createCheckfuRegistry()
		registry.install(customToolsExtension([lookup]))
		registry.install(actionsExtension(() => undefined))
		return createInMemoryPiDurableBackend(models, undefined, registry)
	}
	const request = {
		operationId: "turn:1",
		turn: 1,
		provider: "openai" as const,
		modelId: "gpt-4o-mini",
		system: null,
		text: "look it up",
	}

	it("reports the parked call with its checked arguments, and settles once it is answered", async () => {
		const backend = await open()
		try {
			const paused = await Effect.runPromise(runPiDurableTurn(backend, request))
			expect(paused).toMatchObject({
				ok: "paused",
				calls: [
					{ awaits: "result", name: "lookup_order", mcp_server_name: "", input: { order: 7 } },
				],
			})
			const id = paused.ok === "paused" ? paused.calls[0]!.tool_use_id : ""
			expect(toolUseOf(id)).toMatchObject({ turn: 1 })
			expect(await Effect.runPromise(pausePiDurableTurn(backend, "turn:1", id))).toEqual({
				input_tokens: 2,
				output_tokens: 1,
			})
			expect(
				await Effect.runPromise(
					answerPiDurableCall(backend, id, { type: "result", text: "shipped", is_error: false }),
				),
			).toBe("delivered")
			const settled = await Effect.runPromise(recoverPiDurableTurn(backend, "turn:1"))
			expect(settled).toMatchObject({
				ok: true,
				reply: { text: "saw shipped", input_tokens: 1, output_tokens: 1 },
			})
			expect(
				await Effect.runPromise(
					answerPiDurableCall(backend, id, { type: "result", text: "again", is_error: false }),
				),
			).toBe("gone")
		} finally {
			await backend.close()
		}
	})

	it("stops a waiting operation by its run's task, never by aborting the whole conversation", async () => {
		const backend = await open()
		try {
			await Effect.runPromise(runPiDurableTurn(backend, request))
			const pi = await backend.pi()
			const guarded = {
				commit: pi.commit.bind(pi),
				abortSubmission: pi.abortSubmission.bind(pi),
				snapshot: pi.snapshot.bind(pi),
				abortTask: pi.abortTask.bind(pi),
				conversation: () => Promise.reject(new Error("the whole conversation was aborted")),
			} as unknown as typeof pi
			expect(await abortOperation(guarded, "turn:1")).toBe(true)
			const settled = await Effect.runPromise(recoverPiDurableTurn(backend, "turn:1"))
			expect(settled).toMatchObject({ ok: false, error: { _tag: "TurnInterrupted" } })
		} finally {
			await backend.close()
		}
	})
})
