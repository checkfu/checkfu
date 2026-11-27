import { DatabaseSync } from "node:sqlite"
import type { SQLInputValue } from "node:sqlite"
import {
	boundToolEvents,
	toolCallCommandId,
	toolRecordsOf,
	toolResultCommandId,
} from "@checkfu/domain/Session/RecordToolEvents"
import type { ToolRecord, TurnCalls } from "@checkfu/domain/Session/RecordToolEvents"
import { MAX_TOOL_CALLS_PER_TURN } from "@checkfu/domain/Session/SessionTypes"
import type { ToolEvent } from "@checkfu/domain/Session/SessionTypes"
import { toolUseId, turnCalls } from "@checkfu/domain/Session/ToolEventBounds"
import { emptySessionFold, foldSessionEvents } from "@checkfu/sdk"
import type { SessionFoldEvent } from "@checkfu/sdk"
import * as Effect from "effect/Effect"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { actionsExtension, customToolsExtension } from "../src/Pi/PiActions.ts"
import {
	answerPiDurableCall,
	recoverPiDurableTurn,
	runPiDurableTurn,
} from "../src/Pi/PiDurableEngine.ts"
import { createCheckfuRegistry } from "../src/Pi/PiRefusals.ts"
import { turnCallLog } from "../src/Pi/PiTurnCalls.ts"
import { makeAssistantReply, makeScriptedPiModels } from "./helpers/ApiHarness.ts"
import { createInMemoryPiDurableBackend } from "./helpers/InMemoryPiBackend.ts"

const sqlLog = (db = new DatabaseSync(":memory:")) =>
	turnCallLog({
		exec: (query, ...bindings) => {
			const statement = db.prepare(query)
			const values = bindings as ReadonlyArray<SQLInputValue>
			if (statement.columns().length > 0) {
				return statement.all(...values)
			}
			statement.run(...values)
			return []
		},
	})

describe("The calls a turn publishes", () => {
	it("admits the same task ids in the durable and in-memory logs", () => {
		const atCapacity = Array.from(
			{ length: MAX_TOOL_CALLS_PER_TURN + 1 },
			(_, index) => MAX_TOOL_CALLS_PER_TURN - index,
		)
		fc.assert(
			fc.property(
				fc.array(fc.nat(2 * MAX_TOOL_CALLS_PER_TURN), { minLength: 1, maxLength: 300 }),
				(ids) => {
					using db = new DatabaseSync(":memory:")
					const durable = sqlLog(db)(1)
					const memory = turnCalls()

					for (const id of ids) {
						expect(durable.admit(id), `task ${id}`).toBe(memory.admit(id))
					}
					expect(durable.admitted()).toEqual(memory.admitted().toSorted((a, b) => a - b))
					expect(durable.admitted()).toHaveLength(
						Math.min(new Set(ids).size, MAX_TOOL_CALLS_PER_TURN),
					)
				},
			),
			{ numRuns: 200, examples: [[atCapacity.concat(atCapacity.toReversed())]] },
		)
	})

	it("gives a call its place once, and no more places than a turn's limit", () => {
		const log = sqlLog()
		const calls = log(1)
		const first = Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 9 }, (_, index) =>
			calls.admit(1000 - index),
		)
		expect(first.filter(Boolean)).toHaveLength(MAX_TOOL_CALLS_PER_TURN)
		expect(first.slice(0, MAX_TOOL_CALLS_PER_TURN).every(Boolean)).toBe(true)
		const again = Array.from({ length: first.length }, (_, index) =>
			calls.admit(1000 - (first.length - 1 - index)),
		).toReversed()
		expect(again).toEqual(first)
		expect(calls.admitted()).toHaveLength(MAX_TOOL_CALLS_PER_TURN)

		const next = log(2)
		expect(next.admitted()).toEqual([])
		expect(next.admit(1000)).toBe(true)
		expect(calls.admit(7)).toBe(false)
		expect(calls.admitted()).toHaveLength(MAX_TOOL_CALLS_PER_TURN)
		expect(next.admitted()).toEqual([1000])
	})
})

