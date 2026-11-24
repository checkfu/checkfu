import type { JsonSessionEvent } from "@checkfu/sdk/client"
import { infiniteQueryOptions, QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import type { EventPage } from "../src/api.ts"
import { EventTail, progressOf, transcriptEvents } from "../src/event-tail.ts"
import { eventsOf, isFinal, transcriptQuery } from "../src/queries.ts"
import type { Transcript } from "../src/queries.ts"

const at = "2026-11-24T00:00:00.000Z"

const message = (seq: number): JsonSessionEvent => ({
	id: `evt_${seq}`,
	seq,
	type: "agent.message",
	created_at: at,
	content: [{ type: "text", text: `message ${seq}` }],
})

const running = (seq: number, turn: number): JsonSessionEvent => ({
	id: `evt_${seq}`,
	seq,
	type: "session.status_running",
	created_at: at,
	turn,
})

const idle = (seq: number): JsonSessionEvent => ({
	id: `evt_${seq}`,
	seq,
	type: "session.status_idle",
	created_at: at,
	stop_reason: { type: "end_turn" },
})

const archived = (seq: number): JsonSessionEvent => ({
	id: `evt_${seq}`,
	seq,
	type: "session.archived",
	created_at: at,
})

const page = (seqs: ReadonlyArray<number>, next: number | null): EventPage => ({
	data: seqs.map(message),
	has_more: next !== null,
	next_cursor: next,
})

const transcript = (...pages: ReadonlyArray<EventPage>): Transcript => ({
	pages: [...pages],
	pageParams: pages.map((_, index) => (index === 0 ? undefined : index)),
})

const seqs = (events: ReadonlyArray<JsonSessionEvent>) => events.map((event) => event.seq)

describe("transcript", () => {
	it("orders loaded pages oldest first", () => {
		expect(seqs(eventsOf(transcript(page([4, 3], 3), page([2, 1], null))))).toEqual([1, 2, 3, 4])
	})

	it("merges the live tail after the history by seq, once", () => {
		const tail = new EventTail()
		tail.add([message(5), message(4), message(6)])
		tail.add([message(5)])
		tail.flush()
		tail.add([message(3)])
		tail.flush()
		expect(seqs(tail.snapshot())).toEqual([3, 4, 5, 6])
		expect(seqs(transcriptEvents([1, 2, 3, 4].map(message), tail.snapshot()))).toEqual([
			1, 2, 3, 4, 5, 6,
		])
	})

	it("keeps a live event that arrives while an older page is loading", async () => {
		const client = new QueryClient()
		let release: (value: EventPage) => void = () => undefined
		let started: () => void = () => undefined
		const olderRequested = new Promise<void>((resolve) => {
			started = resolve
		})
		const options = infiniteQueryOptions({
			queryKey: ["transcripts", "sess_race"],
			queryFn: ({ pageParam }): Promise<EventPage> =>
				pageParam === undefined
					? Promise.resolve(page([4, 3], 3))
					: new Promise((resolve) => {
							release = resolve
							started()
						}),
			initialPageParam: undefined as number | undefined,
			getNextPageParam: (last) => last.next_cursor ?? undefined,
		})
		await client.fetchInfiniteQuery(options)
		const tail = new EventTail()
		const older = client.fetchInfiniteQuery({ ...options, pages: 2 })
		await olderRequested
		tail.add([message(5)])
		tail.flush()
		release(page([2, 1], null))
		const history = await older
		expect(seqs(transcriptEvents(eventsOf(history), tail.snapshot()))).toEqual([1, 2, 3, 4, 5])
	})

	it("notifies once per batch however many events a catch-up delivers", () => {
		const tail = new EventTail()
		let notified = 0
		tail.subscribe(() => {
			notified += 1
		})
		for (let seq = 1; seq <= 2000; seq += 1) {
			tail.add([message(seq)])
		}
		tail.flush()
		expect(notified).toBe(1)
		expect(tail.snapshot()).toHaveLength(2000)
	})

	it("keeps streamed events when session metadata is refreshed", async () => {
		const client = new QueryClient()
		const key = transcriptQuery("sess_1").queryKey
		client.setQueryData(key, transcript(page([2, 1], null)))
		await client.invalidateQueries({ queryKey: ["sessions"], refetchType: "none" })
		expect(client.getQueryState(key)?.isInvalidated).toBe(false)
	})

	it("is final only when the transcript itself holds the archive event", () => {
		expect(isFinal([message(1)])).toBe(false)
		expect(isFinal([message(1), archived(2)])).toBe(true)
	})

	it("takes status and turn from the newest events, and the snapshot only for what they lack", () => {
		const snapshot = { status: "running" as const, turn: 4 }
		expect(progressOf([message(1)], snapshot)).toEqual(snapshot)
		expect(progressOf([running(1, 1), idle(2)], snapshot)).toEqual({ status: "idle", turn: 1 })
		expect(progressOf([running(1, 1), idle(2), message(3), running(4, 2)], snapshot)).toEqual({
			status: "running",
			turn: 2,
		})
	})
})
