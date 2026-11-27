import { boundOutput } from "@earendil-works/chord/output"
import type { OutputLimits } from "@earendil-works/chord/output"
import type { ToolExecutionResult } from "@earendil-works/pi-durable"
import { describe, expect, it } from "@effect/vitest"
import * as fc from "fast-check"
import {
	DIAGNOSTIC_BUDGET_BYTES,
	MAX_RESULT_DIAGNOSTICS,
	PI_DEFAULT_LIMITS,
	RESULT_BUDGET_BYTES,
	STORAGE_ROW_BYTES,
	boundNestedResult,
	boundResult,
	boundResultDetails,
	boundResultDiagnostics,
	boundResultImages,
	coalesceResultText,
	nestedFormsOf,
	outputLimitsOf,
	serializedBytes,
	storedNestedBytes,
	storedRowBytes,
} from "../src/Pi/PiResultBounds.ts"
import { workspaceOutputLimits } from "../src/Workspace/WorkspaceTools.ts"

const MIB = 1024 * 1024

const image = (bytes: number) => ({
	type: "image" as const,
	data: "A".repeat(Math.ceil((bytes * 4) / 3)),
	mimeType: "image/png",
})

const storedBytes = (result: { readonly output?: unknown; readonly details?: unknown }) =>
	serializedBytes({ output: result.output, details: result.details })