describe("a turn whose calls wait past its limit", () => {
	const lookup = {
		type: "custom" as const,
		name: "lookup_order",
		description: "Looks an order up",
		input_schema: { type: "object", properties: { order: { type: "integer" } } },
	}
	const asked = MAX_TOOL_CALLS_PER_TURN + 3
	const seen: Array<string> = []
	const models = makeScriptedPiModels(async (model, context) => {
		const results = context.messages.filter((message) => message.role === "toolResult")
		if (results.length > 0) {
			seen.splice(
				0,
				seen.length,
				...results.map((message) =>
					message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
				),
			)
			return makeAssistantReply(model, null, "done", 1, 1)
		}
		return {
			...makeAssistantReply(model, null, "", 2, 1),
			content: Array.from({ length: asked }, (_, order) => ({
				type: "toolCall" as const,
				id: `c${order}`,
				name: "lookup_order",
				arguments: { order },
			})),
			stopReason: "toolUse",
		}
	})

	it("refuses the calls no place is left for before they park, and publishes a result for every call that waited", async () => {
		const log = sqlLog()
		const calls = log(1)
		const registry = createCheckfuRegistry()
		registry.install(customToolsExtension([lookup]))
		registry.install(
			actionsExtension(
				() => undefined,
				calls,
				(name) => name === lookup.name,
			),
		)
		const backend = await createInMemoryPiDurableBackend(models, undefined, registry, undefined, {
			turnCalls: log,
		})
		try {
			const paused = await Effect.runPromise(
				runPiDurableTurn(backend, {
					operationId: "turn:1",
					unpublishedOperationIds: [],
					turn: 1,
					provider: "openai" as const,
					modelId: "gpt-4o-mini",
					system: null,
					text: "look them all up",
				}),
			)
			expect(paused.ok).toBe("paused")
			const waiting = paused.ok === "paused" ? paused.calls.map((call) => call.tool_use_id) : []
			expect(waiting).toHaveLength(MAX_TOOL_CALLS_PER_TURN)
			expect(paused.ok === "paused" ? (paused.tool_events ?? []) : undefined).toEqual([])

			for (const id of waiting) {
				expect(
					await Effect.runPromise(
						answerPiDurableCall(backend, id, { type: "result", text: `r ${id}`, is_error: false }),
					),
				).toBe("delivered")
			}
			const settled = await Effect.runPromise(recoverPiDurableTurn(backend, "turn:1"))
			expect(settled).toMatchObject({ ok: true, reply: { text: "done" } })
			const events = settled !== null && settled.ok === true ? (settled.tool_events ?? []) : []
			expect(events.every((event) => event.type === "tool_result")).toBe(true)
			expect(events.map((event) => event.tool_use_id).toSorted()).toEqual(waiting.toSorted())
			expect(seen.filter((text) => text.includes("its limit"))).toHaveLength(
				asked - MAX_TOOL_CALLS_PER_TURN,
			)
			expect(seen.filter((text) => text.startsWith("r tu_"))).toHaveLength(MAX_TOOL_CALLS_PER_TURN)

			const next = log(2)
			expect(next.admit(1)).toBe(true)
			const late = await Effect.runPromise(recoverPiDurableTurn(backend, "turn:1"))
			expect(late).toEqual(settled)
			expect(next.admitted()).toEqual([1])
			expect(calls.admitted()).toHaveLength(MAX_TOOL_CALLS_PER_TURN)
		} finally {
			await backend.close()
		}
	})
})

type Kind = "plain" | "ask" | "custom"
interface Made {
	readonly kind: Kind
	readonly allow: boolean
	readonly order: number
}

type Entry =
	| { readonly use: { readonly id: string; readonly name: string; readonly input: { n: number } } }
	| {
			readonly result: {
				readonly id: string
				readonly task_id: number
				readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
				readonly is_error: boolean
				readonly use_published?: true
			}
	  }

const NAMES: Record<Kind, string> = {
	plain: "read",
	ask: "mcp__docs__deploy",
	custom: "lookup_order",
}
const mcpToolOf = (name: string) =>
	name === NAMES.ask ? { server: "docs", tool: "deploy", permission: "ask" as const } : undefined

const wire = (event: ToolEvent): SessionFoldEvent =>
	event.type === "tool_use"
		? event.mcp_server_name === undefined
			? {
					type: "agent.tool_use",
					tool_use_id: event.tool_use_id,
					name: event.name,
					input: event.input,
				}
			: {
					type: "agent.mcp_tool_use",
					tool_use_id: event.tool_use_id,
					name: event.name,
					input: event.input,
					mcp_server_name: event.mcp_server_name,
				}
		: {
				type: event.mcp === true ? "agent.mcp_tool_result" : "agent.tool_result",
				tool_use_id: event.tool_use_id,
				content: [...event.content],
				is_error: event.is_error,
				...(event.truncated === true ? { truncated: true as const } : {}),
			}

