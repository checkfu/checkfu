import { describe, expect, it } from "@effect/vitest"
import { clampHarnessReply } from "../src/Session/Harness.external.ts"
import {
	boundToolEvents,
	toolCallCommandId,
	toolCallsOf,
	toolRecordsOf,
	toolResultCommandId,
	toolUseId,
	toolUseOf,
	turnCalls,
} from "../src/Session/RecordToolEvents.ts"
import type { TranscriptToolResult, TranscriptToolUse } from "../src/Session/RecordToolEvents.ts"
import {
	MAX_MESSAGE_TEXT_LENGTH,
	MAX_TOOL_CALLS_PER_TURN,
	MAX_TOOL_INPUT_JSON_LENGTH,
	MAX_TOOL_RESULT_TEXT_LENGTH,
	MAX_TURN_TOOL_TEXT_LENGTH,
	NO_TOOL_USE_IDS,
	addToolUseId,
	decodeToolUseIds,
	removeToolUseId,
} from "../src/Session/SessionTypes.ts"
import type { ToolEvent } from "../src/Session/SessionTypes.ts"
import { truncateText } from "../src/Session/TextBounds.ts"
import * as Effect from "effect/Effect"

const use = (
	id: string,
	name = "read",
	input: TranscriptToolUse["input"] = {},
): TranscriptToolUse => ({
	id,
	name,
	input,
})
const result = (id: string, task: number, text: string): TranscriptToolResult => ({
	id,
	task_id: task,
	content: [{ type: "text", text }],
	is_error: false,
})

type Step = { readonly use: TranscriptToolUse } | { readonly result: TranscriptToolResult }

const bound = (steps: ReadonlyArray<Step>, turn = 1) => {
	const bounds = boundToolEvents(turn)
	for (const step of steps) {
		if ("use" in step) {
			bounds.use(step.use)
		} else {
			bounds.result(step.result)
		}
	}
	return bounds
}

const textOf = (events: ReadonlyArray<ToolEvent>): number =>
	events.reduce(
		(total, event) =>
			total +
			(event.type === "tool_use"
				? event.truncated === true
					? 0
					: JSON.stringify(event.input).length
				: event.content.reduce((sum, block) => sum + block.text.length, 0)),
		0,
	)

const hasLoneSurrogate = (text: string): boolean =>
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)

