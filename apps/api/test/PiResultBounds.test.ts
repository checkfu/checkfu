import { describe, expect, it } from "@effect/vitest"
import {
	RESULT_BUDGET_BYTES,
	STORAGE_ROW_BYTES,
	boundResult,
	boundResultDetails,
	boundResultImages,
	serializedBytes,
} from "../src/Pi/PiResultBounds.ts"

const MIB = 1024 * 1024

const image = (bytes: number) => ({
	type: "image" as const,
	data: "A".repeat(Math.ceil((bytes * 4) / 3)),
	mimeType: "image/png",
})

// What Pi stores for a tool result: its output and details in one JSON row.
const storedBytes = (result: { readonly output?: unknown; readonly details?: unknown }) =>
	serializedBytes({ output: result.output, details: result.details })

describe("Bounding what a tool result keeps", () => {
	it("keeps a 1 MiB image and 250,000 CJK characters of details under one row", () => {
		const details = { log: "漢".repeat(250_000) }
		// Each check alone would pass by characters; together they do not fit a row.
		expect(storedBytes({ output: [image(MIB)], details })).toBeGreaterThan(STORAGE_ROW_BYTES)
		const bounded = boundResult({ output: [image(MIB)], details })
		expect(bounded.output?.[0]?.type).toBe("image")
		expect(bounded.details).toEqual({ truncated: true })
		expect(storedBytes(bounded)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES)
	})

	it("trims a script's call list by serialized bytes, keeping the first calls", () => {
		const calls = Array.from({ length: 4000 }, (_, id) => ({
			id,
			name: "read",
			args: `{"path":"/workspace/${"漢".repeat(60)}"}`,
			status: "ok",
		}))
		const room = 100_000
		const bounded = boundResultDetails({ calls }, room) as unknown as {
			readonly calls: ReadonlyArray<unknown>
			readonly omitted_calls: number
		}
		// Each call takes about twice as many bytes as characters, so a count by characters overflows.
		expect(serializedBytes(bounded)).toBeLessThanOrEqual(room)
		expect(serializedBytes(bounded)).toBeGreaterThan(room - 300)
		expect(bounded.calls.length + bounded.omitted_calls).toBe(calls.length)
		expect(bounded.calls[0]).toEqual(calls[0])
	})

	it("gives way with details first, then images, each image past the budget becoming a note", () => {
		const small = image(1024)
		const bounded = boundResult({
			output: [{ type: "text", text: "two pictures" }, small, image(2 * MIB)],
			details: { calls: [] },
		})
		expect(bounded.output?.[0]).toEqual({ type: "text", text: "two pictures" })
		expect(bounded.output?.[1]).toBe(small)
		const note = bounded.output?.[2]
		expect(note?.type === "text" ? note.text : "").toContain("left out")
		expect(storedBytes(bounded)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES)
	})

	it("returns a result that fits unchanged", () => {
		const result = { output: [{ type: "text" as const, text: "hi" }, image(10)], details: { a: 1 } }
		expect(boundResult(result)).toBe(result)
		expect(boundResultImages(result.output, RESULT_BUDGET_BYTES)).toBe(result.output)
	})

	it("replaces other details that do not fit with a marker", () => {
		expect(boundResultDetails({ blob: "x".repeat(10_000) }, 1000)).toEqual({ truncated: true })
	})
})
