import { describe, expect, it } from "@effect/vitest"
import { clampHarnessReply } from "../src/Session/Harness.external.ts"
import { boundToolCalls, clampToolCalls } from "../src/Session/RecordToolCalls.ts"
import {
	MAX_MESSAGE_TEXT_LENGTH,
	MAX_TOOL_CALLS_PER_TURN,
	MAX_TOOL_RESULT_TEXT_LENGTH,
} from "../src/Session/SessionTypes.ts"
import type { ToolEvent } from "../src/Session/SessionTypes.ts"
import { truncateText } from "../src/Session/TextBounds.ts"
import * as Effect from "effect/Effect"

const use = (id: string, name = "read"): ToolEvent => ({
	type: "tool_use",
	tool_use_id: id,
	name,
	input: {},
})
const result = (id: string, text: string): ToolEvent => ({
	type: "tool_result",
	tool_use_id: id,
	content: [{ type: "text", text }],
	is_error: false,
})

const hasLoneSurrogate = (text: string): boolean =>
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)

describe("Bounding a turn's tool calls", () => {
	it("drops the result of a call past the count limit that reuses a kept call's id", () => {
		const events: Array<ToolEvent> = []
		for (let index = 0; index < MAX_TOOL_CALLS_PER_TURN - 1; index++) {
			events.push(use(`call-${index}`), result(`call-${index}`, `r${index}`))
		}
		// The last kept call never gets a result; a later call, past the limit, reuses its id.
		events.push(
			use("dup", "kept"),
			use("dup", "past-limit"),
			result("dup", "not for the kept call"),
		)

		const bounds = boundToolCalls()
		for (const event of events) {
			bounds.add(event)
		}
		const calls = bounds.calls()
		expect(calls).toHaveLength(MAX_TOOL_CALLS_PER_TURN)
		expect(calls.at(-1)).toEqual({ _tag: "use", use: expect.objectContaining({ name: "kept" }) })
		// Nothing is left waiting, so a reader can stop here.
		expect(bounds.complete()).toBe(true)
	})

	it("gives a reused id's result to the newest call that used it", () => {
		const calls = clampToolCalls([use("a", "first"), use("a", "second"), result("a", "answer")])
		expect(calls).toEqual([
			{ _tag: "use", use: expect.objectContaining({ name: "first" }) },
			{
				_tag: "pair",
				use: expect.objectContaining({ name: "second" }),
				result: expect.objectContaining({ content: [{ type: "text", text: "answer" }] }),
			},
		])
	})

	it("never splits a character when it cuts a result", () => {
		const text = `${"x".repeat(MAX_TOOL_RESULT_TEXT_LENGTH - 1)}😀 after`
		const [call] = clampToolCalls([use("a"), result("a", text)])
		expect(call?._tag).toBe("pair")
		const cut = call?._tag === "pair" ? (call.result.content[0]?.text ?? "") : ""
		expect(cut).toBe("x".repeat(MAX_TOOL_RESULT_TEXT_LENGTH - 1))
		expect(hasLoneSurrogate(cut)).toBe(false)
		expect(call?._tag === "pair" ? call.result.truncated : undefined).toBe(true)
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