const published = (
	record: ToolRecord,
): { readonly id: string; readonly events: Array<ToolEvent> } =>
	record.type === "result"
		? { id: toolResultCommandId(record.result.tool_use_id), events: [record.result] }
		: {
				id: toolCallCommandId(record.call.tool_use_id),
				events: [
					{
						type: "tool_use",
						tool_use_id: record.call.tool_use_id,
						name: record.call.name,
						input: record.call.input,
						...(record.call.input_truncated === true ? { truncated: true as const } : {}),
						...(record.call.mcp_server_name === undefined
							? {}
							: { mcp_server_name: record.call.mcp_server_name }),
					},
					{
						type: "tool_result",
						tool_use_id: record.call.tool_use_id,
						content: record.call.content,
						is_error: record.call.is_error,
						...(record.call.result_truncated === true ? { truncated: true as const } : {}),
						...(record.call.mcp_server_name === undefined ? {} : { mcp: true as const }),
					},
				],
			}

interface Ran {
	readonly log: ReadonlyArray<SessionFoldEvent>
	readonly fates: ReadonlyMap<string, "ran" | "denied" | "refused">
	readonly waited: ReadonlySet<string>
}

const runTurn = (rounds: ReadonlyArray<ReadonlyArray<Made>>, calls: TurnCalls): Ran => {
	const transcript: Array<Entry> = []
	const log: Array<SessionFoldEvent> = [{ type: "session.status_running", turn: 1 }]
	const sent = new Map<string, string>()
	const fates = new Map<string, "ran" | "denied" | "refused">()
	const waited = new Set<string>()
	let task = 0
	const read = () => {
		const bounds = boundToolEvents(1, mcpToolOf, calls)
		for (const entry of transcript) {
			if ("use" in entry) {
				bounds.use(entry.use)
			} else {
				bounds.result(entry.result)
			}
		}
		const events = bounds.events()
		const records = toolRecordsOf(events)
		expect(records.flatMap((record) => published(record).events)).toHaveLength(events.length)
		for (const record of records) {
			const { id, events: recorded } = published(record)
			const body = JSON.stringify(record)
			const before = sent.get(id)
			if (before === undefined) {
				sent.set(id, body)
				log.push(...recorded.map(wire))
			} else {
				expect(body).toBe(before)
			}
		}
	}
	for (const round of rounds) {
		const made = round.map((call) => ({ ...call, task: (task += 1) }))
		for (const call of made) {
			transcript.push({
				use: { id: `c${call.task}`, name: NAMES[call.kind], input: { n: call.task } },
			})
		}
		const parked: Array<(typeof made)[number]> = []
		const settle = (call: (typeof made)[number], text: string, is_error: boolean) =>
			transcript.push({
				result: {
					id: `c${call.task}`,
					task_id: call.task,
					content: [{ type: "text", text }],
					is_error,
					...(waited.has(toolUseId(1, call.task)) ? { use_published: true as const } : {}),
				},
			})
		for (const call of made.toSorted((a, b) => a.order - b.order)) {
			const id = toolUseId(1, call.task)
			if (call.kind === "plain") {
				fates.set(id, "ran")
				settle(call, "read", false)
			} else if (calls.admit(call.task)) {
				waited.add(id)
				parked.push(call)
			} else {
				fates.set(id, "refused")
				settle(call, "This turn has recorded its limit of tool calls.", true)
			}
		}
		if (parked.length === 0) {
			continue
		}
		read()
		for (const call of parked) {
			log.push(
				call.kind === "ask"
					? {
							type: "agent.mcp_tool_use",
							tool_use_id: toolUseId(1, call.task),
							name: "deploy",
							mcp_server_name: "docs",
							input: { n: call.task },
							evaluated_permission: "ask",
						}
					: {
							type: "agent.custom_tool_use",
							tool_use_id: toolUseId(1, call.task),
							name: NAMES.custom,
							input: { n: call.task },
						},
			)
		}
		log.push({
			type: "session.status_idle",
			turn: 1,
			stop_reason: {
				type: "requires_action",
				event_ids: parked.map((call) => toolUseId(1, call.task)),
			},
		})
		for (const call of parked) {
			const id = toolUseId(1, call.task)
			if (call.kind === "custom") {
				log.push({
					type: "user.custom_tool_result",
					custom_tool_use_id: id,
					content: [{ type: "text", text: "shipped" }],
				})
				fates.set(id, "ran")
				settle(call, "shipped", false)
			} else {
				log.push({
					type: "user.tool_confirmation",
					tool_use_id: id,
					result: call.allow ? "allow" : "deny",
				})
				fates.set(id, call.allow ? "ran" : "denied")
				settle(call, call.allow ? "deployed" : "The user denied this call.", !call.allow)
			}
		}
		log.push({ type: "session.status_running", turn: 1 })
	}
	read()
	log.push({
		type: "session.status_idle",
		turn: 1,
		stop_reason: { type: "end_turn" },
	})
	return { log, fates, waited }
}