describe("Bounding what a tool result keeps", () => {
	it("counts the error text Pi adds to a schema tool's nested error", () => {
		const limits = [{ maxBytes: 4 * 1024 * 1024, maxLines: 100_000, retain: "head" as const }]
		const failed: ToolExecutionResult = {
			output: [{ type: "text", text: "e".repeat(1_200_000) }],
			isError: true,
			details: { log: "d".repeat(1_200_000) },
		}
		const nested = { forms: ["structured"] as const }
		expect(storedNestedBytes({ ...failed, output: [] }, nested, limits)).toBeLessThan(
			STORAGE_ROW_BYTES,
		)
		expect(storedNestedBytes(failed, nested, limits)).toBeGreaterThan(STORAGE_ROW_BYTES)
		const bounded = boundNestedResult(failed, nested, limits)
		expect(storedNestedBytes(bounded, nested, limits)).toBeLessThanOrEqual(STORAGE_ROW_BYTES)
	})

	it("keeps a nested result's blocks as the tool returned them, or refuses it, never merges them", () => {
		const blocks = (count: number): ToolExecutionResult => ({
			output: Array.from({ length: count }, (_, index) => ({
				type: "text" as const,
				text: index % 2 === 0 ? "" : " ",
			})),
		})
		const fits = blocks(1000)
		expect(boundNestedResult(fits, { forms: ["value"] })).toBe(fits)
		const many = blocks(100_000)
		expect(storedNestedBytes(many, { forms: ["value"] })).toBeGreaterThan(STORAGE_ROW_BYTES)
		const bounded = boundNestedResult(many, { forms: ["value"] })
		expect(bounded.isError).toBe(true)
		expect(bounded.diagnostics).toEqual([
			expect.objectContaining({ severity: "error", code: "result_too_large" }),
		])
		expect(storedNestedBytes(bounded, { forms: ["value"] })).toBeLessThanOrEqual(STORAGE_ROW_BYTES)
	})

	it("separates a nested result's repeated text objects before Pi keeps its bounded text", () => {
		const block = { type: "text" as const, text: "r".repeat(60_000) }
		const repeated: ToolExecutionResult = { output: Array.from({ length: 40 }, () => block) }
		const bounded = boundNestedResult(repeated, { forms: ["value"] })
		const texts = (bounded.output ?? []).filter((item) => item.type === "text")
		expect(new Set(texts).size).toBe(texts.length)
	})

	it("sizes a nested call for every registration of its name", () => {
		const both = nestedFormsOf([{ structuredOutputSchema: { type: "object" } }, {}])
		expect([...both.forms].sort()).toEqual(["structured", "value"])
		expect(nestedFormsOf([]).forms).toEqual(["value"])
		const result: ToolExecutionResult = {
			output: [{ type: "image", data: "A".repeat(2_400_000), mimeType: "image/png" }],
			structuredOutput: { ok: true },
		}
		expect(storedNestedBytes(result, { forms: ["structured"] })).toBeLessThan(STORAGE_ROW_BYTES)
		expect(storedNestedBytes(result, both)).toBeGreaterThan(STORAGE_ROW_BYTES)
		const bounded = boundNestedResult(result, both)
		expect(bounded.structuredOutput).toEqual({ ok: true })
		expect(storedNestedBytes(bounded, both)).toBeLessThanOrEqual(STORAGE_ROW_BYTES)
	})

	it("sizes a nested call as Pi stores it, and refuses a structured value too large to keep", () => {
		const large: ToolExecutionResult = {
			output: [{ type: "text", text: "summary" }],
			structuredOutput: { rows: "x".repeat(3_000_000) },
		}
		expect(storedRowBytes(large)).toBeLessThan(STORAGE_ROW_BYTES)
		expect(storedNestedBytes(large, { forms: ["structured"] })).toBeGreaterThan(STORAGE_ROW_BYTES)
		const bounded = boundNestedResult(large, { forms: ["structured"] })
		expect(bounded.isError).toBe(true)
		expect(bounded).not.toHaveProperty("structuredOutput")
		expect(bounded.diagnostics).toEqual([
			expect.objectContaining({ severity: "error", code: "result_too_large" }),
		])
		expect(storedNestedBytes(bounded, { forms: ["structured"] })).toBeLessThanOrEqual(
			STORAGE_ROW_BYTES,
		)
		const small: ToolExecutionResult = {
			output: [{ type: "text", text: "summary" }],
			structuredOutput: { rows: "a few" },
		}
		expect(boundNestedResult(small, { forms: ["structured"] })).toBe(small)
		expect(boundNestedResult(large, { forms: ["value"] })).toBe(large)
	})

	it("sizes a nested schema call without its model-only output, so a large preview costs nothing", () => {
		const result: ToolExecutionResult = {
			output: [image(1_900_000)],
			structuredOutput: { rows: "a few" },
			details: { log: "kept" },
		}
		expect(storedRowBytes(result)).toBeGreaterThan(STORAGE_ROW_BYTES)
		expect(boundNestedResult(result, { forms: ["structured"] })).toBe(result)
	})

	it("counts the call's id and name in the row Pi stores for it", () => {
		const call = { id: "c".repeat(450_000), name: "mcp__server__tool" }
		const result = { output: [image(1_100_000)], details: { log: "d".repeat(100_000) } }
		expect(storedRowBytes(result)).toBeLessThanOrEqual(STORAGE_ROW_BYTES)
		expect(storedRowBytes(result, undefined, call)).toBeGreaterThan(STORAGE_ROW_BYTES)
		const bounded = boundResult(result, undefined, call)
		expect(bounded).not.toBe(result)
		expect(storedRowBytes(bounded, undefined, call)).toBeLessThanOrEqual(STORAGE_ROW_BYTES)
	})

	it("drops a nested call's details before its structured value", () => {
		const result: ToolExecutionResult = {
			output: [{ type: "text", text: "summary" }],
			structuredOutput: { rows: "x".repeat(1_000_000) },
			details: { log: "y".repeat(1_100_000) },
		}
		expect(storedNestedBytes(result, { forms: ["structured"] })).toBeGreaterThan(STORAGE_ROW_BYTES)
		const bounded = boundNestedResult(result, { forms: ["structured"] })
		expect(bounded.isError).not.toBe(true)
		expect(bounded.structuredOutput).toEqual(result.structuredOutput)
		expect(storedNestedBytes(bounded, { forms: ["structured"] })).toBeLessThanOrEqual(
			STORAGE_ROW_BYTES,
		)
	})

	it("keeps a 1 MiB image and 250,000 CJK characters of details under one row", () => {
		const details = { log: "漢".repeat(250_000) }
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
		expect(serializedBytes(bounded)).toBeLessThanOrEqual(room)
		expect(serializedBytes(bounded)).toBeGreaterThan(room - 300)
		expect(bounded.calls.length + bounded.omitted_calls).toBe(calls.length)
		expect(bounded.calls[0]).toEqual(calls[0])
	})

	it("gives way with details first, then images, each image past the budget becoming a note", () => {
		const small = image(1024)
		const bounded = boundResult<Bounded>({
			output: [{ type: "text", text: "two pictures" }, small, image(2 * MIB)],
			details: { calls: [] },
		})
		expect(bounded.output?.[0]).toEqual({ type: "text", text: "two pictures" })
		expect(bounded.output?.[1]).toBe(small)
		const note = bounded.output?.[2]
		expect(note?.type === "text" ? note.text : "").toContain("left out")
		expect(storedBytes(bounded)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES)
		expect(bounded.diagnostics?.map((each) => each.code)).toEqual(["truncated"])
	})

	it("returns a result that fits unchanged", () => {
		const result = { output: [{ type: "text" as const, text: "hi" }, image(10)], details: { a: 1 } }
		expect(boundResult(result)).toBe(result)
		expect(boundResultImages(result.output, RESULT_BUDGET_BYTES)).toBe(result.output)
	})

	it("keeps call details when the image cannot fit", () => {
		const details = { calls: [{ name: "a" }, { name: "b" }] }
		const bounded = boundResult<Bounded>({
			output: [{ type: "text", text: "one picture" }, image(2 * MIB)],
			details,
		})
		expect(bounded.output?.[1]).toMatchObject({
			type: "text",
			text: expect.stringContaining("left out"),
		})
		expect(bounded.details).toEqual(details)
	})

	it("replaces other details that do not fit with a marker", () => {
		expect(boundResultDetails({ blob: "x".repeat(10_000) }, 1000)).toEqual({ truncated: true })
	})

	it("cuts a thrown error's message to its beginning, with nothing else in the result", () => {
		const message = `connect ECONNREFUSED ${"\u0001".repeat(3 * MIB)}`
		const thrown: Bounded = {
			isError: true,
			diagnostics: [{ severity: "error", code: "tool_error", message }],
		}
		expect(serializedBytes(rowOf(thrown))).toBeGreaterThan(STORAGE_ROW_BYTES)
		const bounded = boundResult(thrown)
		expect(serializedBytes(rowOf(bounded))).toBeLessThanOrEqual(STORAGE_ROW_BYTES)
		expect(serializedBytes(bounded.diagnostics)).toBeLessThanOrEqual(DIAGNOSTIC_BUDGET_BYTES)
		const [first, note] = bounded.diagnostics ?? []
		expect([first?.severity, first?.code, first?.message.slice(0, 20)]).toEqual([
			"error",
			"tool_error",
			"connect ECONNREFUSED",
		])
		expect([note?.code, bounded.diagnostics?.length]).toEqual(["truncated", 2])
	})

	it("keeps the first diagnostics that fit and says how many it left out", () => {
		const diagnostics = Array.from({ length: 500 }, (_, index) => ({
			severity: "info" as const,
			message: `step ${index}`,
		}))
		const bounded = boundResultDiagnostics(diagnostics, DIAGNOSTIC_BUDGET_BYTES) ?? []
		expect(bounded).toHaveLength(MAX_RESULT_DIAGNOSTICS)
		expect(bounded[0]).toBe(diagnostics[0])
		expect(bounded.at(-1)?.message).toContain(`${500 - (MAX_RESULT_DIAGNOSTICS - 1)} left out`)
		const pair = boundResultDiagnostics([{ severity: "warn", message: "😀".repeat(40_000) }], 4096)
		expect(pair?.[0]?.message.isWellFormed()).toBe(true)
	})

	it("makes each run of text items one item, and leaves output without runs alone", () => {
		const output = [
			{ type: "text" as const, text: "a" },
			{ type: "text" as const, text: "" },
			{ type: "text" as const, text: "b" },
			image(10),
			{ type: "text" as const, text: "c" },
		]
		expect(coalesceResultText(output)).toEqual([
			{ type: "text", text: "ab" },
			image(10),
			{ type: "text", text: "c" },
		])
		const plain = [{ type: "text" as const, text: "a" }, image(10)]
		expect(coalesceResultText(plain)).toBe(plain)
	})

	it("leaves the blocks of a result that already fits exactly as the tool returned them", () => {
		const result = {
			output: [
				{ type: "text" as const, text: "first record" },
				{ type: "text" as const, text: "second record" },
			],
		}
		expect(boundResult<Bounded>(result)).toBe(result)
	})

	it("keeps a result of 100,000 empty text items as one item, under one row", () => {
		const output = Array.from({ length: 100_000 }, () => ({ type: "text" as const, text: "" }))
		const bounded = boundResult<Bounded>({ output })
		expect(bounded.output).toEqual([{ type: "text", text: "" }])
		expect(bounded.isError).not.toBe(true)
		expect(serializedBytes(rowOf(bounded))).toBeLessThanOrEqual(STORAGE_ROW_BYTES)
	})

	it("keeps a read's text, which its tool lets past Pi's default, with images and details under one row", () => {
		const result: Bounded = {
			output: [
				{ type: "text", text: "\u0001".repeat(READ_LIMITS[1].maxBytes - 1024) },
				image(400 * 1024),
			],
			details: { log: "x".repeat(300 * 1024) },
		}
		expect(serializedBytes(rowOf(result, READ_LIMITS))).toBeGreaterThan(STORAGE_ROW_BYTES)
		const bounded = boundResult<Bounded>(result, READ_LIMITS)
		expect(serializedBytes(rowOf(bounded, READ_LIMITS))).toBeLessThanOrEqual(STORAGE_ROW_BYTES)
		expect(bounded.isError).not.toBe(true)
	})

	it("cuts the text itself, and says so, when the tool's own limit lets more than one row through", () => {
		const result: Bounded = { output: [{ type: "text", text: "漢".repeat(1_200_000) }] }
		expect(serializedBytes(rowOf(result, WIDE_LIMITS))).toBeGreaterThan(STORAGE_ROW_BYTES)
		const bounded = boundResult<Bounded>(result, WIDE_LIMITS)
		expect(serializedBytes(rowOf(bounded, WIDE_LIMITS))).toBeLessThanOrEqual(STORAGE_ROW_BYTES)
		expect(bounded.isError).not.toBe(true)
		const [kept] = bounded.output ?? []
		expect(kept?.type === "text" ? kept.text.length : 0).toBeGreaterThan(500_000)
		expect(bounded.diagnostics?.[0]?.code).toBe("truncated")
	})

	it("keeps the end of a result whose tool keeps its end, when the row cannot hold it all", () => {
		const limits: ReadonlyArray<OutputLimits> = [
			PI_DEFAULT_LIMITS,
			outputLimitsOf({
				outputLimits: { maxBytes: 4 * 1024 * 1024, maxLines: 100_000, retain: "tail" },
			}),
		]
		const last = "error: the build failed at step 9"
		const result: Bounded = {
			output: [{ type: "text", text: `${"漢".repeat(1_200_000)}\n${last}` }],
		}
		const bounded = boundResult<Bounded>(result, limits)
		expect(serializedBytes(rowOf(bounded, limits))).toBeLessThanOrEqual(STORAGE_ROW_BYTES)
		const [kept] = bounded.output ?? []
		expect(kept?.type === "text" ? kept.text.endsWith(last) : false).toBe(true)
		expect(bounded.diagnostics?.[0]?.message).toContain("to its end")
	})

	it("gives each text item its own object when Pi will cut, so only one keeps the cut text", () => {
		const shared = { type: "text" as const, text: "a".repeat(100) }
		const result: Bounded = { output: Array.from({ length: 20_000 }, () => shared) }
		const bounded = boundResult<Bounded>(result)
		const texts = (bounded.output ?? []).filter((each) => each.type === "text")
		expect(new Set(texts).size).toBe(texts.length)
		expect(serializedBytes(rowOf(bounded))).toBeLessThanOrEqual(STORAGE_ROW_BYTES)
		const few: Bounded = { output: [shared, shared] }
		expect(boundResult(few)).toBe(few)
	})

	it("keeps the same result when an omitted image adds a note near the row limit", () => {
		const png = (size: number) => ({
			type: "image" as const,
			data: "A".repeat(size),
			mimeType: "image/png",
		})
		const result: Bounded = {
			output: [{ type: "text", text: "a".repeat(300_000) }, png(69_406), png(0), png(1_559_136)],
			details: {
				calls: Array.from({ length: 2140 }, (_, id) => ({
					id,
					name: "read",
					args: "a\n".repeat(231),
				})),
			},
			diagnostics: [
				{ severity: "info", message: "漢".repeat(27) },
				{ severity: "info", message: "😀".repeat(101) },
				{ severity: "info", message: "\u0001".repeat(173) },
				{ severity: "error", message: "a".repeat(23) },
				{ severity: "info", message: "漢".repeat(199) },
				{ severity: "info", message: "a".repeat(18) },
				{ severity: "error", message: '"'.repeat(341) },
			],
		}
		const bounded = boundResult(result, READ_LIMITS)
		expect(
			bounded.output?.some((item) => item.type === "text" && item.text.includes("image of")),
		).toBe(true)
		expect(serializedBytes(rowOf(bounded, READ_LIMITS))).toBeLessThanOrEqual(STORAGE_ROW_BYTES)
		expect(boundResult(bounded, READ_LIMITS)).toBe(bounded)
	})

	it("holds a result of any shape to its row under its tool's limits, and leaves alone one that already fits", () => {
		fc.assert(
			fc.property(anyResult, limitSets, (result, limits) => {
				const bounded = boundResult(result, limits)
				expect(serializedBytes(rowOf(bounded, limits))).toBeLessThanOrEqual(STORAGE_ROW_BYTES)
				expect(boundResult(bounded, limits)).toBe(bounded)
				const output = result.output ?? []
				const text = output.flatMap((each) => (each.type === "text" ? [each.text] : [])).join("")
				const texts = output.filter((each) => each.type === "text")
				const aliased =
					new Set(texts).size < texts.length &&
					limits.some((each) => boundOutput(text, each).droppedBytes > 0)
				const fits =
					!aliased &&
					(result.diagnostics ?? []).length <= MAX_RESULT_DIAGNOSTICS &&
					serializedBytes(result.diagnostics) <= DIAGNOSTIC_BUDGET_BYTES &&
					storedBytes({ output: imagesOf(result), details: result.details }) <=
						RESULT_BUDGET_BYTES &&
					storedRowBytes(result, limits) + 2000 <= STORAGE_ROW_BYTES
				if (fits) {
					expect(bounded).toBe(result)
				}
			}),
			{ numRuns: 60 },
		)
	}, 30_000)
})

