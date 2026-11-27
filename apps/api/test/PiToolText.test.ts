import { utf8ByteLength } from "@earendil-works/chord/output"
import { describe, expect, it } from "@effect/vitest"
import { MODEL_TEXT_LIMITS, boundModelText } from "../src/Pi/PiToolText.ts"

const subject = "The result of lookup"

const keepsBeginning = (text: string, prefix: string): void => {
	const bounded = boundModelText(text, subject)
	expect(bounded.startsWith(prefix)).toBe(true)
	expect(bounded.split("\n").at(-1)).toMatch(/^\[truncated: /u)
	expect(utf8ByteLength(bounded)).toBeLessThanOrEqual(MODEL_TEXT_LIMITS.maxBytes)
	expect(bounded).not.toContain("of JSON")
}

describe("tool text shown to the model", () => {
	it("leaves a short result unchanged", () => {
		const text = "[INFO] one line\n[x] another"
		expect(boundModelText(text, subject)).toBe(text)
	})

	it("keeps the beginning of a large log with bracketed levels", () => {
		const first = `[INFO] ${"reading the next page ".repeat(3)}`
		keepsBeginning(`${first}\n`.repeat(1000), first)
	})

	it("keeps the beginning of a large task list", () => {
		const line = `- [x] ${"record changes ".repeat(4)}\n`
		keepsBeginning(`[x] done\n${line.repeat(1000)}`, "[x] done")
	})

	it("names the byte limit for oversized JSON", () => {
		const text = JSON.stringify(["x".repeat(60_000)])
		expect(boundModelText(text, subject)).toContain(
			`more than the ${MODEL_TEXT_LIMITS.maxBytes} bytes`,
		)
	})

	it("names the line limit for JSON that fits the byte limit", () => {
		const text = JSON.stringify(
			Array.from({ length: 2500 }, () => 1),
			null,
			2,
		)
		expect(utf8ByteLength(text)).toBeLessThan(MODEL_TEXT_LIMITS.maxBytes)
		const bounded = boundModelText(text, subject)
		expect(bounded).toContain(`more than the ${MODEL_TEXT_LIMITS.maxLines} lines`)
		expect(bounded).not.toContain(String(MODEL_TEXT_LIMITS.maxBytes))
	})

	it("keeps the beginning of an incomplete JSON document", () => {
		keepsBeginning(`["${"x".repeat(60_000)}`, '["')
	})
})
