import type { JsonSessionEvent } from "@checkfu/sdk/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { follow } from "../src/event-stream.ts"
import type { Connection, Source } from "../src/event-stream.ts"

class FakeSource implements Source {
	readyState = 0
	closed = false
	readonly listeners = new Map<string, Array<(message: MessageEvent<string>) => void>>()
	readonly addEventListener = (type: string, listener: (message: MessageEvent<string>) => void) => {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
	}
	readonly close = () => {
		this.closed = true
	}
	emit(type: string, data = "") {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(new MessageEvent(type, { data }))
		}
	}
	opened() {
		this.readyState = 1
		this.emit("open")
	}
	failed() {
		this.readyState = 2
		this.emit("error")
	}
	send(event: JsonSessionEvent) {
		this.emit(event.type, JSON.stringify(event))
	}
}

const message = (seq: number): JsonSessionEvent => ({
	id: `evt_${seq}`,
	seq,
	type: "agent.message",
	created_at: "2026-11-24T00:00:00.000Z",
	processed_at: "2026-11-24T00:00:00.000Z",
	content: [{ type: "text", text: `message ${seq}` }],
})

const harness = (mayRetry: () => Promise<boolean>) => {
	const sources: Array<{ readonly after: number; readonly source: FakeSource }> = []
	const received: Array<number> = []
	const states: Array<Connection> = []
	let newest = 7
	const stop = follow({
		open: (after) => {
			const source = new FakeSource()
			sources.push({ after, source })
			return source
		},
		cursor: () => newest,
		receive: (event) => {
			received.push(event.seq)
			newest = event.seq
		},
		mayRetry,
		connection: (state) => states.push(state),
	})
	const latest = () => sources.at(-1)?.source ?? new FakeSource()
	return { sources, received, states, stop, latest }
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("following a session's events", () => {
	it("reconnects after a server error, from the newest event seen, with growing delays", async () => {
		const stream = harness(() => Promise.resolve(true))
		stream.latest().opened()
		stream.latest().send(message(8))
		stream.latest().failed()
		await vi.advanceTimersByTimeAsync(999)
		expect(stream.sources).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(stream.sources.map((each) => each.after)).toEqual([7, 8])
		stream.latest().failed()
		await vi.advanceTimersByTimeAsync(1999)
		expect(stream.sources).toHaveLength(2)
		await vi.advanceTimersByTimeAsync(1)
		expect(stream.sources).toHaveLength(3)
		stream.latest().opened()
		stream.latest().failed()
		await vi.advanceTimersByTimeAsync(1000)
		expect(stream.sources).toHaveLength(4)
	})

	it("keeps retrying when the session check itself fails", async () => {
		const stream = harness(() => Promise.reject(new Error("offline")))
		stream.latest().failed()
		await vi.advanceTimersByTimeAsync(1000)
		expect(stream.sources).toHaveLength(2)
	})

	it("stops for good once the user is signed out", async () => {
		const stream = harness(() => Promise.resolve(false))
		stream.latest().failed()
		await vi.advanceTimersByTimeAsync(60_000)
		expect(stream.sources).toHaveLength(1)
	})

	it("reads through to the archive event after a drop, instead of stopping at the old cursor", async () => {
		const stream = harness(() => Promise.resolve(true))
		stream.latest().opened()
		stream.latest().failed()
		await vi.advanceTimersByTimeAsync(1000)
		expect(stream.sources.map((each) => each.after)).toEqual([7, 7])
		stream.latest().opened()
		stream.latest().send(message(8))
		stream.latest().send({
			id: "evt_9",
			seq: 9,
			type: "session.archived",
			created_at: "2026-11-24T00:00:00.000Z",
			processed_at: "2026-11-24T00:00:00.000Z",
		})
		await vi.advanceTimersByTimeAsync(60_000)
		expect(stream.received).toEqual([8, 9])
		expect(stream.sources).toHaveLength(2)
	})

	it("stops after the archive event without asking again", async () => {
		const mayRetry = vi.fn(() => Promise.resolve(true))
		const stream = harness(mayRetry)
		stream.latest().opened()
		stream.latest().send({
			id: "evt_9",
			seq: 9,
			type: "session.archived",
			created_at: "2026-11-24T00:00:00.000Z",
			processed_at: "2026-11-24T00:00:00.000Z",
		})
		expect(stream.latest().closed).toBe(true)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(stream.sources).toHaveLength(1)
		expect(mayRetry).not.toHaveBeenCalled()
		expect(stream.received).toEqual([9])
	})

	it("says it is reconnecting only after a quiet period, and live again once open", async () => {
		const stream = harness(() => Promise.resolve(true))
		stream.latest().opened()
		stream.latest().emit("error")
		await vi.advanceTimersByTimeAsync(4999)
		expect(stream.states).toEqual(["live"])
		await vi.advanceTimersByTimeAsync(1)
		expect(stream.states).toEqual(["live", "reconnecting"])
		stream.latest().opened()
		expect(stream.states).toEqual(["live", "reconnecting", "live"])
	})

	it("opens nothing more after the view stops following", async () => {
		const stream = harness(() => Promise.resolve(true))
		stream.latest().failed()
		stream.stop()
		await vi.advanceTimersByTimeAsync(60_000)
		expect(stream.sources).toHaveLength(1)
		expect(stream.latest().closed).toBe(true)
	})
})