type Bounded = Pick<ToolExecutionResult, "output" | "details" | "diagnostics" | "isError">

const imagesOf = (result: Bounded) => (result.output ?? []).filter((item) => item.type === "image")

const READ_LIMITS = [
	PI_DEFAULT_LIMITS,
	outputLimitsOf({ outputLimits: workspaceOutputLimits("read") }),
] as const
const WIDE_LIMITS: ReadonlyArray<OutputLimits> = [
	PI_DEFAULT_LIMITS,
	outputLimitsOf({ outputLimits: { maxBytes: 4 * 1024 * 1024, maxLines: 100_000 } }),
]
const limitSets = fc.constantFrom<ReadonlyArray<OutputLimits>>(
	[PI_DEFAULT_LIMITS],
	READ_LIMITS,
	WIDE_LIMITS,
)

const rowOf = (result: Bounded, limits: ReadonlyArray<OutputLimits> = [PI_DEFAULT_LIMITS]) =>
	limits.reduce(
		(largest, each) => {
			const row = piRowOf(result, each)
			return serializedBytes(row) > serializedBytes(largest) ? row : largest
		},
		piRowOf(result, limits[0] ?? PI_DEFAULT_LIMITS),
	)

const piRowOf = (result: Bounded, limits: OutputLimits) => {
	const output = result.output ?? []
	const texts = output.filter((item) => item.type === "text")
	const kept = boundOutput(texts.map((item) => item.text).join(""), limits)
	const keep = limits.retain === "head" ? texts[0] : texts.at(-1)
	const content: Array<unknown> =
		kept.droppedBytes === 0
			? [...output]
			: output.flatMap((item): Array<unknown> =>
					item.type !== "text" ? [item] : item === keep ? [{ ...item, text: kept.text }] : [],
				)
	const diagnostics = [
		...(result.diagnostics ?? []),
		...(kept.droppedBytes === 0
			? []
			: [
					{
						severity: "warn",
						code: "truncated",
						message: `Output truncated to its beginning: ${kept.droppedLines} lines, ${kept.droppedBytes} bytes dropped`,
					},
				]),
	]
	if (diagnostics.length > 0) {
		const lines = diagnostics.map((each) => `[${each.severity}] ${each.message}`)
		content.push({ type: "text", text: `<harness>\n${lines.join("\n")}\n</harness>` })
	}
	return {
		id: Number.MAX_SAFE_INTEGER,
		kind: "pi.tool-result",
		byTaskId: Number.MAX_SAFE_INTEGER,
		model: [
			{
				role: "toolResult",
				toolCallId: "call_0123456789abcdef0123456789abcdef",
				toolName: "mcp__server__tool",
				content,
				...(result.details === undefined ? {} : { details: result.details }),
				isError: result.isError ?? false,
				durationMs: Number.MAX_SAFE_INTEGER,
				timestamp: Number.MAX_SAFE_INTEGER,
			},
		],
		data: { diagnostics },
	}
}

