import type {
	CodemodeHostCall,
	CodemodeResult,
	CodemodeRun,
	CodemodeRunOptions,
	CodemodeSandboxBase,
} from "@earendil-works/pi-codemode/portable"
import { describe, expect, it } from "@effect/vitest"
import { SCRIPT_LIMITS, withScriptBounds } from "../src/Pi/PiCodemode.ts"

const ended = (result: CodemodeResult) =>
	({
		start: (): CodemodeRun => ({
			finished: true,
			deliver: () => undefined,
			result: Promise.resolve(result),
		}),
	}) as unknown as CodemodeSandboxBase

const options = (
	onCall: (call: CodemodeHostCall) => void = () => undefined,
	store?: CodemodeRunOptions["store"],
): CodemodeRunOptions => ({
	startedAt: Date.now(),
	seed: 7,
	onCall,
	...(store === undefined ? {} : { store }),
})

const ok = (
	output: CodemodeResult["output"],
	writes: Partial<Extract<CodemodeResult, { ok: true }>["storeWrites"]> = {},
): CodemodeResult => ({
	ok: true,
	value: undefined,
	output,
	calls: [],
	storeWrites: { set: writes.set ?? {}, delete: writes.delete ?? [] },
})

const returning = (value: unknown): CodemodeResult => ({
	ok: true,
	value,
	output: [],
	calls: [],
	storeWrites: { set: {}, delete: [] },
})

const throwing = (message: string, stack?: string): CodemodeResult => ({
	ok: false,
	error: { kind: "script", name: "Error", message, ...(stack === undefined ? {} : { stack }) },
	output: [],
	calls: [],
})

const calling = (calls: ReadonlyArray<CodemodeHostCall>) =>
	({
		start: (_code: string, given: CodemodeRunOptions): CodemodeRun => {
			for (const call of calls) {
				given.onCall(call)
			}
			return { finished: true, deliver: () => undefined, result: Promise.resolve(ok([])) }
		},
	}) as unknown as CodemodeSandboxBase

const bounded = (result: CodemodeResult, store?: CodemodeRunOptions["store"]) =>
	withScriptBounds(ended(result)).start("", options(undefined, store)).result

const failedWith = (result: CodemodeResult, name: string) => {
	expect(result.ok).toBe(false)
	expect(result.ok ? undefined : result.error.name).toBe(name)
	expect(result.output).toEqual([])
	return result.ok ? "" : result.error.message
}

const tool = (id: number, args: { readonly text?: string } = {}): CodemodeHostCall => ({
	id,
	target: "tool",
	name: "lookup",
	args,
})

