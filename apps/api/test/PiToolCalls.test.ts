import {
	MAX_TOOL_CALLS_PER_TURN,
	MAX_TOOL_RESULT_TEXT_LENGTH,
	MAX_TURN_TOOL_TEXT_LENGTH,
} from "@checkfu/domain/Session/SessionTypes"
import type { EntryId, EntryRecord, Harness } from "@earendil-works/pi-durable"
import { describe, expect, it } from "@effect/vitest"
import { readTurnToolCalls } from "../src/Pi/PiDurableEngine.ts"

const CALLS = MAX_TOOL_CALLS_PER_TURN * 6
const USER_ENTRY = 1 as EntryId

// One assistant entry and one result entry per call, each result far over every bound.
const transcript: ReadonlyArray<EntryRecord> = Array.from({ length: CALLS }, (_, index) => [
	{
		id: (2 + index * 2) as EntryId,
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { n: index } }],
			},
		],
	},
	{
		id: (3 + index * 2) as EntryId,
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "read",
				content: [{ type: "text", text: "r".repeat(MAX_TOOL_RESULT_TEXT_LENGTH * 8) }],
				isError: false,
			},
		],
	},
])
	.flat()
	.map((entry) => entry as unknown as EntryRecord)

const fakePi = (pagesRead: { count: number }) =>
	({
		commit: async () => ({ type: "input", entry: USER_ENTRY, status: "done" }),
		conversation: async () => ({
			entries: async (_query: unknown, limit: number, cursor: number | undefined) => {
				pagesRead.count += 1
				const start = cursor ?? 0
				const items = transcript.slice(start, start + limit)
				const next = start + limit < transcript.length ? start + limit : undefined
				return { items, next }
			},
		}),
	}) as unknown as Harness

describe("Reading a settled turn's tool calls", () => {
	it("stops reading once the turn's bounds are full, and returns only bounded calls", async () => {
		const pagesRead = { count: 0 }
		const calls = await readTurnToolCalls(fakePi(pagesRead), "op-1")

		expect(calls).toHaveLength(MAX_TOOL_CALLS_PER_TURN)
		expect(calls.every((call) => call._tag === "pair")).toBe(true)
		const text = calls.reduce(
			(total, call) =>
				total +
				(call._tag === "pair"
					? call.result.content.reduce((sum, block) => sum + block.text.length, 0)
					: 0),
			0,
		)
		expect(text).toBeLessThanOrEqual(MAX_TURN_TOOL_TEXT_LENGTH)
		// Two entries per call: the reader stops a page after the last call it can record,
		// long before the end of a transcript six times that size.
		const pageSize = 8
		expect(pagesRead.count).toBeLessThanOrEqual(
			Math.ceil((MAX_TOOL_CALLS_PER_TURN * 2) / pageSize) + 1,
		)
		expect(pagesRead.count).toBeLessThan(transcript.length / pageSize)
	})
})