const lengths = fc.oneof(
	fc.constant(0),
	fc.integer({ min: 1, max: 2000 }),
	fc.integer({ min: 40_000, max: 70_000 }),
	fc.integer({ min: 300_000, max: 2_200_000 }),
)
const textOf = (length: fc.Arbitrary<number>) =>
	fc
		.tuple(fc.constantFrom("a", "\u0001", "漢", "😀", '"', "a\n"), length)
		.map(([unit, size]) => unit.repeat(Math.ceil(size / unit.length)))

type Item = NonNullable<Bounded["output"]>[number]

const item: fc.Arbitrary<Item> = fc.oneof(
	textOf(lengths).map((text) => ({ type: "text" as const, text })),
	lengths.map((size) => image(size)),
)
const smallItem: fc.Arbitrary<Item> = fc.oneof(
	fc.constant({ type: "text" as const, text: "" }),
	fc.constantFrom("a", "\u0001", "😀").map((text) => ({ type: "text" as const, text })),
	fc.constant(image(0)),
)
const manyItems = fc
	.tuple(smallItem, fc.array(smallItem, { maxLength: 5 }), fc.integer({ min: 1000, max: 40_000 }))
	.map(([first, rest, count]) => {
		const pattern = [first, ...rest]
		return Array.from({ length: count }, (_, index) => pattern[index % pattern.length] ?? first)
	})