const isUse = (event: SessionFoldEvent) =>
	event.type === "agent.tool_use" ||
	event.type === "agent.mcp_tool_use" ||
	event.type === "agent.custom_tool_use"
const isResult = (event: SessionFoldEvent) =>
	event.type === "agent.tool_result" || event.type === "agent.mcp_tool_result"
const idOf = (event: SessionFoldEvent): string =>
	"tool_use_id" in event && typeof event.tool_use_id === "string" ? event.tool_use_id : ""

const expectEveryUseHasItsOutcome = ({ log, fates, waited }: Ran) => {
	const uses = log.filter(isUse).map(idOf)
	const results = log.filter(isResult).map(idOf)
	expect(new Set(uses).size).toBe(uses.length)
	expect(new Set(results).size).toBe(results.length)
	expect(results.toSorted()).toEqual(uses.toSorted())
	expect(uses.length).toBeLessThanOrEqual(MAX_TOOL_CALLS_PER_TURN)
	for (const id of waited) {
		expect(uses).toContain(id)
	}
	for (const [id, fate] of fates) {
		if (fate === "refused") {
			expect(uses).not.toContain(id)
		}
	}
	const fold = foldSessionEvents(emptySessionFold("all"), log)
	expect(fold.turn.status).toBe("settled")
	for (const [id, call] of fold.calls) {
		expect(call.status, `${id} ${fates.get(id)}`).toBe(
			fates.get(id) === "denied" ? "denied" : "done",
		)
	}
	expect(fold.calls.size).toBe(uses.length)
}

const made = (kind: Kind, allow = true, order = 0): Made => ({ kind, allow, order })

describe("every tool use on the session log gets its outcome", () => {
	it("keeps the result of a call approved after the turn's other calls filled its limit", () => {
		const ran = runTurn(
			[Array.from({ length: MAX_TOOL_CALLS_PER_TURN }, () => made("plain")), [made("ask")]],
			sqlLog()(1),
		)
		expectEveryUseHasItsOutcome(ran)
		expect([...ran.fates.values()].filter((fate) => fate === "refused")).toEqual([])
	})

	it("refuses a call that would wait once every place is taken, and publishes nothing for it", () => {
		const ran = runTurn(
			[
				[made("ask")],
				[
					...Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 6 }, () => made("plain")),
					made("custom"),
				],
				[made("ask"), made("custom")],
				[made("plain")],
			],
			sqlLog()(1),
		)
		expectEveryUseHasItsOutcome(ran)
		expect([...ran.fates.values()].filter((fate) => fate === "refused")).toHaveLength(2)
	})

	it("holds for any turn, well past the limit, whichever calls wait and whenever it is read", () => {
		const call = fc.record({
			kind: fc.constantFrom<Kind>("plain", "plain", "plain", "ask", "custom"),
			allow: fc.boolean(),
			order: fc.nat(1000),
		})
		const rounds = fc.array(fc.array(call, { minLength: 1, maxLength: 40 }), {
			minLength: 1,
			maxLength: 12,
		})
		fc.assert(
			fc.property(rounds, (turn) => {
				expectEveryUseHasItsOutcome(runTurn(turn, sqlLog()(1)))
			}),
			{ numRuns: 200 },
		)
	}, 120_000)
})
