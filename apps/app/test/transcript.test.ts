import type { JsonSessionEvent } from "@checkfu/sdk/client"
import { infiniteQueryOptions, QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import type { EventPage } from "../src/api.ts"
import { EventBatch, mergeBySeq, transcriptEvents } from "../src/event-tail.ts"
import { eventsOf, isFinal, liveQuery, newestSeqOf, transcriptQuery } from "../src/queries.ts"
import type { Transcript } from "../src/queries.ts"

const at = "2026-11-24T00:00:00.000Z"

const message = (seq: number): JsonSessionEvent => ({
	id: `evt_${seq}`,
	seq,
	type: "agent.message",
	created_at: at,
	content: [{ type: "text", text: `message ${seq}` }],
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

	it("merges live events after the history by seq, once", () => {
		const merged = mergeBySeq(mergeBySeq([], [message(5), message(4), message(6), message(5)]), [
			message(3),
		])
		expect(seqs(merged)).toEqual([3, 4, 5, 6])
		expect(seqs(transcriptEvents([1, 2, 3, 4].map(message), merged))).toEqual([1, 2, 3, 4, 5, 6])
	})

	it("keeps a live event that arrives while an older page is loading", async () => {
		const client = new QueryClient()
		let release: (value: EventPage) => void = () => undefined
		let started: () => void = () => undefined
		const olderRequested = new Promise<void>((resolve) => {
			started = resolve
		})
		const options = infiniteQueryOptions({
			queryKey: transcriptQuery("sess_race").queryKey,
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
		const live = liveQuery("sess_race").queryKey
		const batch = new EventBatch((events) =>
			client.setQueryData(live, (seen = []) => mergeBySeq(seen, events)),
		)
		const older = client.fetchInfiniteQuery({ ...options, pages: 2 })
		await olderRequested
		batch.add([message(5)])
		batch.flush()
		release(page([2, 1], null))
		const history = await older
		expect(seqs(transcriptEvents(eventsOf(history), client.getQueryData(live) ?? []))).toEqual([
			1, 2, 3, 4, 5,
		])
	})

	it("writes once per batch however many events a catch-up delivers", () => {
		const writes: Array<number> = []
		const batch = new EventBatch((events) => writes.push(events.length))
		for (let seq = 1; seq <= 2000; seq += 1) {
			batch.add([message(seq)])
		}
		expect(batch.newestSeq()).toBe(2000)
		batch.flush()
		expect(writes).toEqual([2000])
	})

	it("keeps live events in the cache through refetches, and resumes after the newest one seen", async () => {
		const client = new QueryClient()
		const history = transcriptQuery("sess_1").queryKey
		const live = liveQuery("sess_1").queryKey
		client.setQueryData(history, transcript(page([2, 1], null)))
		client.setQueryData(live, [message(3), message(4)])
		await client.invalidateQueries()
		await client.refetchQueries()
		expect(seqs(client.getQueryData(live) ?? [])).toEqual([3, 4])
		expect(newestSeqOf(client.getQueryData(history))).toBe(2)
		expect(newestSeqOf(undefined)).toBe(0)
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
})
