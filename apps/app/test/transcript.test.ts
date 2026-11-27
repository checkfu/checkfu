import { foldSessionEvents, outstandingCalls } from "@checkfu/sdk/SessionFold"
import type { JsonSessionEvent } from "@checkfu/sdk/client"
import { infiniteQueryOptions, QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import type { EventPage } from "../src/api.ts"
import { EventBatch, mergeBySeq, transcriptEvents } from "../src/event-tail.ts"
import { eventsOf, isFinal, liveQuery, newestSeqOf, transcriptQuery } from "../src/queries.ts"
import type { Transcript } from "../src/queries.ts"

import { sessionCallsOf } from "../src/tool-calls.ts"
import {
	appendBatch,
	makeTranscriptFixture,
	transcriptSizes,
	waitingCallId,
} from "./transcript-fixture.ts"

const at = "2026-11-24T00:00:00.000Z"

const message = (seq: number): JsonSessionEvent => ({
	id: `evt_${seq}`,
	seq,
	type: "agent.message",
	created_at: at,
	processed_at: at,
	content: [{ type: "text", text: `message ${seq}` }],
})

const archived = (seq: number): JsonSessionEvent => ({
	id: `evt_${seq}`,
	seq,
	type: "session.archived",
	created_at: at,
	processed_at: at,
})

const page = (seqs: ReadonlyArray<number>, next: number | null): EventPage => ({
	data: seqs.map(message),
	next_page: next === null ? null : String(next),
})

const transcript = (...pages: ReadonlyArray<EventPage>): Transcript => ({
	pages: [...pages],
	pageParams: pages.map((_, index) => (index === 0 ? undefined : String(index))),
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
			initialPageParam: undefined as string | undefined,
			getNextPageParam: (last) => last.next_page ?? undefined,
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

const fixtureHistory = (fixture: ReturnType<typeof makeTranscriptFixture>, pageCount: number) =>
	transcript(
		...Array.from({ length: pageCount }, (_, index) =>
			fixture.page(fixture.newest - fixture.pageSize * index),
		),
	)

describe("long transcript playback", () => {
	it.each(transcriptSizes)("preserves event order and one waiting call with %i events", (size) => {
		const fixture = makeTranscriptFixture(size)
		const newestPage = fixture.page()
		expect(sessionCallsOf(eventsOf(transcript(newestPage))).unseen).toEqual([waitingCallId])
		const history = fixtureHistory(fixture, size / fixture.pageSize)
		let tail: ReadonlyArray<JsonSessionEvent> = []
		let writes = 0
		const batch = new EventBatch((incoming) => {
			writes++
			tail = mergeBySeq(tail, incoming)
		})
		const first = appendBatch(fixture.newest)
		const reconnect = appendBatch(fixture.newest + first.length)
		batch.add(first)
		batch.flush()
		batch.add([...first, ...reconnect, ...reconnect.slice(0, 1)])
		batch.flush()
		expect(writes).toBe(2)
		const visible = transcriptEvents(eventsOf(history), tail)
		expect(seqs(visible)).toEqual(
			Array.from(
				{ length: size + first.length + reconnect.length },
				(_, index) => fixture.newest - size + 1 + index,
			),
		)
		const calls = sessionCallsOf(visible)
		expect([...calls.waiting]).toEqual([waitingCallId])
		expect(calls.unseen).toEqual([])
		expect(calls.fold.calls.get(waitingCallId)).toMatchObject({ status: "waiting" })
	})

	it.runIf(process.env["CHECKFU_MEASURE_DASHBOARD_TRANSCRIPT"] === "1")(
		"measures history flattening, tail merge and tool folding",
		() => {
			for (const size of transcriptSizes) {
				const fixture = makeTranscriptFixture(size)
				const count = size / fixture.pageSize
				const history = fixtureHistory(fixture, count)
				const olderHistory = fixtureHistory(fixture, count + 1)
				const tail = appendBatch(fixture.newest)
				const appended = appendBatch(fixture.newest + tail.length)
				const cases = [
					{ name: "append", history, tail: [], incoming: tail },
					{ name: "preview", history, tail, incoming: undefined },
					{
						name: "reconnect",
						history,
						tail,
						incoming: [...tail.slice(-2).map((event) => structuredClone(event)), ...appended],
					},
					{
						name: "prepend",
						history: olderHistory,
						tail: [...tail, ...appended],
						incoming: undefined,
					},
				]
				const stableEvents = transcriptEvents(eventsOf(history), tail)
				const stableCalls = sessionCallsOf(stableEvents)
				for (const workload of cases) {
					for (let run = 0; run < 8; run++) {
						let nextTail: ReadonlyArray<JsonSessionEvent> = workload.tail
						const batch = new EventBatch((events) => {
							nextTail = mergeBySeq(workload.tail, events)
						})
						const started = performance.now()
						if (workload.incoming !== undefined) {
							batch.add(workload.incoming)
							batch.flush()
						}
						const merged = transcriptEvents(eventsOf(workload.history), nextTail)
						const mergedAt = performance.now()
						const calls = sessionCallsOf(merged)
						const foldedAt = performance.now()
						expect(calls.waiting.has(waitingCallId)).toBe(true)
						let candidateMs: number | null = null
						if (workload.name === "reconnect") {
							const candidateStarted = performance.now()
							const keepsPrefix = tail.every(
								(event, index) =>
									nextTail[index] === event ||
									JSON.stringify(nextTail[index]) === JSON.stringify(event),
							)
							const fold = keepsPrefix
								? foldSessionEvents(stableCalls.fold, nextTail.slice(tail.length))
								: sessionCallsOf(merged).fold
							const waiting = outstandingCalls(fold)
							const candidate = {
								fold,
								waiting,
								unseen: [...waiting].filter((id) => !fold.calls.has(id)),
							}
							candidateMs = performance.now() - candidateStarted
							expect(candidate).toEqual(calls)
						}
						if (run >= 3) {
							process.stdout.write(
								`${JSON.stringify({
									size,
									workload: workload.name,
									run: run - 2,
									mergeMs: mergedAt - started,
									foldMs: foldedAt - mergedAt,
									candidateMs,
								})}\n`,
							)
						}
					}
				}
			}
		},
		20_000,
	)
})