const details = fc.oneof(
	textOf(lengths).map((blob) => ({ blob })),
	fc
		.tuple(fc.integer({ min: 0, max: 3000 }), textOf(fc.integer({ min: 0, max: 2000 })))
		.map(([count, args]) => ({
			calls: Array.from({ length: count }, (_, id) => ({ id, name: "read", args })),
		})),
)
const diagnostic = (length: fc.Arbitrary<number>) =>
	fc
		.tuple(fc.constantFrom("info" as const, "warn" as const, "error" as const), textOf(length))
		.map(([severity, message]) => ({ severity, message }))
const diagnostics = fc.oneof(
	fc.array(diagnostic(lengths), { maxLength: 3 }),
	fc.array(diagnostic(fc.integer({ min: 0, max: 400 })), { maxLength: 300 }),
)

const anyResult: fc.Arbitrary<Bounded> = fc
	.record({
		output: fc.option(fc.oneof(fc.array(item, { maxLength: 4 }), manyItems), { nil: undefined }),
		details: fc.option(details, { nil: undefined }),
		diagnostics: fc.option(diagnostics, { nil: undefined }),
	})
	.map((parts) => ({
		...(parts.output === undefined ? {} : { output: parts.output }),
		...(parts.details === undefined ? {} : { details: parts.details }),
		...(parts.diagnostics === undefined ? {} : { diagnostics: parts.diagnostics }),
	}))
