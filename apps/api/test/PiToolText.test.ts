import { describe, expect, it } from "vitest"
import { MODEL_TEXT_LIMITS, boundModelOutput, boundModelText } from "../src/Pi/PiToolText.ts"

describe("A tool result's text within what Pi keeps", () => {
	it("leaves text that fits unchanged", () => {
		expect(boundModelText("short", "The result")).toBe("short")
	})

	it("never cuts a JSON document: one too large becomes a note asking for less", () => {
		const document = JSON.stringify(Array.from({ length: 10_000 }, (_, id) => ({ id })))
		const bounded = boundModelText(document, "The response")
		expect(bounded.startsWith("[The response is")).toBe(true)
		expect(bounded).toContain("Narrow the request")
		expect(bounded).not.toContain('"id"')
	})

	it("keeps whole first lines of other text and says how much more there was", () => {
		const text = Array.from({ length: 3000 }, (_, n) => `line ${n} 漢字`).join("\n")
		const bounded = boundModelText(text, "The result")
		const lines = bounded.split("\n")
		expect(lines.length).toBeLessThanOrEqual(MODEL_TEXT_LIMITS.maxLines)
		expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(MODEL_TEXT_LIMITS.maxBytes)
		expect(lines.slice(0, -1).every((line, n) => line === `line ${n} 漢字`)).toBe(true)
		expect(lines.at(-1)).toMatch(/^\[truncated: \d+ bytes more; narrow the request\]$/u)
	})

	it("cuts a single long line at a character boundary", () => {
		const bounded = boundModelText("😀".repeat(20_000), "The result")
		const head = bounded.split("\n")[0] ?? ""
		expect(head.length % 2).toBe(0)
		expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(MODEL_TEXT_LIMITS.maxBytes)
	})

	it("joins a result's text items and keeps its images", () => {
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" }
		const output = boundModelOutput(
			[
				{ type: "text", text: "x".repeat(40_000) },
				image,
				{ type: "text", text: "y".repeat(40_000) },
			],
			"The result",
		)
		expect(output.map((item) => item.type)).toEqual(["text", "image"])
		expect(output[0]?.type === "text" ? output[0].text : "").toContain("[truncated:")
	})
})
