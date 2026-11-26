import type { JsonSessionEvent } from "@checkfu/sdk/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Transcript } from "../src/pages/transcript.tsx"

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
})
