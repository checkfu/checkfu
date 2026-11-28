import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"

const fixture = String.raw`import assert from "node:assert/strict"
import { createToolProcessor, relaySession } from "./tools.ts"

let lookups = 0
let replies = 0
const call = { type: "agent.custom_tool_use", id: "tool-1", name: "lookup_order", input: { order_id: "1042" } }
const pause = { type: "session.status_idle", seq: 3, stop_reason: { type: "requires_action", event_ids: [call.id] } }
const confirmation = { type: "agent.mcp_tool_use", id: "mcp-1" }
pause.stop_reason.event_ids.unshift(confirmation.id)
let current = pause
let accepted: object | undefined
let failAfterCommit = false
const sends: Array<object> = []
const saved = new Map<string, object>()
const client = {
	sessions: {
		retrieve: async () => ({ status: "idle", archived_at: null }),
		events: {
			list: (id: string, params: { types: Array<string> }) =>
				(params.types.includes("agent.custom_tool_use") ? [confirmation, call].filter((record) => params.types.includes(record.type)) : accepted === undefined ? [current] : [accepted, current]),
			stream: async (_id: string, params?: { after?: number }) =>
				[call, pause].slice(params?.after === pause.seq - 1 ? 1 : 0),
			send: async (_id: string, payload: { events: Array<object> }) => {
				const result = payload.events[0]!
				assert.equal(saved.size, 1)
				sends.push(result)
				if (sends.length === 1) throw new Error("Connection closed before reading the reply")
				accepted = result
				replies += 1
				if (failAfterCommit) throw new Error("Connection closed after commit")
			},
		},
	},
}
const owner = () => createToolProcessor(client, {
	lookup_order: async () => {
		lookups += 1
		return { status: "shipped" }
	},
}, {
	read: async (key) => saved.get(key),
	write: async (key, result) => { saved.set(key, structuredClone(result)) },
})
await assert.rejects(owner()("sess_1", pause))
await owner()("sess_1", pause)
assert.equal(lookups, 1)
assert.equal(replies, 1)
assert.deepEqual(sends[0], sends[1])
const replayed: Array<Array<object>> = [[], []]
await Promise.all(replayed.map((events, viewer) =>
	relaySession(client, "sess_1", viewer === 0 ? undefined : pause.seq - 1, new AbortController().signal,
		(event) => events.push(event)),
))
assert.deepEqual(replayed, [[call, pause], [pause]])
await owner()("sess_1", pause)
assert.equal(lookups, 1)
assert.equal(replies, 1)
accepted = undefined
current = { ...pause, seq: 8 }
await owner()("sess_1", pause)
assert.equal(lookups, 1)
assert.equal(replies, 1)
saved.clear()
current = pause
failAfterCommit = true
await owner()("sess_2", pause)
assert.equal(lookups, 2)
assert.equal(replies, 2)
assert.equal(sends.length, 3)
`

it("replays owned application tool work independently of stream viewers", () => {
	const guide = readFileSync(
		new URL("../../apps/docs/guides/add-an-agent-to-your-app.mdx", import.meta.url),
		"utf8",
	)
	const source = guide.split("```ts tools.ts\n")[1]?.split("\n```")[0]
	const server = guide.split("```ts server.mts\n")[1]?.split("\n```")[0]
	expect(source).toBeTypeOf("string")
	expect(server).toContain("ownSession(session.id)")
	const relay = server?.split("async function relay")[1]?.split("const json")[0]
	expect(relay).toContain("relaySession")
	expect(relay).not.toContain("processEvent")
	expect(relay).not.toContain("ownSession")
	const directory = mkdtempSync(join(tmpdir(), "checkfu-docs-tools-"))
	try {
		writeFileSync(join(directory, "tools.ts"), source ?? "")
		writeFileSync(join(directory, "verify.ts"), fixture)
		const result = spawnSync("bun", [join(directory, "verify.ts")], { encoding: "utf8" })
		expect(result.error).toBeUndefined()
		expect(result.status, result.stderr).toBe(0)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})