describe("Bounding a turn's tool events", () => {
	it("publishes each call under the task that ran it, also when the provider reuses its id", () => {
		const events = bound([
			{ use: use("same", "read", { round: 1 }) },
			{ result: result("same", 7, "first") },
			{ use: use("same", "read", { round: 2 }) },
			{ result: result("same", 9, "second") },
		]).events()
		expect(events).toEqual([
			{ type: "tool_use", tool_use_id: "tu_1_7", name: "read", input: { round: 1 } },
			{
				type: "tool_result",
				tool_use_id: "tu_1_7",
				content: [{ type: "text", text: "first" }],
				is_error: false,
			},
			{ type: "tool_use", tool_use_id: "tu_1_9", name: "read", input: { round: 2 } },
			{
				type: "tool_result",
				tool_use_id: "tu_1_9",
				content: [{ type: "text", text: "second" }],
				is_error: false,
			},
		])
		expect(toolUseId(1, 7)).not.toBe(toolUseId(1, 9))
	})

	it("names a call by its turn and its task, so a task number used again in a later turn is another call", () => {
		const before = bound([{ use: use("a") }, { result: result("a", 1, "before the loss") }], 3)
		const after = bound([{ use: use("a") }, { result: result("a", 1, "after the loss") }], 4)
		const ids = [...toolCallsOf(before.events()), ...toolCallsOf(after.events())].map(
			(call) => call.tool_use_id,
		)
		expect(ids).toEqual(["tu_3_1", "tu_4_1"])
		expect(new Set(ids.map(toolCallCommandId)).size).toBe(2)
		const again = bound([{ use: use("a") }, { result: result("a", 1, "before the loss") }], 3)
		expect(toolCallsOf(again.events()).map((call) => toolCallCommandId(call.tool_use_id))).toEqual([
			toolCallCommandId("tu_3_1"),
		])
	})

	it("reads back the turn and task of an id it wrote, and nothing from any other text", () => {
		expect(toolUseOf(toolUseId(12, 345))).toEqual({ turn: 12, task_id: 345 })
		for (const text of [
			"",
			"tu_1",
			"tu_1_2_3",
			"tu_01_2",
			"tu_1_-2",
			"tu_1_2.5",
			"tu__2",
			"tx_1_2",
			"tu_1_x",
		]) {
			expect(toolUseOf(text)).toBeUndefined()
		}
	})

	it("states each call as one record with one command id, fixed by the call", () => {
		const events = bound([
			{ use: use("a") },
			{ result: result("a", 3, "x") },
			{ use: use("b") },
			{ result: result("b", 5, "y") },
		]).events()
		const calls = toolCallsOf(events)
		expect(calls.map((call) => call.tool_use_id)).toEqual(["tu_1_3", "tu_1_5"])
		expect(calls.map((call) => toolCallCommandId(call.tool_use_id))).toEqual([
			"tool:call:tu_1_3",
			"tool:call:tu_1_5",
		])
		expect(calls[0]?.content).toEqual([{ type: "text", text: "x" }])
		expect(calls.length * 2).toBe(events.length)
	})

	it("leaves out an event that has no partner, since it is not a call", () => {
		const [used, answered] = bound([{ use: use("a") }, { result: result("a", 3, "x") }]).events()
		expect(used === undefined ? [] : toolCallsOf([used])).toEqual([])
		expect(answered === undefined ? [] : toolCallsOf([answered])).toEqual([])
	})

	it("publishes a call only once Pi has recorded its result, in the order the calls were made", () => {
		const events = bound([
			{ use: use("a") },
			{ use: use("b") },
			{ result: result("b", 2, "B") },
			{ use: use("c") },
		]).events()
		expect(events.map((event) => `${event.type}:${event.tool_use_id}`)).toEqual([
			"tool_use:tu_1_2",
			"tool_result:tu_1_2",
		])
		const both = bound([
			{ use: use("a") },
			{ use: use("b") },
			{ result: result("b", 2, "B") },
			{ result: result("a", 1, "A") },
		]).events()
		expect(both.map((event) => `${event.type}:${event.tool_use_id}`)).toEqual([
			"tool_use:tu_1_1",
			"tool_result:tu_1_1",
			"tool_use:tu_1_2",
			"tool_result:tu_1_2",
		])
	})

	it("publishes neither call when two in flight share a provider id, since their results cannot be told apart", () => {
		const events = bound([
			{ use: use("same", "read", { file: "a" }) },
			{ use: use("same", "write", { file: "b" }) },
			{ result: result("same", 3, "for one of them") },
			{ result: result("same", 4, "for the other") },
			{ use: use("same", "read", { file: "c" }) },
			{ result: result("same", 5, "c") },
		]).events()
		expect(events.map((event) => `${event.type}:${event.tool_use_id}`)).toEqual([
			"tool_use:tu_1_5",
			"tool_result:tu_1_5",
		])
	})

	it("gives a place to the call a result names, never to a call that got none", () => {
		const steps: Array<Step> = []
		for (let index = 0; index < MAX_TOOL_CALLS_PER_TURN - 1; index++) {
			steps.push({ use: use(`call-${index}`) }, { result: result(`call-${index}`, index + 1, "r") })
		}
		steps.push(
			{ use: use("dup", "unanswered") },
			{ use: use("dup", "ambiguous") },
			{ result: result("dup", 1000, "for one of the two") },
			{ use: use("late", "answered") },
			{ result: result("late", 1001, "for the call that ran") },
			{ use: use("later", "past-limit") },
			{ result: result("later", 1002, "left out") },
		)
		const bounds = bound(steps)
		const events = bounds.events()
		const names = events.filter((event) => event.type === "tool_use")
		expect(names).toHaveLength(MAX_TOOL_CALLS_PER_TURN)
		expect(names.at(-1)).toMatchObject({ name: "answered", tool_use_id: toolUseId(1, 1001) })
		expect(
			names.some((event) => ["unanswered", "ambiguous", "past-limit"].includes(event.name)),
		).toBe(false)
		expect(events.some((event) => event.tool_use_id === toolUseId(1, 1000))).toBe(false)
		expect(events.some((event) => event.tool_use_id === toolUseId(1, 1002))).toBe(false)
		expect(bounds.complete()).toBe(true)
		expect(bounds.events().filter((event) => event.type === "tool_use")).toHaveLength(
			MAX_TOOL_CALLS_PER_TURN,
		)
	})

	it("gives a call that ran the place and the text of calls whose reservations were discarded", () => {
		const bounds = boundToolEvents(1)
		const wide = { text: "x".repeat(MAX_TOOL_INPUT_JSON_LENGTH - 20) }
		for (let index = 0; index < MAX_TOOL_CALLS_PER_TURN; index++) {
			bounds.use(use(`orphan-${index}`, "read", wide))
			bounds.round()
		}
		for (let index = 0; index < MAX_TOOL_CALLS_PER_TURN; index++) {
			bounds.use(use(`twin-${index}`, "read", wide))
			bounds.use(use(`twin-${index}`, "read", wide))
		}
		bounds.round()
		expect(bounds.complete()).toBe(false)
		bounds.use(use("ran", "read", wide))
		bounds.result(result("ran", 7, "done"))
		expect(bounds.events()).toEqual([
			{ type: "tool_use", tool_use_id: "tu_1_7", name: "read", input: wide },
			{
				type: "tool_result",
				tool_use_id: "tu_1_7",
				content: [{ type: "text", text: "done" }],
				is_error: false,
			},
		])
	})

	it("publishes the result of a call whose use is on the log, however many calls came first", () => {
		const calls = turnCalls()
		const waited = [5000, 5001]
		waited.forEach((task) => expect(calls.admit(task)).toBe(true))
		const bounds = boundToolEvents(1, undefined, calls)
		for (let index = 0; index < MAX_TOOL_CALLS_PER_TURN + 10; index++) {
			bounds.use(use(`call-${index}`))
			bounds.result(result(`call-${index}`, index + 1, "r"))
		}
		expect(bounds.complete()).toBe(false)
		for (const task of waited) {
			bounds.use(use(`waited-${task}`, "deploy"))
			bounds.result({ ...result(`waited-${task}`, task, "deployed"), use_published: true })
		}
		const events = bounds.events()
		for (const task of waited) {
			const own = events.filter((event) => event.tool_use_id === toolUseId(1, task))
			expect(own).toEqual([
				{
					type: "tool_result",
					tool_use_id: toolUseId(1, task),
					content: [{ type: "text", text: "deployed" }],
					is_error: false,
				},
			])
		}
		expect(events.filter((event) => event.type === "tool_use")).toHaveLength(
			MAX_TOOL_CALLS_PER_TURN - waited.length,
		)
		expect(bounds.complete()).toBe(true)
	})

	it("publishes a result whose use is marked published even when no place is recorded for it", () => {
		const calls = turnCalls()
		for (let task = 1; task <= MAX_TOOL_CALLS_PER_TURN; task++) {
			calls.admit(task)
		}
		const bounds = boundToolEvents(1, undefined, calls)
		bounds.use(use("waited", "deploy"))
		bounds.result({ ...result("waited", 900, "deployed"), use_published: true })
		expect(bounds.events().map((event) => `${event.type}:${event.tool_use_id}`)).toEqual([
			`tool_result:${toolUseId(1, 900)}`,
		])
	})

	it("records a waited call's result alone, and every other call whole, each under one id", () => {
		const bounds = boundToolEvents(1)
		bounds.use(use("plain"))
		bounds.result(result("plain", 3, "x"))
		bounds.use(use("waited", "deploy"))
		bounds.result({ ...result("waited", 5, "deployed"), use_published: true })
		const events = bounds.events()
		const records = toolRecordsOf(events)

		expect(
			records.map((record) =>
				record.type === "call"
					? toolCallCommandId(record.call.tool_use_id)
					: toolResultCommandId(record.result.tool_use_id),
			),
		).toEqual(["tool:call:tu_1_3", "tool:result:tu_1_5"])
		expect(records[1]).toMatchObject({
			type: "result",
			result: { tool_use_id: "tu_1_5", content: [{ type: "text", text: "deployed" }] },
		})
		expect(toolCallsOf(events).map((call) => call.tool_use_id)).toEqual(["tu_1_3"])
		expect(toolRecordsOf(events)).toEqual(records)
	})

	it("records nothing for a use that has no result yet", () => {
		const [used] = boundToolEvents(1).events()
		expect(used).toBeUndefined()
		expect(
			toolRecordsOf([{ type: "tool_use", tool_use_id: "tu_1_1", name: "read", input: {} }]),
		).toEqual([])
	})

	it("keeps a published call's result when the turn's text is spent, cut to nothing and marked", () => {
		const calls = turnCalls()
		calls.admit(900)
		const bounds = boundToolEvents(1, undefined, calls)
		for (let index = 0; index < MAX_TOOL_CALLS_PER_TURN - 1; index++) {
			bounds.use(use(`c-${index}`))
			bounds.result(result(`c-${index}`, index + 1, "z".repeat(MAX_TOOL_RESULT_TEXT_LENGTH)))
		}
		bounds.use(use("waited", "deploy"))
		bounds.result({ ...result("waited", 900, "deployed"), use_published: true })
		expect(bounds.events().at(-1)).toEqual({
			type: "tool_result",
			tool_use_id: toolUseId(1, 900),
			content: [],
			is_error: false,
			truncated: true,
		})
		expect(textOf(bounds.events())).toBeLessThanOrEqual(MAX_TURN_TOOL_TEXT_LENGTH)
	})

	it("gives a call one answer for good, and a turn no more places than its limit", () => {
		const calls = turnCalls()
		const answers = Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 20 }, (_, task) =>
			calls.admit(task),
		)
		expect(answers.filter(Boolean)).toHaveLength(MAX_TOOL_CALLS_PER_TURN)
		expect(Array.from({ length: answers.length }, (_, task) => calls.admit(task))).toEqual(answers)
		expect(calls.admitted()).toHaveLength(MAX_TOOL_CALLS_PER_TURN)
	})

	it("cuts and marks oversized inputs and results, keeps a mark the transcript carried, and stays within the turn's text", () => {
		const events = bound([
			{ use: use("a", "probe", { text: "x".repeat(MAX_TOOL_INPUT_JSON_LENGTH) }) },
			{ result: result("a", 1, "y".repeat(MAX_TOOL_RESULT_TEXT_LENGTH + 1)) },
			{ use: { ...use("b"), truncated: true } },
			{ result: { ...result("b", 2, "short"), truncated: true } },
		]).events()
		expect(events[0]).toEqual({
			type: "tool_use",
			tool_use_id: "tu_1_1",
			name: "probe",
			input: {},
			truncated: true,
		})
		expect(events[1]).toMatchObject({ truncated: true })
		expect(events[2]).toMatchObject({ truncated: true, input: {} })
		expect(events[3]).toMatchObject({ truncated: true, content: [{ type: "text", text: "short" }] })

		const many = bound(
			Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 3 }, (_, index): Array<Step> => [
				{ use: use(`c-${index}`) },
				{ result: result(`c-${index}`, index + 1, "z".repeat(MAX_TOOL_RESULT_TEXT_LENGTH)) },
			]).flat(),
		).events()
		expect(many.filter((event) => event.type === "tool_use")).toHaveLength(MAX_TOOL_CALLS_PER_TURN)
		expect(textOf(many)).toBeLessThanOrEqual(MAX_TURN_TOOL_TEXT_LENGTH)
	})

	it("never splits a character when it cuts a result", () => {
		const text = `${"x".repeat(MAX_TOOL_RESULT_TEXT_LENGTH - 1)}😀 after`
		const [, answered] = bound([{ use: use("a") }, { result: result("a", 1, text) }]).events()
		const cut = answered?.type === "tool_result" ? (answered.content[0]?.text ?? "") : ""
		expect(cut).toBe("x".repeat(MAX_TOOL_RESULT_TEXT_LENGTH - 1))
		expect(hasLoneSurrogate(cut)).toBe(false)
		expect(answered).toMatchObject({ truncated: true })
	})
})

