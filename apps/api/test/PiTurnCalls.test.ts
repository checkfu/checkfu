import { DatabaseSync } from "node:sqlite"
import type { SQLInputValue } from "node:sqlite"
import {
	boundToolEvents,
	toolCallCommandId,
	toolRecordsOf,
	toolResultCommandId,
	toolUseCommandId,
} from "@checkfu/domain/Session/RecordToolEvents"
import type { ToolRecord } from "@checkfu/domain/Session/RecordToolEvents"
import { MAX_TOOL_CALLS_PER_TURN } from "@checkfu/domain/Session/SessionTypes"
import type { ToolEvent } from "@checkfu/domain/Session/SessionTypes"
import { toolUseId } from "@checkfu/domain/Session/ToolEventBounds"
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
import { parkedCallLog } from "../src/Pi/PiParkedCalls.ts"
import { createCheckfuRegistry } from "../src/Pi/PiRefusals.ts"
import { turnCallLog } from "../src/Pi/PiTurnCalls.ts"
import { makeAssistantReply, makeScriptedPiModels } from "./helpers/ApiHarness.ts"
import { createInMemoryPiDurableBackend } from "./helpers/InMemoryPiBackend.ts"

const sqlLogs = () => {
	const db = new DatabaseSync(":memory:")
	const sql = {
		exec: (query: string, ...bindings: ReadonlyArray<unknown>) => {
			const statement = db.prepare(query)
			const values = bindings as ReadonlyArray<SQLInputValue>
			if (statement.columns().length > 0) {
				return statement.all(...values)
			}
			statement.run(...values)
			return []
		},
	}
	return { turns: turnCallLog(sql), scripts: parkedCallLog(sql) }
}
const sqlLog = () => sqlLogs().turns
const turnOne = () => {
	const { turns, scripts } = sqlLogs()
	return { turn: turns(1), script: scripts(1) }
}

