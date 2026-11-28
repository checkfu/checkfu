// @vitest-environment happy-dom
import type { JsonSession, JsonSessionEvent } from "@checkfu/sdk/client"
import { InfiniteQueryObserver } from "@tanstack/react-query"
import { waitFor } from "@testing-library/react"
import { act } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { useSessionEvents } from "../src/pages/use-session-events.ts"
import { transcriptCursorBlocked, transcriptQuery } from "../src/queries.ts"
import { button, click, mount, newQueryClient, settle, stubApi } from "./dom.tsx"

const id = "sess_paging"
const at = "2026-11-24T00:00:00.000Z"
const idle: JsonSessionEvent = {
	id: "evt_pause",
	type: "session.status_idle",
	seq: 4,
	turn: 1,
	created_at: at,
	processed_at: at,
	stop_reason: { type: "requires_action", event_ids: ["tu_waiting"] },
}
const session = { id } as JsonSession

class LiveSource extends EventTarget {
	close() {}
}

afterEach(() => vi.unstubAllGlobals())

it.each([
	{ label: "a repeat", cursors: ["next", "next"], count: 2, broken: true },
	{ label: "an alternating cycle", cursors: ["one", "two", "one"], count: 3, broken: true },
	{ label: "a blank token", cursors: [" "], count: 1, broken: true },
	{ label: "a valid traversal", cursors: ["one", "two", null], count: 3, broken: false },
])("retains all loaded pages and stops on $label", async ({ cursors, count, broken }) => {
	let returned = 0
	const requests = stubApi(() => ({
		body: { data: [idle], next_page: cursors[returned++] ?? null },
	}))
	const client = newQueryClient()
	const options = transcriptQuery(id)
	await client.fetchInfiniteQuery(options)
	const observer = new InfiniteQueryObserver(client, options)
	const unsubscribe = observer.subscribe(() => undefined)
	try {
		for (let page = 1; page < 6 && observer.getCurrentResult().hasNextPage; page++) {
			await observer.fetchNextPage()
		}
		const history = observer.getCurrentResult().data
		expect(requests).toHaveLength(count)
		expect(history?.pages).toHaveLength(count)
		if (history === undefined) {
			throw new Error("Expected preserved history")
		}
		expect(transcriptCursorBlocked(history)).toBe(broken)
	} finally {
		unsubscribe()
		client.clear()
	}
})

it.each(["live answer", "termination", "navigation"] as const)(
	"stops the automatic search after %s while a page is pending",
	async (stop) => {
		const client = newQueryClient()
		const transcript = transcriptQuery(id)
		client.setQueryData(transcript.queryKey, {
			pages: [{ data: [idle], next_page: "older" }],
			pageParams: [undefined],
		})
		let source: LiveSource | undefined
		class FixtureSource extends LiveSource {
			constructor() {
				super()
				source = this
			}
		}
		vi.stubGlobal("EventSource", FixtureSource)
		const pending = Promise.withResolvers<Response>()
		const requests: Array<string> = []
		vi.stubGlobal("fetch", (url: string) => {
			requests.push(url)
			return pending.promise
		})
		function Search() {
			const view = useSessionEvents({ session, onSnapshotChange: () => undefined })
			return <p>{view.findingCalls === null ? "Resolved" : "Searching"}</p>
		}
		const page = await mount(<Search />, client)
		try {
			await waitFor(() => expect(requests).toHaveLength(1))
			expect(requests[0]).toContain("page=older")
			if (stop === "navigation") {
				page.unmount()
			} else {
				await act(async () => {
					if (stop === "termination") {
						const type = "session.status_terminated"
						source?.dispatchEvent(
							new MessageEvent(type, {
								data: JSON.stringify({ ...idle, type, id: "evt_terminated", seq: 5 }),
							}),
						)
						pending.resolve(Response.json({ data: [], next_page: "much-older" }))
						return
					}
					source?.dispatchEvent(
						new MessageEvent("user.tool_confirmation", {
							data: JSON.stringify({
								id: "evt_answer",
								seq: 5,
								type: "user.tool_confirmation",
								created_at: at,
								processed_at: at,
								tool_use_id: "tu_waiting",
								result: "allow",
							}),
						}),
					)
				})
				await waitFor(() => expect(page.container.textContent).toBe("Resolved"))
			}
			pending.resolve(Response.json({ data: [], next_page: "much-older" }))
			await settle()
			expect(requests).toHaveLength(1)
		} finally {
			if (stop !== "navigation") {
				page.unmount()
			}
			client.clear()
		}
	},
)

it("revalidates history on retry after a malformed continuation", async () => {
	const client = newQueryClient()
	client.setQueryData(transcriptQuery(id).queryKey, {
		pages: [{ data: [idle], next_page: " " }],
		pageParams: [undefined],
	})
	vi.stubGlobal("EventSource", LiveSource)
	const requests = stubApi(() => ({ body: { data: [], next_page: null } }))
	function Search() {
		const { findingCalls } = useSessionEvents({ session, onSnapshotChange: () => undefined })
		return findingCalls?.error === undefined ? (
			<p>Resolved</p>
		) : (
			<button type="button" onClick={findingCalls.retry}>
				Retry
			</button>
		)
	}
	const page = await mount(<Search />, client)
	try {
		expect(requests).toHaveLength(0)
		await click(button(page.container, "Retry"))
		await waitFor(() => expect(page.container.textContent).toBe("Resolved"))
		expect(requests).toHaveLength(1)
		expect(requests[0]?.path).not.toContain("page=")
	} finally {
		page.unmount()
		client.clear()
	}
})

it("does not restart a search when a shared cursor refresh outlives navigation", async () => {
	const client = newQueryClient()
	const options = transcriptQuery(id)
	client.setQueryData(options.queryKey, {
		pages: [{ data: [idle], next_page: " " }],
		pageParams: [undefined],
	})
	vi.stubGlobal("EventSource", LiveSource)
	const pending = Promise.withResolvers<Response>()
	const sent = vi.fn(() => pending.promise)
	vi.stubGlobal("fetch", sent)
	const observer = new InfiniteQueryObserver(client, options)
	const unsubscribe = observer.subscribe(() => undefined)
	function Search() {
		const { findingCalls } = useSessionEvents({ session, onSnapshotChange: () => undefined })
		return (
			<button type="button" onClick={findingCalls?.retry}>
				Retry
			</button>
		)
	}
	const page = await mount(<Search />, client)
	try {
		await click(button(page.container, "Retry"))
		expect(sent).toHaveBeenCalledTimes(1)
		page.unmount()
		pending.resolve(Response.json({ data: [idle], next_page: "usable" }))
		await settle()
		expect(observer.getCurrentResult().hasNextPage).toBe(true)
		expect(sent).toHaveBeenCalledTimes(1)
	} finally {
		unsubscribe()
		client.clear()
	}
})
