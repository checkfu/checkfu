import { afterEach, describe, expect, it } from "@effect/vitest"
import { VAULT_MCP_IDLE_MS } from "../src/Connection/VaultMcp.ts"
import { makeMcpCaller } from "../src/Pi/PiMcpCaller.ts"
import type { McpPeer } from "../src/Pi/PiMcpCaller.ts"
import { mcpCallScope } from "../src/Pi/PiMcpTypes.ts"
import type { McpToolDescriptor } from "../src/Pi/PiMcpTypes.ts"
import { startScriptedMcpServer } from "./workerd/ScriptedMcpServer.ts"
import type { ScriptedMcpServer } from "./workerd/ScriptedMcpServer.ts"

const echo: McpToolDescriptor = {
	name: "echo",
	description: "Echo a text back.",
	inputSchema: { type: "object", properties: { text: { type: "string" } } },
}

const peerOf = (server: ScriptedMcpServer): McpPeer => ({
	url: server.url,
	exit: () => ({ token: null }),
})

const scope = (signal?: AbortSignal) => mcpCallScope(1, 1024 * 1024, signal)

const handshakes = (server: ScriptedMcpServer) =>
	server.methods.filter((method) => method === "initialize").length

describe("The MCP clients a host keeps", () => {
	const closing: Array<{ readonly close: () => Promise<void> }> = []
	afterEach(async () => {
		await Promise.all(closing.splice(0).map((server) => server.close()))
	})
	const server = async () => {
		const started = await startScriptedMcpServer()
		closing.push(started)
		return started
	}

	it("never closes a client another call was just let in with: with room for one, one of two calls at once is answered and the other told to try again", async () => {
		const [a, b] = [await server(), await server()]
		const caller = makeMcpCaller({ capacity: 1, idleMs: 60_000 })
		const release = [a.holdHandshakes(), b.holdHandshakes()]
		const both = Promise.all([
			caller.list("a", peerOf(a), scope()),
			caller.list("b", peerOf(b), scope()),
		])
		for (const letThrough of release) {
			letThrough()
		}
		const outcomes = await both
		expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
		expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
			{ ok: false, message: expect.stringContaining("Try again shortly"), busy: true },
		])
		const kept = outcomes[0]?.ok === true ? { key: "a", at: a } : { key: "b", at: b }
		expect(await caller.list(kept.key, peerOf(kept.at), scope())).toMatchObject({ ok: true })
		expect(handshakes(kept.at)).toBe(1)
	})

	it("makes room for a new session by closing the client idle longest, while no call is running", async () => {
		const [a, b, c] = [await server(), await server(), await server()]
		const caller = makeMcpCaller({ capacity: 2, idleMs: VAULT_MCP_IDLE_MS })
		expect(await caller.list("a", peerOf(a), scope())).toMatchObject({ ok: true })
		expect(await caller.list("b", peerOf(b), scope())).toMatchObject({ ok: true })
		expect(await caller.list("c", peerOf(c), scope())).toMatchObject({ ok: true })
		expect(await caller.list("b", peerOf(b), scope())).toMatchObject({ ok: true })
		expect([handshakes(a), handshakes(b), handshakes(c)]).toEqual([1, 1, 1])
		expect(await caller.list("a", peerOf(a), scope())).toMatchObject({ ok: true })
		expect([handshakes(a), handshakes(b), handshakes(c)]).toEqual([2, 1, 1])
	})

	it("answers two calls at once for different servers when there is room for both", async () => {
		const [a, b] = [await server(), await server()]
		const caller = makeMcpCaller({ capacity: 2 })
		expect(
			await Promise.all([
				caller.list("a", peerOf(a), scope()),
				caller.list("b", peerOf(b), scope()),
			]),
		).toMatchObject([{ ok: true }, { ok: true }])
	})

	it("lets a client go when its call ends, answered or interrupted, so the next has room", async () => {
		const [a, b, c] = [await server(), await server(), await server()]
		const caller = makeMcpCaller({ capacity: 1, idleMs: 0 })
		expect(await caller.list("a", peerOf(a), scope())).toMatchObject({ ok: true })
		const gaveUp = new AbortController()
		const slow = caller.call("b", peerOf(b), scope(gaveUp.signal), echo, {
			text: "slow",
			delay_ms: 30_000,
		})
		await expect.poll(() => b.methods.includes("tools/call"), { timeout: 5000 }).toBe(true)
		expect(await caller.list("c", peerOf(c), scope())).toMatchObject({ ok: false, busy: true })
		gaveUp.abort()
		expect(await slow).toMatchObject({ ok: false, interrupted: true })
		expect(await caller.list("c", peerOf(c), scope())).toMatchObject({ ok: true })
	})

	it("closes a dropped client only once the call using it ends, and connects again for the next", async () => {
		const a = await server()
		const caller = makeMcpCaller({ capacity: 1, idleMs: 60_000 })
		const running = caller.call("a", peerOf(a), scope(), echo, { text: "kept", delay_ms: 300 })
		await expect.poll(() => a.methods.includes("tools/call"), { timeout: 5000 }).toBe(true)
		await caller.drop(() => true)
		expect(await running).toMatchObject({ ok: true, isError: false })
		expect(await caller.list("a", peerOf(a), scope())).toMatchObject({ ok: true })
		expect(handshakes(a)).toBe(2)
	})

	it("connects again after a handshake that failed once its caller had gone, instead of keeping the failure", async () => {
		const a = await server()
		const caller = makeMcpCaller({ capacity: 1, idleMs: VAULT_MCP_IDLE_MS })
		const release = a.holdHandshakes()
		const gaveUp = new AbortController()
		const first = caller.list("a", peerOf(a), scope(gaveUp.signal))
		await expect.poll(() => handshakes(a), { timeout: 5000 }).toBe(1)
		gaveUp.abort()
		expect(await first).toMatchObject({ ok: false, interrupted: true })
		release()
		expect(await caller.list("a", peerOf(a), scope())).toMatchObject({ ok: true })
		expect(handshakes(a)).toBe(2)
	})

	it("keeps one client for a key: a key given another server gets a client for that server", async () => {
		const [a, b] = [await server(), await server()]
		const caller = makeMcpCaller({ capacity: 1 })
		expect(await caller.list("docs", peerOf(a), scope())).toMatchObject({ ok: true })
		expect(await caller.list("docs", peerOf(b), scope())).toMatchObject({ ok: true })
		expect([handshakes(a), handshakes(b)]).toEqual([1, 1])
	})
})
