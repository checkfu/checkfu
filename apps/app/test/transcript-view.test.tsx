import type { JsonSessionEvent } from "@checkfu/sdk/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { accumulateSessionEvent } from "@checkfu/sdk/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Transcript } from "../src/pages/transcript.tsx"

import { eventsOf } from "../src/queries.ts"
import {
	historyRowCount,
	historyRowMarkers,
	makeTranscriptFixture,
	previewEvents,
	renderedRowMarker,
	waitingCallName,
} from "./transcript-fixture.ts"

const reply = (seq: number, truncated: boolean): JsonSessionEvent => ({
	id: `evt_${seq}`,
	seq,
	type: "agent.message",
	created_at: "2026-11-24T00:00:00.000Z",
	processed_at: "2026-11-24T00:00:00.000Z",
	content: [{ type: "text", text: `reply ${seq}` }],
	...(truncated ? { truncated: true as const } : {}),
})

describe("transcript view", () => {
	it("marks only the replies Checkfu shortened", () => {
		const html = renderToStaticMarkup(<Transcript events={[reply(1, false), reply(2, true)]} />)
		expect(html.match(/Checkfu shortened this reply/gu)).toHaveLength(1)
		expect(html.indexOf("Checkfu shortened")).toBeGreaterThan(html.indexOf("reply 2"))
	})
	it("keeps previews last and the cross-page answer on the waiting tool", () => {
		const fixture = makeTranscriptFixture(100)
		const events = eventsOf({
			pages: [fixture.page(), fixture.page(fixture.newest - fixture.pageSize)],
			pageParams: [undefined, String(fixture.newest - fixture.pageSize)],
		})
		const preview = previewEvents("evt_preview", "Partial response").reduce<
			ReturnType<typeof accumulateSessionEvent>
		>(accumulateSessionEvent, undefined)
		const html = renderToStaticMarkup(
			<QueryClientProvider client={new QueryClient()}>
				<Transcript events={events} preview={preview} send={async () => undefined} />
			</QueryClientProvider>,
		)
		const rows = html.match(/<li>.*?<\/li>/gsu) ?? []
		expect(rows).toHaveLength(historyRowCount(100) + 1)
		expect(rows.slice(0, -1).map((row) => row.match(renderedRowMarker)?.[0])).toEqual(
			historyRowMarkers(fixture.newest - 99, fixture),
		)
		expect(rows.at(-1)).toContain("Partial response")
		const actions = rows.filter((row) => row.includes("Send result"))
		expect(actions).toHaveLength(1)
		expect(actions[0]).toContain(waitingCallName)
	})
})
