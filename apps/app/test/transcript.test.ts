import type { JsonSessionEvent } from "@checkfu/sdk/client"
import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import type { EventPage } from "../src/api.ts"
import { eventsOf, isFinal, transcriptQuery, withStreamed } from "../src/queries.ts"
import type { Transcript } from "../src/queries.ts"

const message = (seq: number): JsonSessionEvent => ({
	id: `evt_${seq}`,
	seq,
	type: "agent.message",
	created_at: "2026-11-24T00:00:00.000Z",
	content: [{ type: "text", text: `message ${seq}` }],
})

const archived = (seq: number): JsonSessionEvent => ({
	id: `evt_${seq}`,
	seq,
	type: "session.archived",
	created_at: "2026-11-24T00:00:00.000Z",
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

const seqs = (value: Transcript) => eventsOf(value).map((event) => event.seq)

describe("transcript cache", () => {
	it("orders loaded pages oldest first", () => {
		expect(seqs(transcript(page([4, 3], 3), page([2, 1], null)))).toEqual([1, 2, 3, 4])
	})

	it("adds a streamed event as the newest, once, and keeps the older cursor", () => {
		const loaded = transcript(page([4, 3], 3), page([2, 1], null))
		const streamed = withStreamed(loaded, message(5))
		expect(seqs(streamed)).toEqual([1, 2, 3, 4, 5])
		expect(streamed.pages[0]?.next_cursor).toBe(3)
		expect(withStreamed(streamed, message(5))).toBe(streamed)
		expect(withStreamed(streamed, message(2))).toBe(streamed)
	})

	it("keeps streamed events when session metadata is refreshed", async () => {
		const client = new QueryClient()
		const id = "sess_1"
		const key = transcriptQuery(id).queryKey
		client.setQueryData(key, withStreamed(transcript(page([1], null)), message(2)))
		await client.invalidateQueries({ queryKey: ["sessions"], refetchType: "none" })
		expect(client.getQueryState(key)?.isInvalidated).toBe(false)
		const cached = client.getQueryData(key)
		expect(cached === undefined ? [] : seqs(cached)).toEqual([1, 2])
	})

	it("treats a transcript as final once the session or its events say it was archived", () => {
		expect(isFinal({ archived_at: null }, [message(1)])).toBe(false)
		expect(isFinal({ archived_at: "2026-11-24T00:00:00.000Z" }, [])).toBe(true)
		expect(isFinal({ archived_at: null }, [message(1), archived(2)])).toBe(true)
	})
})
