import type { TaskId } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { ScriptCalls } from "../src/Pi/PiDurableCodemode.ts"

const task = (id: number) => id as TaskId

const deferred = <A>() => {
	let resolve: (value: A) => void = () => undefined
	const promise = new Promise<A>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

const turn = () =>
	new Promise<void>((done) => {
		setTimeout(done, 0)
	})

const never = () => new Promise<never>(() => {})

const tracking = (waiting: ReadonlySet<number>) => {
	const parks: Array<ReadonlyArray<number>> = []
	const calls = new ScriptCalls(
		(id) => Promise.resolve(waiting.has(id)),
		(on) => {
			parks.push(on)
		},
	)
	return { calls, parks }
}

describe("the calls of one script run", () => {
	it("does not park while a call beside a waiting one is still being admitted", async () => {
		const { calls, parks } = tracking(new Set([1, 2]))
		const admitB = deferred<{ readonly taskId: TaskId }>()

		calls.issue()
		calls.issue()
		void calls.through(() => Promise.resolve({ taskId: task(1) }), never)
		void calls.through(() => admitB.promise, never)
		await turn()
		await calls.check()
		expect(parks).toEqual([])
		expect(calls.parkedOn).toBeUndefined()

		admitB.resolve({ taskId: task(2) })
		await turn()
		expect(parks).toEqual([[1, 2]])
		expect(calls.parkedOn).toEqual([1, 2])
	})

	it("does not park while a call the VM made has yet to reach Pi", async () => {
		const { calls, parks } = tracking(new Set([1]))
		calls.issue()
		calls.issue()
		void calls.through(() => Promise.resolve({ taskId: task(1) }), never)
		await turn()
		await calls.check()
		expect(parks).toEqual([])
	})

	it("parks only once every call still out waits for a person", async () => {
		const waiting = new Set([1])
		const { calls, parks } = tracking(waiting)
		const working = deferred<string>()
		calls.issue()
		calls.issue()
		void calls.through(() => Promise.resolve({ taskId: task(1) }), never)
		const second = calls.through(
			() => Promise.resolve({ taskId: task(2) }),
			() => working.promise,
		)
		await turn()
		await calls.check()
		expect(parks).toEqual([])

		working.resolve("done")
		expect(await second).toBe("done")
		await turn()
		expect(parks).toEqual([[1]])
	})

	it("lets go of a call whose admission failed", async () => {
		const { calls, parks } = tracking(new Set([1]))
		calls.issue()
		calls.issue()
		void calls.through(() => Promise.resolve({ taskId: task(1) }), never)
		await expect(
			calls.through(
				() => Promise.reject(new Error("refused")),
				() => Promise.resolve("unused"),
			),
		).rejects.toThrow("refused")
		await turn()
		expect(parks).toEqual([[1]])
	})
})