describe("The calls a turn publishes", () => {
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

describe("The calls a script waited on", () => {
	it("keeps each turn's own, so a later turn neither reads nor removes an earlier one's", () => {
		const { scripts } = sqlLogs()
		const waited = {
			task_id: 3,
			script_task_id: 2,
			name: "lookup_order",
			content: [{ type: "text" as const, text: "order 7" }],
			is_error: false,
		}
		scripts(1).record(waited)
		scripts(2).record({ ...waited, content: [{ type: "text" as const, text: "order 9" }] })
		expect(scripts(1).forScript(2)).toEqual([
			{ task_id: 3, name: "lookup_order", content: waited.content, is_error: false },
		])
		expect(
			scripts(2)
				.forScript(2)
				.map((call) => call.content),
		).toEqual([[{ type: "text", text: "order 9" }]])
		expect(scripts(3).forScript(2)).toEqual([])
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
interface Inner {
	readonly kind: Kind
	readonly allow: boolean
}
interface Made extends Inner {
	readonly order: number
	readonly script?: ReadonlyArray<Inner>
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

const runTurn = (
	rounds: ReadonlyArray<ReadonlyArray<Made>>,
	{ turn: calls, script: scripts }: ReturnType<typeof turnOne>,
): Ran => {
	const transcript: Array<Entry> = []
	const log: Array<SessionFoldEvent> = [{ type: "session.status_running", turn: 1 }]
	const sent = new Map<string, string>()
	const fates = new Map<string, "ran" | "denied" | "refused">()
	const waited = new Set<string>()
	let task = 0
	const send = (id: string, body: unknown, events: ReadonlyArray<ToolEvent>) => {
		const text = JSON.stringify(body)
		const before = sent.get(id)
		if (before === undefined) {
			sent.set(id, text)
			log.push(...events.map(wire))
		} else {
			expect(text).toBe(before)
		}
	}
	const read = () => {
		const bounds = boundToolEvents(1, mcpToolOf, calls)
		for (const entry of transcript) {
			if ("use" in entry) {
				bounds.use(entry.use)
			} else {
				bounds.result(entry.result, scripts.forScript(entry.result.task_id))
			}
		}
		const events = bounds.events()
		const records = toolRecordsOf(events)
		expect(records.flatMap((record) => published(record).events)).toHaveLength(events.length)
		for (const record of records) {
			const { id, events: recorded } = published(record)
			send(id, record, recorded)
		}
	}
	interface Parked extends Inner {
		readonly task: number
		readonly parent?: number
		readonly settle: (text: string, is_error: boolean) => void
	}
	const pause = (parked: ReadonlyArray<Parked>) => {
		read()
		for (const call of parked) {
			if (call.parent !== undefined) {
				const script: ToolEvent = {
					type: "tool_use",
					tool_use_id: toolUseId(1, call.parent),
					name: "codemode",
					input: { n: call.parent },
				}
				send(toolUseCommandId(script.tool_use_id), script, [script])
			}
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
				call.settle("shipped", false)
			} else {
				log.push({
					type: "user.tool_confirmation",
					tool_use_id: id,
					result: call.allow ? "allow" : "deny",
				})
				fates.set(id, call.allow ? "ran" : "denied")
				call.settle(call.allow ? "deployed" : "The user denied this call.", !call.allow)
			}
		}
		log.push({ type: "session.status_running", turn: 1 })
	}
	const REFUSED = "This turn has recorded its limit of tool calls."
	const runScript = (script: number, inner: ReadonlyArray<Inner>) => {
		for (const call of inner) {
			const own = (task += 1)
			const id = toolUseId(1, own)
			const record = (text: string, is_error: boolean) => {
				scripts.record({
					task_id: own,
					script_task_id: script,
					name: NAMES[call.kind],
					content: [{ type: "text", text }],
					is_error,
				})
			}
			if (call.kind === "plain") {
				fates.set(id, "ran")
			} else if (calls.admit(script) && calls.admit(own)) {
				waited.add(id)
				pause([{ ...call, task: own, parent: script, settle: record }])
			} else {
				fates.set(id, "refused")
			}
		}
	}
	for (const round of rounds) {
		const made = round.map((call) => ({ ...call, task: (task += 1) }))
		for (const call of made) {
			transcript.push({
				use: {
					id: `c${call.task}`,
					name: call.script === undefined ? NAMES[call.kind] : "codemode",
					input: { n: call.task },
				},
			})
		}
		const parked: Array<Parked> = []
		const settle = (call: (typeof made)[number]) => (text: string, is_error: boolean) => {
			transcript.push({
				result: {
					id: `c${call.task}`,
					task_id: call.task,
					content: [{ type: "text", text }],
					is_error,
					...(waited.has(toolUseId(1, call.task)) ? { use_published: true as const } : {}),
				},
			})
		}
		for (const call of made.toSorted((a, b) => a.order - b.order)) {
			const id = toolUseId(1, call.task)
			if (call.script !== undefined) {
				runScript(call.task, call.script)
				fates.set(id, "ran")
				settle(call)("script done", false)
			} else if (call.kind === "plain") {
				fates.set(id, "ran")
				settle(call)("read", false)
			} else if (calls.admit(call.task)) {
				waited.add(id)
				parked.push({ ...call, settle: settle(call) })
			} else {
				fates.set(id, "refused")
				settle(call)(REFUSED, true)
			}
		}
		if (parked.length > 0) {
			pause(parked)
		}
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
const script = (...inner: ReadonlyArray<Kind>): Made => ({
	...made("plain"),
	script: inner.map((kind) => ({ kind, allow: true })),
})

describe("every tool use on the session log gets its outcome", () => {
	it("keeps the result of a call approved after the turn's other calls filled its limit", () => {
		const ran = runTurn(
			[Array.from({ length: MAX_TOOL_CALLS_PER_TURN }, () => made("plain")), [made("ask")]],
			turnOne(),
		)
		expectEveryUseHasItsOutcome(ran)
		expect([...ran.fates.values()].filter((fate) => fate === "refused")).toEqual([])
	})

	it("keeps the result of a script's call approved after the script's other calls filled the limit, and the script's own", () => {
		const many = Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 6 }, (): Kind => "plain")
		const ran = runTurn([[script(...many, "ask", "plain", "custom")]], turnOne())
		expectEveryUseHasItsOutcome(ran)
		expect(ran.waited.size).toBe(2)
		const late = runTurn(
			[[...many.map((kind) => made(kind)), made("custom")], [script("plain", "ask")]],
			turnOne(),
		)
		expectEveryUseHasItsOutcome(late)
		expect([...late.fates.values()].filter((fate) => fate === "refused")).toHaveLength(1)
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
			turnOne(),
		)
		expectEveryUseHasItsOutcome(ran)
		expect([...ran.fates.values()].filter((fate) => fate === "refused")).toHaveLength(2)
	})

	it("holds for any turn, well past the limit, whichever calls wait and whenever it is read", () => {
		const kind = fc.constantFrom<Kind>("plain", "plain", "plain", "ask", "custom")
		const inner = fc.record({ kind, allow: fc.boolean() })
		const call = fc.oneof(
			{ weight: 5, arbitrary: fc.record({ kind, allow: fc.boolean(), order: fc.nat(1000) }) },
			{
				weight: 1,
				arbitrary: fc.record({
					kind: fc.constant<Kind>("plain"),
					allow: fc.boolean(),
					order: fc.nat(1000),
					script: fc.array(inner, { maxLength: 90 }),
				}),
			},
		)
		const rounds = fc.array(fc.array(call, { minLength: 1, maxLength: 40 }), {
			minLength: 1,
			maxLength: 12,
		})
		fc.assert(
			fc.property(rounds, (turn) => {
				expectEveryUseHasItsOutcome(runTurn(turn, turnOne()))
			}),
			{ numRuns: 200 },
		)
	}, 120_000)
})