describe("Cutting text", () => {
	it("keeps a valid prefix at every length around a surrogate pair", () => {
		const text = "ab😀cd"
		for (let length = 0; length <= text.length + 1; length++) {
			const cut = truncateText(text, length)
			expect(hasLoneSurrogate(cut)).toBe(false)
			expect(text.startsWith(cut)).toBe(true)
			expect(cut.length).toBeGreaterThanOrEqual(Math.min(length, text.length) - 1)
		}
	})

	it.effect("never splits a character when it cuts a reply", () =>
		Effect.gen(function* () {
			const reply = yield* clampHarnessReply({
				thinking: null,
				text: `${"y".repeat(MAX_MESSAGE_TEXT_LENGTH - 1)}😀`,
				input_tokens: 1,
				output_tokens: 1,
				stop_reason: { type: "end_turn" },
			})
			expect(reply.truncated).toBe(true)
			expect(reply.text).toBe("y".repeat(MAX_MESSAGE_TEXT_LENGTH - 1))
		}),
	)
})

describe("The calls a turn waits on", () => {
	it("keeps each call once, in the order asked, until it is answered", () => {
		const asked = ["tu_b", "tu_a", "tu_b"].reduce(addToolUseId, NO_TOOL_USE_IDS)
		expect(decodeToolUseIds(asked)).toEqual(["tu_b", "tu_a"])
		expect(decodeToolUseIds(removeToolUseId(asked, "tu_b"))).toEqual(["tu_a"])
		expect(decodeToolUseIds(removeToolUseId(asked, "tu_c"))).toEqual(["tu_b", "tu_a"])
		expect(removeToolUseId(removeToolUseId(asked, "tu_a"), "tu_b")).toBe(NO_TOOL_USE_IDS)
	})
})
