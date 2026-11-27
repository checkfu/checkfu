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
	const server = async (options: Parameters<typeof startScriptedMcpServer>[0] = {}) => {
		const started = await startScriptedMcpServer(options)
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

	it.each([
		["2025-11-25", true],
		["2026-07-28", false],
	] as const)(
		"uses the cancellation mechanism for protocol %s",
		async (protocolVersion, sendsNotice) => {
			const upstream = await server({ protocolVersion, stream: "silent" })
			const caller = makeMcpCaller({ capacity: 1 })
			const giver = new AbortController()
			const peer: McpPeer = {
				url: upstream.url,
				exit: (_target, call) =>
					call.signal?.aborted === true
						? { refused: "The turn was interrupted." }
						: { token: null },
			}
			const running = caller.call("docs", peer, scope(giver.signal), echo, {
				text: "slow",
			})
			await expect.poll(() => upstream.streamedRequests).toHaveLength(1)
			giver.abort()
			expect(await running).toMatchObject({ ok: false, interrupted: true })
			expect(upstream.methods.includes("initialize")).toBe(sendsNotice)
			await expect.poll(() => upstream.closedStreams).toEqual(upstream.streamedRequests)
			expect(upstream.methods.includes("notifications/cancelled")).toBe(sendsNotice)
			expect(upstream.cancellations).toEqual(sendsNotice ? upstream.streamedRequests : [])
		},
	)

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

	it("times out tool listing sooner than a tool call", async () => {
		const upstream = await server()
		const caller = makeMcpCaller({ capacity: 1, listTimeoutMs: 350 })
		const letThrough = upstream.holdHandshakes()
		try {
			expect(await caller.list("docs", peerOf(upstream), scope())).toEqual({
				ok: false,
				message: "The MCP server did not answer within 0.35 seconds.",
			})
			expect(handshakes(upstream)).toBe(1)
		} finally {
			letThrough()
		}
		expect(
			await caller.call("docs", peerOf(upstream), scope(), echo, {
				text: "still running",
				delay_ms: 500,
			}),
		).toMatchObject({ ok: true, isError: false })
	})

	it("returns at the listing deadline when the server also holds its cancellation response", async () => {
		const upstream = await server()
		const caller = makeMcpCaller({ capacity: 1, listTimeoutMs: 500 })
		expect(await caller.list("docs", peerOf(upstream), scope())).toMatchObject({ ok: true })
		const releaseList = upstream.holdMethod("tools/list")
		const releaseCancel = upstream.holdMethod("notifications/cancelled")
		const started = performance.now()
		try {
			expect(await caller.list("docs", peerOf(upstream), scope())).toEqual({
				ok: false,
				message: "The MCP server did not answer within 0.5 seconds.",
			})
			expect(performance.now() - started).toBeLessThan(2500)
			await expect.poll(() => upstream.methods.includes("notifications/cancelled")).toBe(true)
		} finally {
			releaseList()
			releaseCancel()
		}
	}, 10_000)

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
