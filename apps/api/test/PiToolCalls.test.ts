import { REJECTED_KEY } from "../src/Pi/PiRejection.ts"
import {
	MAX_TOOL_CALLS_PER_TURN,
	MAX_TOOL_RESULT_TEXT_LENGTH,
	MAX_TURN_TOOL_TEXT_LENGTH,
} from "@checkfu/domain/Session/SessionTypes"
import type { EntryId, EntryRecord, Harness, TaskId } from "@earendil-works/pi-durable"
import { describe, expect, it } from "@effect/vitest"
import type * as Schema from "effect/Schema"
import { readTurnEntries, readTurnToolEvents } from "../src/Pi/PiDurableEngine.ts"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"

const USER_ENTRY = 1 as EntryId
const GENERATION = 900

const toolCalls = (
	id: EntryId,
	calls: ReadonlyArray<readonly [string, Schema.JsonObject]>,
	stopReason = "toolUse",
) => ({
	id,
	kind: "pi.assistant",
	byTaskId: GENERATION as TaskId,
	model: [
		{
			role: "assistant",
			stopReason,
			content: calls.map(([callId, input]) => ({
				type: "toolCall",
				id: callId,
				name: "read",
				arguments: input,
			})),
		},
	],
})

const toolCall = (id: EntryId, callId: string, input: Schema.JsonObject, stopReason = "toolUse") =>
	toolCalls(id, [[callId, input]], stopReason)

const userEntry = (id: EntryId) => ({
	id,
	kind: "pi.user",
	model: [{ role: "user", content: "next", timestamp: 0 }],
})

const toolResult = (
	id: EntryId,
	callId: string,
	task: number | undefined,
	text: string,
	diagnostics: ReadonlyArray<{ severity: string; message: string; code?: string }> = [],
) => ({
	id,
	kind: "pi.tool-result",
	...(task === undefined ? {} : { byTaskId: task as TaskId }),
	model: [
		{
			role: "toolResult",
			toolCallId: callId,
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
		},
	],
	data: { diagnostics },
})

interface Query {
	readonly minEntryId?: number
	readonly maxEntryId?: number
	readonly order?: "ascending" | "descending"
}

const fakePi = (
	entries: ReadonlyArray<unknown>,
	options: { readonly pagesRead?: { count: number }; readonly record?: unknown } = {},
) => {
	const transcript = entries
		.map((entry) => entry as EntryRecord)
		.toSorted((left, right) => left.id - right.id)
	return {
		commit: async () => options.record ?? { type: "input", entry: USER_ENTRY, status: "done" },
		conversation: async () => ({
			entries: async (query: Query, limit: number, cursor: number | undefined) => {
				const ascending = query.order === "ascending"
				if (ascending && options.pagesRead !== undefined) {
					options.pagesRead.count += 1
				}
				const matching = transcript.filter(
					(entry) =>
						(query.minEntryId === undefined || entry.id >= query.minEntryId) &&
						(query.maxEntryId === undefined || entry.id <= query.maxEntryId),
				)
				const ordered = ascending ? matching : matching.toReversed()
				const start = cursor ?? 0
				const next = start + limit < ordered.length ? start + limit : undefined
				return { items: ordered.slice(start, start + limit), next }
			},
		}),
	} as unknown as Harness
}

