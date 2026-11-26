import type { JsonSessionEvent } from "@checkfu/sdk/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type * as SessionFold from "@checkfu/sdk/SessionFold"

const folds = vi.hoisted(() => ({ count: 0 }))

vi.mock("@checkfu/sdk/SessionFold", async (original) => {
	const actual = await original<typeof SessionFold>()
	return {
		...actual,
		foldSessionEvents: (...args: Parameters<typeof actual.foldSessionEvents>) => {
			folds.count += 1
			return actual.foldSessionEvents(...args)
		},
	}
})

const { Transcript } = await import("../src/pages/transcript.tsx")
const { sessionCallsOf } = await import("../src/tool-calls.ts")

const at = "2026-11-24T00:00:00.000Z"
const events: ReadonlyArray<JsonSessionEvent> = [
	{
		id: "evt_1",
		seq: 1,
		created_at: at,
		processed_at: at,
		type: "agent.mcp_tool_use",
		tool_use_id: "tu_1",
		mcp_server_name: "github",
		name: "deploy",
		input: {},
		evaluated_permission: "ask",
	},
	{
		id: "evt_2",
		seq: 2,
		created_at: at,
		processed_at: at,
		type: "session.status_idle",
		turn: 1,
		stop_reason: { type: "requires_action", event_ids: ["tu_1", "tu_0"] },
	},
] as ReadonlyArray<JsonSessionEvent>

describe("the session's tool calls", () => {
	it("fold the history once for the transcript, the waiting calls and the calls still to find", () => {
		folds.count = 0
		const calls = sessionCallsOf(events)
		const html = renderToStaticMarkup(
			<QueryClientProvider client={new QueryClient()}>
				<Transcript events={events} calls={calls.fold} send={async () => undefined} />
			</QueryClientProvider>,
		)
		expect(folds.count).toBe(1)
		expect([...calls.waiting]).toEqual(["tu_1", "tu_0"])
		expect(calls.unseen).toEqual(["tu_0"])
		expect(html).toContain("deploy")
	})
})
