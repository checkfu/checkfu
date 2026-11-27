import * as Effect from "effect/Effect"
import { describe, expect, it, vi } from "vitest"
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
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search"
import { makeSessionMcp } from "../src/Pi/PiMcpSession.ts"
import { createCheckfuRegistry } from "../src/Pi/PiRefusals.ts"
import { makeAssistantReply, makeScriptedPiModels } from "./helpers/ApiHarness.ts"
import { createInMemoryPiDurableBackend } from "./helpers/InMemoryPiBackend.ts"
import type { InMemoryPiDurableBackend } from "./helpers/InMemoryPiBackend.ts"
import {
	measurePause,
	observePauseWait,
	reportPauseMeasurement,
	waitForPauseProbe,
} from "./helpers/PiPauseProbe.ts"
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

	it("refuses approval in an automation session and allows tools that do not need it", () => {
		expect(gateDecision({ name: "mcp__docs__deploy" }, asks, true)).toMatchObject({
			kind: "refuse",
			message: expect.stringContaining("started by an automation"),
		})
		expect(gateDecision({ name: "mcp__docs__search" }, asks, true)).toEqual({ kind: "run" })
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
	it("asks for all tools by default, including tools marked as read-only", () => {
		expect(mcpPermission([], "docs", tool)).toBe("ask")
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
	const models = (ready?: Promise<void>) =>
		makeScriptedPiModels(async (model, context) => {
			const last = context.messages.at(-1)
			if (last?.role === "toolResult") {
				const text = last.content.map((part) => (part.type === "text" ? part.text : "")).join("")
				return makeAssistantReply(model, null, `saw ${text}`, 1, 1)
			}
			if (ready !== undefined) {
				await ready
			}
			return {
				...makeAssistantReply(model, null, "", 2, 1),
				content: [{ type: "toolCall", id: "c1", name: "lookup_order", arguments: { order: "7" } }],
				stopReason: "toolUse",
			}
		})
	const open = (ready?: Promise<void>) => {
		const registry = createCheckfuRegistry()
		registry.install(customToolsExtension([lookup]))
		registry.install(actionsExtension(() => undefined))
		return createInMemoryPiDurableBackend(models(ready), undefined, registry)
	}
	const request = {
		operationId: "turn:1",
		unpublishedOperationIds: [],
		turn: 1,
		provider: "openai" as const,
		modelId: "gpt-4o-mini",
		system: null,
		text: "look it up",
	}
	const recordPark = async (backend: InMemoryPiDurableBackend, now: () => number) => {
		const parked = Promise.withResolvers<number>()
		const watcher = (await backend.pi()).observeCommits({
			advance: ({ changes }) => {
				if (
					changes.some(
						(change) =>
							change.type === "task" &&
							change.value.kind === "pi.tool" &&
							change.value.state.status === "sleeping",
					)
				) {
					parked.resolve(now())
				}
			},
			end: () => undefined,
		})
		return { parked: parked.promise, detach: () => watcher.detach() }
	}

	it.each(["fresh", "recovery"] as const)(
		"counts a pending ordinary tool on a %s wait",
		async (path) => {
			const entered = Promise.withResolvers<void>()
			const release = Promise.withResolvers<void>()
			const registry = createCheckfuRegistry()
			registry.install({
				name: "hold-tool",
				tools: [
					{
						name: "hold_tool",
						description: "Hold a fixture call until released.",
						parameters: { type: "object", properties: {} },
						replay: "safe",
						execute: async () => {
							entered.resolve()
							await release.promise
							return { output: [{ type: "text", text: "finished" }] }
						},
					},
				],
			})
			const backend = await createInMemoryPiDurableBackend(
				makeScriptedPiModels(async (model, context) =>
					context.messages.at(-1)?.role === "toolResult"
						? makeAssistantReply(model, null, "done", 1, 1)
						: {
								...makeAssistantReply(model, null, "", 1, 1),
								content: [{ type: "toolCall", id: "call_probe", name: "hold_tool", arguments: {} }],
								stopReason: "toolUse",
							},
				),
				undefined,
				registry,
			)
			const observer = await observePauseWait(backend, path, request)
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				const wait = await observer.start()
				try {
					await waitForPauseProbe(entered.promise, "starting the ordinary tool")
					const before = wait.counts()
					let previous = 0
					for (const elapsed of [1000, 10_000, 30_000]) {
						await vi.advanceTimersByTimeAsync(elapsed - previous)
						previous = elapsed
						const counts = wait.counts()
						reportPauseMeasurement({
							path,
							workload: "ordinary tool",
							elapsed,
							atWait: wait.atWait,
							before,
							...counts,
						})
						expect(counts.submissionReads - before.submissionReads).toBe(elapsed / 100)
						expect(counts.inspections - before.inspections).toBe(elapsed / 100)
					}
					release.resolve()
					expect(await wait.result()).toMatchObject({ ok: true })
				} finally {
					release.resolve()
					await wait.stop()
				}
			} finally {
				release.resolve()
				vi.useRealTimers()
				observer.restore()
				await backend.close()
			}
		},
		15_000,
	)

	it.each(["fresh", "recovery"] as const)(
		"detects a parked action on a %s wait",
		async (path) => {
			for (const offset of [0, 101]) {
				const release = Promise.withResolvers<void>()
				const backend = await open(release.promise)
				const observer = await observePauseWait(backend, path, request)
				const watch = await recordPark(backend, () => Date.now())
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
				try {
					const wait = await observer.start()
					try {
						const started = Date.now()
						await vi.advanceTimersByTimeAsync(offset)
						release.resolve()
						const parked = await waitForPauseProbe(watch.parked, "observing the sleeping tool")
						await vi.advanceTimersByTimeAsync(100 - (offset % 100))
						expect(await wait.result()).toMatchObject({
							ok: "paused",
							calls: [{ name: lookup.name }],
						})
						const counts = wait.counts()
						reportPauseMeasurement({
							path,
							workload: "custom action",
							parkedAtMs: parked - started,
							detectedAtMs: Date.now() - started,
							...counts,
						})
						expect(parked - started).toBe(offset)
						expect(counts).toMatchObject({
							inspections: Math.floor(offset / 100) + 1,
							waitAborts: 1,
							turnAborts: 0,
						})
					} finally {
						release.resolve()
						await wait.stop()
					}
				} finally {
					release.resolve()
					vi.useRealTimers()
					watch.detach()
					observer.restore()
					await backend.close()
				}
			}
		},
		15_000,
	)

	it.runIf(measurePause)(
		"measures real pause wakeup latency",
		async () => {
			for (const path of ["fresh", "recovery"] as const) {
				for (const offsetMs of [10, 90, 110]) {
					for (let repetition = 1; repetition <= 5; repetition++) {
						const release = Promise.withResolvers<void>()
						const backend = await open(release.promise)
						const observer = await observePauseWait(backend, path, request)
						const watch = await recordPark(backend, () => performance.now())
						try {
							const wait = await observer.start()
							try {
								const began = performance.now()
								const cpuStart = process.cpuUsage()
								await new Promise<void>((resolve) => {
									setTimeout(resolve, offsetMs)
								})
								release.resolve()
								const parked = await waitForPauseProbe(watch.parked, "observing the sleeping tool")
								const outcome = await wait.result()
								const detected = performance.now()
								const cpu = process.cpuUsage(cpuStart)
								expect(outcome).toMatchObject({ ok: "paused" })
								reportPauseMeasurement({
									path,
									workload: "custom action realtime",
									offsetMs,
									repetition,
									parkedAtMs: Number((parked - began).toFixed(3)),
									wakeMs: Number((detected - parked).toFixed(3)),
									cpuUserUs: cpu.user,
									cpuSystemUs: cpu.system,
									...wait.counts(),
								})
							} finally {
								release.resolve()
								await wait.stop()
							}
						} finally {
							release.resolve()
							watch.detach()
							observer.restore()
							await backend.close()
						}
					}
				}
			}
		},
		30_000,
	)

	it("recovers an MCP approval with its original catalog, then admits the refreshed tool", async () => {
		const kept = new Map<string, string>()
		const executed: Array<string> = []
		let clock = 0
		let turn = 1
		let advertised = "first"
		let listings = 0
		const mcpTurn = {
			networking: null,
			servers: [
				{
					name: "docs",
					url: "https://example.test/mcp",
					vault_id: "vlt_1",
					credential_id: "cred_1",
				},
			],
		}
		const build = async (storage?: InMemoryPiDurableBackend["storage"]) => {
			const mcp = makeSessionMcp({
				kv: { get: (key) => kept.get(key), put: (key, value) => kept.set(key, value) },
				now: () => clock,
				admittedTurn: () => turn,
				agentTools: () => [
					{
						type: "mcp_toolset",
						mcp_server_name: "docs",
						default_config: { permission_policy: { type: "always_ask" } },
						configs: [{ name: "second", permission_policy: { type: "always_allow" } }],
					},
				],
				vaults: {
					list: async () => {
						listings++
						return {
							ok: true,
							tools: [
								{ name: advertised, description: "Test tool", inputSchema: { type: "object" } },
							],
						}
					},
					call: async (_vault, _credential, _url, tool) => {
						executed.push(tool.name)
						return { ok: true, content: [{ type: "text", text: tool.name }], isError: false }
					},
				},
			})
			const registry = createCheckfuRegistry()
			const install = () => {
				for (const extension of mcp.extensions()) {
					registry.install(extension)
				}
			}
			install()
			registry.install(createToolSearchExtension())
			registry.install(actionsExtension((name) => mcp.toolOf(name)))
			const scripted = makeScriptedPiModels(async (model, context) => {
				const last = context.messages.at(-1)
				if (last?.role === "toolResult" && last.toolName !== "tool_search") {
					return makeAssistantReply(
						model,
						null,
						last.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
						1,
						1,
					)
				}
				return {
					...makeAssistantReply(model, null, "", 1, 1),
					content: [
						last?.role === "toolResult"
							? {
									type: "toolCall",
									name: `mcp__docs__${advertised}`,
									id: `c${turn}`,
									arguments: {},
								}
							: {
									type: "toolCall",
									name: "tool_search",
									id: `s${turn}`,
									arguments: { query: advertised },
								},
					],
					stopReason: "toolUse",
				}
			})
			const backend = await createInMemoryPiDurableBackend(scripted, 1, registry, undefined, {
				...(storage === undefined ? {} : { storage }),
				mcpToolOf: (name) => mcp.toolOf(name),
				publishMcp: async (req) => mcp.publish(req.turn, mcpTurn) && mcp.undiscovered(),
			})
			return {
				...backend,
				discoverMcp: async (req: { turn: number }, signal?: AbortSignal) => {
					await mcp.discover(req.turn, signal)
					install()
				},
			}
		}
		const first = await build()
		const outcome = await Effect.runPromise(runPiDurableTurn(first, request))
		expect(outcome, JSON.stringify(outcome)).toMatchObject({
			ok: "paused",
			calls: [{ awaits: "confirmation", name: "first" }],
		})
		if (outcome.ok !== "paused") {
			throw new Error("Expected an approval")
		}
		const id = outcome.calls[0]!.tool_use_id
		first.retire()
		clock = 300_000
		advertised = "second"
		const second = await build(first.storage)
		try {
			expect(
				await Effect.runPromise(recoverPiDurableTurn(second, request.operationId)),
			).toMatchObject({ ok: "paused", calls: [{ tool_use_id: id }] })
			expect(
				await Effect.runPromise(
					answerPiDurableCall(second, id, { type: "confirmation", allow: true, deny_message: "" }),
				),
			).toBe("delivered")
			expect(
				await Effect.runPromise(recoverPiDurableTurn(second, request.operationId)),
			).toMatchObject({ ok: true, reply: { text: "first" } })
			expect([listings, executed]).toEqual([1, ["first"]])
			turn = 2
			expect(
				await Effect.runPromise(
					runPiDurableTurn(second, { ...request, turn, operationId: "turn:2" }),
				),
			).toMatchObject({ ok: true, reply: { text: "second" } })
			expect([listings, executed]).toEqual([2, ["first", "second"]])
		} finally {
			await second.close()
		}
	})

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
