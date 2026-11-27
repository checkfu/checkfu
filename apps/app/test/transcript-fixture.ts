import type { JsonSession, JsonSessionEvent, JsonSessionEventPreview } from "@checkfu/sdk/client"
import type { EventPage } from "../src/api.ts"

const at = "2026-11-26T00:00:00.000Z"

export const transcriptSizes = [100, 1000, 10_000] as const
export const waitingCallId = "tu_waiting_fixture"
export const waitingCallName = "waiting_fixture"
const earlierReserve = 800

export const transcriptSession: JsonSession = {
	id: "sess_transcript_fixture",
	type: "session",
	title: "Transcript fixture",
	status: "idle",
	turn: 1,
	agent: {
		type: "agent",
		id: "agent_transcript_fixture",
		version: 1,
		name: "Fixture agent",
		model: { id: "fixture-model" },
		system: null,
		description: null,
		mcp_servers: [],
		tools: [],
	},
	environment_id: "env_transcript_fixture",
	mcp_server_credentials: [],
	resources: [],
	usage: { input_tokens: 60_000, output_tokens: 10_000 },
	created_at: at,
	updated_at: at,
	archived_at: null,
}

const envelope = (seq: number) => ({
	id: `evt_fixture_${seq}`,
	seq,
	created_at: at,
	processed_at: at,
})
const text = (value: string) => [{ type: "text" as const, text: value }]
export const rowLabel = (seq: number) => `Fixture event ${seq}.`
const toolId = (seq: number) => `tu_fixture_${seq}`

const historyEvent = (seq: number): JsonSessionEvent => {
	const entry = envelope(seq)
	switch (seq % 10) {
		case 2:
			return { ...entry, type: "session.status_running", turn: Math.ceil(seq / 10) }
		case 4:
			return {
				...entry,
				type: "agent.tool_use",
				tool_use_id: toolId(seq),
				name: `fixture_read_${seq}`,
				input: { path: `/workspace/fixture-${seq}.txt` },
			}
		case 5:
			return {
				...entry,
				type: "agent.tool_result",
				tool_use_id: toolId(seq - 1),
				content: text(`Read the fixture for event ${seq - 1}.`),
				is_error: false,
			}
		case 1:
		case 8:
			return { ...entry, type: "user.message", content: text(rowLabel(seq)) }
		case 3:
		case 7:
			return { ...entry, type: "system.message", content: text(rowLabel(seq)) }
		default:
			return { ...entry, type: "agent.message", content: text(rowLabel(seq)) }
	}
}

export const makeTranscriptFixture = (size: number) => {
	const pageSize = size === 100 ? 50 : 100
	const newest = earlierReserve + size
	const waitingSeq = newest - pageSize
	const events = Array.from({ length: newest }, (_, index): JsonSessionEvent => {
		const seq = index + 1
		if (seq === waitingSeq) {
			return {
				...envelope(seq),
				type: "agent.custom_tool_use",
				tool_use_id: waitingCallId,
				name: waitingCallName,
				input: { item: "fixture" },
			}
		}
		if (seq === newest) {
			return {
				...envelope(seq),
				type: "session.status_idle",
				turn: 1,
				stop_reason: { type: "requires_action", event_ids: [waitingCallId] },
			}
		}
		return historyEvent(seq)
	})
	const page = (end = newest): EventPage => {
		const start = Math.max(0, end - pageSize)
		return {
			data: events.slice(start, end).reverse(),
			next_page: start === 0 ? null : String(start),
		}
	}
	return { newest, waitingSeq, pageSize, page }
}

export const historyRowMarkers = (
	start: number,
	fixture: ReturnType<typeof makeTranscriptFixture>,
): ReadonlyArray<string> => {
	const markers: Array<string> = []
	for (let seq = start; seq < fixture.newest; seq++) {
		if (seq === fixture.waitingSeq) {
			markers.push(waitingCallName)
		} else if (seq % 10 === 4) {
			markers.push(`fixture_read_${seq}`)
		} else if (seq % 10 !== 2 && seq % 10 !== 5) {
			markers.push(rowLabel(seq))
		}
	}
	return markers
}

export const renderedRowMarker = /Fixture event \d+\.|fixture_read_\d+|waiting_fixture/u

export const historyRowCount = (eventCount: number) => (eventCount / 10) * 8 - 1

export const reply = (seq: number): JsonSessionEvent => ({
	...envelope(seq),
	type: "agent.message",
	content: text(rowLabel(seq)),
})

export const appendBatch = (after: number): ReadonlyArray<JsonSessionEvent> => [
	{ ...envelope(after + 1), type: "system.message", content: text(rowLabel(after + 1)) },
	{ ...envelope(after + 2), type: "system.message", content: text(rowLabel(after + 2)) },
	reply(after + 3),
]

export const previewEvents = (
	id: string,
	value: string,
): ReadonlyArray<JsonSessionEventPreview> => [
	{ type: "event_start", event: { id, type: "agent.message" } },
	{
		type: "event_delta",
		event_id: id,
		delta: { type: "content_delta", index: 0, content: { type: "text", text: value } },
	},
]
