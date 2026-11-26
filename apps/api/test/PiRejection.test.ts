import type { LiveState, TaskId } from "@earendil-works/pi-durable"
import { describe, expect, it } from "@effect/vitest"
import { REJECTED_KEY, markRejection, ranFromSlot, rejectionIn } from "../src/Pi/PiRejection.ts"

const TASK = 7 as TaskId

const liveWith = (status: "pending" | "running" | "sleeping" | "waiting" | "done") =>
	({ tools: [{ callId: "c", name: "read", taskId: TASK, status }] }) as unknown as LiveState

const blocked = [
	{ severity: "error" as const, code: "blocked", message: "the tool's own" },
	{ severity: "error" as const, code: "blocked", message: "Pi's" },
]

describe("Telling a call Pi refused from one that ran", () => {
	it("reads the call's slot: pending never ran, running and waiting ran, sleeping proves nothing", () => {
		expect(ranFromSlot(liveWith("pending"), TASK)).toBe(false)
		expect(ranFromSlot(liveWith("running"), TASK)).toBe(true)
		expect(ranFromSlot(liveWith("waiting"), TASK)).toBe(true)
		expect(ranFromSlot(liveWith("sleeping"), TASK)).toBeUndefined()
		expect(ranFromSlot(liveWith("done"), TASK)).toBeUndefined()
		expect(ranFromSlot(undefined, TASK)).toBeUndefined()
	})

	it("marks a call that never ran, and only that, with Checkfu's own key", () => {
		const refused = markRejection({ output: [], isError: true, diagnostics: blocked }, false)
		expect(refused.details).toEqual({ [REJECTED_KEY]: "blocked" })
		expect(rejectionIn(refused.details)).toBe("blocked")
		for (const ran of [true, undefined]) {
			const result = { output: [], isError: true, diagnostics: blocked }
			expect(markRejection(result, ran)).toBe(result)
		}
	})

	it("never reads a bare code as a refusal, and strips a key a tool wrote itself", () => {
		expect(rejectionIn(undefined)).toBeUndefined()
		expect(rejectionIn({ code: "blocked" })).toBeUndefined()
		expect(rejectionIn({ [REJECTED_KEY]: "anything else" })).toBeUndefined()
		const forged = {
			output: [],
			isError: true,
			diagnostics: blocked,
			details: { [REJECTED_KEY]: "blocked", log: "kept" },
		}
		const ran = markRejection(forged, true)
		expect(ran.details).toEqual({ log: "kept" })
		expect(rejectionIn(ran.details)).toBeUndefined()
		const onlyForged = markRejection(
			{ output: [], details: { [REJECTED_KEY]: "blocked" } },
			undefined,
		)
		expect(onlyForged.details).toEqual({})
	})
})