describe("What a script hands Pi to store", () => {
	it("keeps the replay position when it replaces a result over a limit", async () => {
		const during = { seq: 3, issued: 2 }
		const large = {
			...ok([{ type: "text" as const, text: "x".repeat(SCRIPT_LIMITS.resultBytes + 1) }]),
			during,
		}
		const replaced = await bounded(large)
		expect(replaced.ok).toBe(false)
		expect(replaced.during).toEqual(during)
	})

	it("passes a result within the budget on unchanged", async () => {
		const result = ok([{ type: "text", text: "done" }])
		expect(await bounded(result)).toBe(result)
	})

	it("replaces a result whose text is past the budget with one explicit error", async () => {
		const message = failedWith(
			await bounded(ok([{ type: "text", text: "\n".repeat(16 * 1024 * 1024) }])),
			"ResultTooLarge",
		)
		expect(message).toContain(`the limit is ${SCRIPT_LIMITS.resultBytes}`)
		expect(message).toContain("Write large output to a file")
	})

	it("replaces a result whose returned value is past the budget", async () => {
		failedWith(await bounded(returning("x".repeat(16 * 1024 * 1024))), "ResultTooLarge")
		failedWith(
			await bounded(returning({ rows: "漢".repeat(SCRIPT_LIMITS.resultBytes / 2) })),
			"ResultTooLarge",
		)
	})

	it("replaces a result whose error is past the budget", async () => {
		failedWith(
			await bounded(throwing("e".repeat(SCRIPT_LIMITS.resultBytes), "at x\n".repeat(10))),
			"ResultTooLarge",
		)
	})

	it("replaces a result whose images are past the budget, counting each image's label", async () => {
		const tiny = { type: "image" as const, data: "AAAA", mimeType: "image/png" }
		failedWith(
			await bounded(ok(Array.from({ length: SCRIPT_LIMITS.resultBytes / 512 }, () => tiny))),
			"ResultTooLarge",
		)
		failedWith(
			await bounded(
				ok([{ type: "image", data: "A".repeat(SCRIPT_LIMITS.resultBytes), mimeType: "image/png" }]),
			),
			"ResultTooLarge",
		)
	})

	it("replaces a result whose store writes are past the budget", async () => {
		failedWith(
			await bounded(ok([], { set: { a: "x".repeat(SCRIPT_LIMITS.resultBytes) } })),
			"ResultTooLarge",
		)
	})

	it("keeps no store write that would grow the store past its budget", async () => {
		const half = "漢".repeat(Math.ceil(SCRIPT_LIMITS.storeBytes / 6))
		const result = await bounded(ok([{ type: "text", text: "done" }], { set: { b: half } }), {
			a: half,
		})
		expect(result.ok).toBe(false)
		expect(result.ok ? "" : result.error.message).toContain("store() writes were not kept")
	})

	it("runs a script that writes nothing, or shrinks the store, whatever the store already holds", async () => {
		const big = { a: "x".repeat(SCRIPT_LIMITS.storeBytes * 2) }
		expect((await bounded(ok([{ type: "text", text: "read" }]), big)).ok).toBe(true)
		expect((await bounded(ok([], { set: { a: "small" } }), big)).ok).toBe(true)
	})

	it("ends a script whose call passes too many argument bytes, before Pi sees the call", async () => {
		const forwarded: Array<CodemodeHostCall> = []
		const result = await withScriptBounds(
			calling([
				tool(1),
				{
					id: 2,
					target: "global",
					name: "searchTools",
					args: { query: "q".repeat(SCRIPT_LIMITS.callArgumentBytes) },
				},
				tool(3),
			]),
		).start(
			"",
			options((call) => forwarded.push(call)),
		).result
		expect(forwarded.map((call) => call.id)).toEqual([1])
		expect(failedWith(result, "CallLimitError")).toContain("searchTools()")
	})

	it("ends a script whose calls pass too many argument bytes in total", async () => {
		const forwarded: Array<CodemodeHostCall> = []
		const half = { text: "x".repeat(SCRIPT_LIMITS.callArgumentBytes - 64) }
		const result = await withScriptBounds(
			calling([tool(1, half), tool(2, half), tool(3, half)]),
		).start(
			"",
			options((call) => forwarded.push(call)),
		).result
		expect(forwarded.map((call) => call.id)).toEqual([1, 2])
		expect(failedWith(result, "CallLimitError")).toContain(`${SCRIPT_LIMITS.argumentBytes} bytes`)
	})

	it("ends a script that makes too many tool calls", async () => {
		const forwarded: Array<CodemodeHostCall> = []
		const result = await withScriptBounds(
			calling(Array.from({ length: SCRIPT_LIMITS.toolCalls + 5 }, (_, index) => tool(index + 1))),
		).start(
			"",
			options((call) => forwarded.push(call)),
		).result
		expect(forwarded).toHaveLength(SCRIPT_LIMITS.toolCalls)
		expect(failedWith(result, "CallLimitError")).toContain(`${SCRIPT_LIMITS.toolCalls} tool calls`)
	})

	it("stops the script's run when it ends it, and still passes an outer abort through", async () => {
		let signal: AbortSignal | undefined
		const sandbox = {
			start: (_code: string, given: CodemodeRunOptions): CodemodeRun => {
				signal = given.signal
				return {
					finished: false,
					deliver: () => undefined,
					result: new Promise<CodemodeResult>(() => {}),
				}
			},
		} as unknown as CodemodeSandboxBase
		const outer = new AbortController()
		withScriptBounds(sandbox).start("", { ...options(), signal: outer.signal })
		expect(signal?.aborted).toBe(false)
		outer.abort()
		expect(signal?.aborted).toBe(true)
	})
})