describe("Reading a settled turn's tool events", () => {
	it("names each call after the Pi task that ran it, even when the provider reused its id", async () => {
		const events = await readTurnToolEvents(
			fakePi([
				toolCall(2 as EntryId, "same", { round: 1 }),
				toolResult(3 as EntryId, "same", 11, "first"),
				toolCall(4 as EntryId, "same", { round: 2 }),
				toolResult(5 as EntryId, "same", 14, "second"),
				toolCall(6 as EntryId, "orphan", {}),
				toolResult(7 as EntryId, "orphan", undefined, "?"),
			]),
			"op-1",
			5,
		)
		expect(events.map((event) => `${event.type}:${event.tool_use_id}`)).toEqual([
			"tool_use:tu_5_11",
			"tool_result:tu_5_11",
			"tool_use:tu_5_14",
			"tool_result:tu_5_14",
		])
	})

	it("says a result was cut when Pi cut it, however short the text that is left", async () => {
		const kept = "ok\n".repeat(2000)
		expect(kept.length).toBeLessThan(MAX_TOOL_RESULT_TEXT_LENGTH)
		const events = await readTurnToolEvents(
			fakePi([
				toolCall(2 as EntryId, "cut", {}),
				toolResult(3 as EntryId, "cut", 11, kept, [
					{
						severity: "warn",
						code: "truncated",
						message: "Output truncated to its beginning: 3000 lines, 9000 bytes dropped",
					},
				]),
				toolCall(4 as EntryId, "whole", {}),
				toolResult(5 as EntryId, "whole", 12, kept, [{ severity: "info", message: "took 2s" }]),
			]),
			"op-1",
			5,
		)
		const results = events.flatMap((event) => (event.type === "tool_result" ? [event] : []))
		expect(results.map((event) => [event.tool_use_id, event.truncated])).toEqual([
			["tu_5_11", true],
			["tu_5_12", undefined],
		])
	})

	it("says a result was cut when an image in it was left out of the event", async () => {
		const image = toolResult(3 as EntryId, "shot", 21, "")
		const events = await readTurnToolEvents(
			fakePi([
				toolCall(2 as EntryId, "shot", {}),
				{
					...image,
					model: [
						{
							...image.model[0],
							content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
						},
					],
				},
			]),
			"op-1",
			5,
		)
		const results = events.flatMap((event) => (event.type === "tool_result" ? [event] : []))
		expect(results.map((event) => [event.tool_use_id, event.truncated])).toEqual([
			["tu_5_21", true],
		])
	})

	it("says a call did not run only when Checkfu marked it, never from a bare code", async () => {
		const failed = (code: string) => [{ severity: "error", code, message: "Pi wrote this" }]
		const marked = (entry: ReturnType<typeof toolResult>, reason: string) => ({
			...entry,
			model: entry.model.map((message) => ({ ...message, details: { [REJECTED_KEY]: reason } })),
		})
		const events = await readTurnToolEvents(
			fakePi([
				toolCall(2 as EntryId, "gone", {}),
				marked(toolResult(3 as EntryId, "gone", 31, "", failed("tool_unavailable")), "unavailable"),
				toolCall(4 as EntryId, "bad", {}),
				marked(
					toolResult(5 as EntryId, "bad", 32, "", failed("invalid_arguments")),
					"invalid_arguments",
				),
				toolCall(6 as EntryId, "stopped", {}),
				marked(toolResult(7 as EntryId, "stopped", 33, "", failed("blocked")), "blocked"),
				toolCall(8 as EntryId, "ran", {}),
				toolResult(9 as EntryId, "ran", 34, "the tool said no", [
					{ severity: "error", message: "exit 1" },
				]),
				toolCall(10 as EntryId, "old", {}),
				toolResult(11 as EntryId, "old", 35, "", failed("blocked")),
			]),
			"op-1",
			5,
		)
		const results = events.flatMap((event) => (event.type === "tool_result" ? [event] : []))
		expect(results.map((event) => [event.tool_use_id, event.rejected])).toEqual([
			["tu_5_31", "unavailable"],
			["tu_5_32", "invalid_arguments"],
			["tu_5_33", "blocked"],
			["tu_5_34", undefined],
			["tu_5_35", undefined],
		])
	})

	it("reserves calls only from a message that started a tool round, so a retry's call is not lost", async () => {
		const events = await readTurnToolEvents(
			fakePi([
				toolCall(2 as EntryId, "dup", { attempt: 1 }, "error"),
				toolCall(3 as EntryId, "dup", { attempt: 2 }, "aborted"),
				toolCall(4 as EntryId, "dup", { attempt: 3 }),
				toolResult(5 as EntryId, "dup", 41, "ran"),
			]),
			"op-1",
			5,
		)
		expect(events).toEqual([
			{ type: "tool_use", tool_use_id: "tu_5_41", name: "read", input: { attempt: 3 } },
			{
				type: "tool_result",
				tool_use_id: "tu_5_41",
				content: [{ type: "text", text: "ran" }],
				is_error: false,
			},
		])
	})

	it("forgets a call whose task left no result once the next round starts, so a reused id is kept", async () => {
		const events = await readTurnToolEvents(
			fakePi([
				toolCall(2 as EntryId, "again", { round: 1 }),
				toolCall(3 as EntryId, "again", { round: 2 }),
				toolResult(4 as EntryId, "again", 61, "second round"),
			]),
			"op-1",
			5,
		)
		expect(events).toEqual([
			{ type: "tool_use", tool_use_id: "tu_5_61", name: "read", input: { round: 2 } },
			{
				type: "tool_result",
				tool_use_id: "tu_5_61",
				content: [{ type: "text", text: "second round" }],
				is_error: false,
			},
		])
		const within = await readTurnToolEvents(
			fakePi([
				toolCalls(2 as EntryId, [
					["same", { n: 1 }],
					["same", { n: 2 }],
				]),
				toolResult(3 as EntryId, "same", 71, "one"),
				toolResult(4 as EntryId, "same", 72, "two"),
			]),
			"op-1",
			5,
		)
		expect(within).toEqual([])
	})

	it("leaves out the calls of an aborted round that never started, and keeps the one that ran", async () => {
		const aborted = [{ severity: "error", code: "aborted", message: "Tool read was aborted" }]
		const events = await readTurnToolEvents(
			fakePi([
				toolCalls(2 as EntryId, [
					["first", { n: 1 }],
					["second", { n: 2 }],
					["third", { n: 3 }],
				]),
				toolResult(3 as EntryId, "first", 51, "ran"),
				toolResult(4 as EntryId, "second", GENERATION, "", aborted),
				toolResult(5 as EntryId, "third", GENERATION, "", aborted),
			]),
			"op-1",
			5,
		)
		expect(events.map((event) => `${event.type}:${event.tool_use_id}`)).toEqual([
			"tool_use:tu_5_51",
			"tool_result:tu_5_51",
		])
	})

	it("keeps reading after a handoff the run wrote, and stops at a reset that ends the turn", async () => {
		const handoff = {
			id: 4 as EntryId,
			kind: "pi.reset",
			byTaskId: GENERATION as TaskId,
			model: [{ role: "user", content: "continue in a new context", timestamp: 0 }],
		}
		const plainReset = { id: 4 as EntryId, kind: "pi.reset" }
		const transcript = (reset: unknown) => [
			toolCall(2 as EntryId, "before", {}),
			toolResult(3 as EntryId, "before", 71, "first"),
			reset,
			toolCall(5 as EntryId, "after", {}),
			toolResult(6 as EntryId, "after", 72, "second"),
			userEntry(7 as EntryId),
		]
		const ids = async (reset: unknown) =>
			(await readTurnToolEvents(fakePi(transcript(reset)), "op-1", 5)).map(
				(event) => `${event.type}:${event.tool_use_id}`,
			)
		expect(await ids(handoff)).toEqual([
			"tool_use:tu_5_71",
			"tool_result:tu_5_71",
			"tool_use:tu_5_72",
			"tool_result:tu_5_72",
		])
		expect(await ids(plainReset)).toEqual(["tool_use:tu_5_71", "tool_result:tu_5_71"])
	})

	it("reads a tool-terminated round's results after its answer entry, and stops at the next turn", async () => {
		const events = await readTurnToolEvents(
			fakePi(
				[
					toolCall(2 as EntryId, "last", {}),
					toolResult(3 as EntryId, "last", 61, "done"),
					userEntry(4 as EntryId),
					toolCall(5 as EntryId, "later", {}),
					toolResult(6 as EntryId, "later", 62, "another turn"),
				],
				{ record: { type: "input", entry: USER_ENTRY, status: "done", answer: 2 } },
			),
			"op-1",
			5,
		)
		expect(events.map((event) => `${event.type}:${event.tool_use_id}`)).toEqual([
			"tool_use:tu_5_61",
			"tool_result:tu_5_61",
		])
	})

	it("walks one turn the same way for both readers, past a failed attempt, a compaction and a handoff", async () => {
		const compaction = {
			id: 5 as EntryId,
			kind: "pi.compaction",
			model: [{ role: "user", content: "summary", timestamp: 0 }],
			data: { reason: "threshold" },
		}
		const handoff = {
			id: 6 as EntryId,
			kind: "pi.reset",
			byTaskId: GENERATION as TaskId,
			model: [{ role: "user", content: "continue in a new context", timestamp: 0 }],
		}
		const pi = fakePi(
			[
				toolCall(2 as EntryId, "failed", {}, "error"),
				toolCall(3 as EntryId, "first", {}),
				toolResult(4 as EntryId, "first", 81, "one"),
				compaction,
				handoff,
				toolCall(7 as EntryId, "last", {}),
				toolResult(8 as EntryId, "last", 82, "two"),
				userEntry(9 as EntryId),
				toolCall(10 as EntryId, "next turn", {}),
				toolResult(11 as EntryId, "next turn", 83, "three"),
			],
			{ record: { type: "input", entry: USER_ENTRY, status: "done", answer: 7 } },
		)
		const events = await readTurnToolEvents(pi, "op-1", 5)
		expect(events.map((event) => `${event.type}:${event.tool_use_id}`)).toEqual([
			"tool_use:tu_5_81",
			"tool_result:tu_5_81",
			"tool_use:tu_5_82",
			"tool_result:tu_5_82",
		])
		const conversation = await pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
		if (conversation === undefined) {
			throw new Error("The fake has no conversation.")
		}
		const read = await readTurnEntries(conversation, USER_ENTRY)
		expect(read.ids).toEqual([1, 2, 3, 4, 7, 8])
		expect(read.compaction?.id).toBe(5)
	})

	it("stops reading once the turn's bounds are full, and returns only bounded events", async () => {
		const calls = MAX_TOOL_CALLS_PER_TURN * 6
		const transcript = Array.from({ length: calls }, (_, index) => [
			toolCall((2 + index * 2) as EntryId, `call-${index}`, { n: index }),
			toolResult(
				(3 + index * 2) as EntryId,
				`call-${index}`,
				100 + index,
				"r".repeat(MAX_TOOL_RESULT_TEXT_LENGTH * 8),
			),
		]).flat()
		const pagesRead = { count: 0 }
		const events = await readTurnToolEvents(fakePi(transcript, { pagesRead }), "op-1", 5)

		expect(events.filter((event) => event.type === "tool_use")).toHaveLength(
			MAX_TOOL_CALLS_PER_TURN,
		)
		const text = events.reduce(
			(total, event) =>
				total +
				(event.type === "tool_result"
					? event.content.reduce((sum, block) => sum + block.text.length, 0)
					: 0),
			0,
		)
		expect(text).toBeLessThanOrEqual(MAX_TURN_TOOL_TEXT_LENGTH)
		const pageSize = 8
		expect(pagesRead.count).toBeLessThanOrEqual(
			Math.ceil((MAX_TOOL_CALLS_PER_TURN * 2) / pageSize) + 1,
		)
		expect(pagesRead.count).toBeLessThan(transcript.length / pageSize)
	})
})
