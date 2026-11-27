import { describe, expect, it } from "@effect/vitest"
import { RESERVED_TOOL_NAMES } from "@checkfu/sdk/Api"
import { allowedHostsOf } from "../src/Pi/PiDurableHarness.ts"
import { mcpHostAllowed } from "@checkfu/domain/Mcp/McpServers"
import { readArtifactDataResult } from "../src/Workspace/ArtifactDataTool.ts"
import { createMachineEgress } from "../src/Workspace/MachineEgress.ts"
import { makeTurnFence } from "../src/Workspace/WorkspaceFence.ts"
import type { FencedTurn, TurnToken } from "../src/Workspace/WorkspaceFence.ts"
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context"
import {
	MAX_INLINE_IMAGE_BYTES,
	WORKSPACE_TOOL_OPTIONS,
	workspaceExtension,
	workspaceToolDeclarations,
} from "../src/Workspace/WorkspaceTools.ts"
import type { WorkspaceTool } from "../src/Workspace/WorkspaceTools.ts"

const store = () => {
	let newest: FencedTurn | undefined
	return {
		get: () => newest,
		put: (fenced: FencedTurn) => {
			newest = fenced
		},
	}
}

const untilAborted = (signal: AbortSignal): Promise<string> =>
	new Promise((resolve) => {
		signal.addEventListener("abort", () => resolve("stopped"), { once: true })
	})

const turn = (number: number): TurnToken => ({ turn: number })

describe("session workspace", () => {
	it("reads a large artifact data result without clipping a line or splitting UTF-8", async () => {
		const text = JSON.stringify({ data: "x".repeat(4086) + "🔒".repeat(4000) })
		const bytes = new TextEncoder().encode(text)
		const stream = async (offset: number, length: number) =>
			new Blob([bytes.slice(offset, offset + length)]).stream()
		let offset: number | null = 0
		let full = ""
		while (offset !== null) {
			const result = await readArtifactDataResult(offset, stream)
			expect(result.isError).toBe(false)
			const part = result.content[0]
			if (part?.type !== "text") {
				throw new Error("Expected a text result")
			}
			const chunk = JSON.parse(part.text) as { text: string; next_byte_offset: number | null }
			full += chunk.text
			if (chunk.next_byte_offset !== null) {
				expect(chunk.next_byte_offset).toBeGreaterThan(offset)
			}
			offset = chunk.next_byte_offset
		}
		expect(full).toBe(text)
	})

	it("admits the newest turn and refuses every older one", async () => {
		const fence = makeTurnFence(store())
		expect(await fence.enter(turn(1))).toBe(true)
		expect(await fence.enter(turn(1))).toBe(true)
		expect(await fence.enter(turn(2))).toBe(true)
		expect(await fence.enter(turn(1))).toBe(false)
		expect(await fence.run(turn(1), () => Promise.resolve("written"))).toBeUndefined()
		expect(await fence.run(turn(2), () => Promise.resolve("written"))).toBe("written")
	})

	it("admits a turn only after the calls of the turn before it have finished", async () => {
		const fence = makeTurnFence(store())
		await fence.enter(turn(1))
		const order: Array<string> = []
		let finishWrite: () => void = () => undefined
		const write = fence.run(turn(1), async () => {
			order.push("old write started")
			await new Promise<void>((resolve) => {
				finishWrite = resolve
			})
			order.push("old write finished")
		})
		const entering = fence.enter(turn(2)).then((entered) => {
			order.push(`new turn entered: ${entered}`)
		})
		expect(await fence.run(turn(1), () => Promise.resolve("late"))).toBeUndefined()
		await Promise.resolve()
		expect(order).toEqual(["old write started"])
		finishWrite()
		await Promise.all([write, entering])
		expect(order).toEqual(["old write started", "old write finished", "new turn entered: true"])
	})

	it("refuses a turn that a later one overtook while it waited for running calls", async () => {
		const fence = makeTurnFence(store())
		await fence.enter(turn(1))
		let finish: () => void = () => undefined
		const write = fence.run(
			turn(1),
			() =>
				new Promise<void>((resolve) => {
					finish = resolve
				}),
		)
		const second = fence.enter(turn(2))
		const third = fence.enter(turn(3))
		finish()
		await write
		expect(await second).toBe(false)
		expect(await third).toBe(true)
	})

	it("stops the calls of the turn a newer one replaces before it waits for them, and no others", async () => {
		const fence = makeTurnFence(store())
		await fence.enter(turn(1))
		const order: Array<string> = []
		const clone = fence.run(turn(1), async (signal) => {
			order.push(await untilAborted(signal))
		})
		const again = fence.enter(turn(1))
		expect(await fence.enter(turn(0))).toBe(false)
		await Promise.resolve()
		expect(order).toEqual([])
		expect(await fence.enter(turn(2))).toBe(true)
		await clone
		expect(order).toEqual(["stopped"])
		expect(await again).toBe(false)
		expect(await fence.run(turn(2), async (signal) => signal.aborted)).toBe(false)
	})

	it("stops an interrupted turn's calls, and refuses its later calls even after a restart", async () => {
		const kept = store()
		const fence = makeTurnFence(kept)
		await fence.enter(turn(1))
		const running = fence.run(turn(1), untilAborted)
		fence.interrupt(turn(0))
		fence.interrupt(turn(1))
		expect(await running).toBe("stopped")
		expect(await fence.run(turn(1), () => Promise.resolve("written"))).toBeUndefined()
		const restarted = makeTurnFence(kept)
		expect(await restarted.run(turn(1), () => Promise.resolve("written"))).toBeUndefined()
		expect(await restarted.enter(turn(1))).toBe(false)
		expect(await restarted.enter(turn(2))).toBe(true)
		expect(await restarted.run(turn(2), () => Promise.resolve("written"))).toBe("written")
	})

	it("refuses a turn interrupted before it entered", async () => {
		const fence = makeTurnFence(store())
		await fence.enter(turn(1))
		fence.interrupt(turn(2))
		expect(await fence.enter(turn(2))).toBe(false)
		expect(await fence.enter(turn(1))).toBe(false)
		expect(await fence.enter(turn(3))).toBe(true)
	})

	it("drains the calls already running, and not one that starts later", async () => {
		const fence = makeTurnFence(store())
		await fence.enter(turn(1))
		const order: Array<string> = []
		let finish: () => void = () => undefined
		const write = fence.run(turn(1), async () => {
			await new Promise<void>((resolve) => {
				finish = resolve
			})
			order.push("write finished")
		})
		const drained = fence.drain().then(() => order.push("drained"))
		finish()
		await Promise.all([write, drained])
		expect(order).toEqual(["write finished", "drained"])
	})

	it("lets Pi run again only the tools that change nothing", () => {
		const tool = (name: string): WorkspaceTool => ({
			name,
			description: name,
			parameters: { type: "object", properties: {} },
		})
		const names = [
			"read",
			"ls",
			"find",
			"grep",
			"write",
			"edit",
			"delete",
			"bash",
			"save_artifact",
			"artifact_data",
		]
		const { tools } = workspaceExtension(names.map(tool), () =>
			Promise.resolve({ content: [], isError: false }),
		)
		expect(Object.fromEntries((tools ?? []).map(({ name, replay }) => [name, replay]))).toEqual({
			read: "safe",
			ls: "safe",
			find: "safe",
			grep: "safe",
			write: "unsafe",
			edit: "unsafe",
			delete: "unsafe",
			bash: "unsafe",
			save_artifact: "unsafe",
			artifact_data: "unsafe",
		})
	})

	it("declares the workspace tools without a workspace to read", async () => {
		const declared = await workspaceToolDeclarations()
		expect(declared.map(({ name }) => name)).toEqual([
			"read",
			"ls",
			"find",
			"grep",
			"write",
			"edit",
			"delete",
			"bash",
			"save_artifact",
			"artifact_data",
		])
		expect(
			declared.map(({ name }) => name).filter((name) => !RESERVED_TOOL_NAMES.includes(name)),
		).toEqual([])
		expect(declared.every(({ description }) => description.length > 0)).toBe(true)
		const grep = declared.find(({ name }) => name === "grep")
		expect(Object.keys(grep?.parameters.properties ?? {})).toEqual([
			"path",
			"query",
			"include",
			"exclude",
			"ignoreCase",
			"context",
			"limit",
			"offset",
		])
		expect(JSON.stringify(grep?.parameters)).not.toContain("regular expression")
		expect(grep?.description).toContain("matched as written")
	})

	it("sends nothing to the workspace for a call whose turn was interrupted", async () => {
		const sent: Array<{ readonly name: string; readonly signal: AbortSignal | undefined }> = []
		const { tools } = workspaceExtension(
			[{ name: "write", description: "write", parameters: { type: "object", properties: {} } }],
			(call, signal) => {
				sent.push({ name: call.name, signal })
				return Promise.resolve({ content: [{ type: "text", text: "written" }], isError: false })
			},
		)
		const write = tools?.[0]
		if (write === undefined) {
			throw new Error("The write tool is missing.")
		}
		const api = { callId: "call-1" } as Parameters<typeof write.execute>[1]
		const interrupted = new AbortController()
		interrupted.abort()
		expect(
			await write.execute(
				{ path: "/workspace/a" },
				api,
				withAbortSignal(interrupted.signal, BACKGROUND_CONTEXT),
			),
		).toEqual({
			output: [{ type: "text", text: "The turn was interrupted before this call ran." }],
			isError: true,
		})
		expect(sent).toEqual([])

		const live = new AbortController()
		expect(
			await write.execute(
				{ path: "/workspace/a" },
				api,
				withAbortSignal(live.signal, BACKGROUND_CONTEXT),
			),
		).toEqual({ output: [{ type: "text", text: "written" }], isError: false })
		expect(sent.map(({ name }) => name)).toEqual(["write"])
		expect(sent[0]?.signal?.aborted).toBe(false)
		live.abort()
		expect(sent[0]?.signal?.aborted).toBe(true)
	})

	it("sends an image inline only as large as one stored tool result can hold", async () => {
		const { createPiTools } = await import("@cloudflare/computer/tools/pi-ai")
		const png = (size: number) => {
			const bytes = new Uint8Array(size)
			bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
			return bytes
		}
		const files = new Map([
			["/workspace/small.png", png(1000)],
			["/workspace/large.png", png(MAX_INLINE_IMAGE_BYTES + 1)],
		])
		const unused = () => Promise.reject(new Error("not used by read"))
		const { execute } = createPiTools({
			...WORKSPACE_TOOL_OPTIONS,
			workspace: {
				fs: {
					stat: (path: string) => {
						const bytes = files.get(path)
						return bytes === undefined
							? Promise.reject(new Error(`ENOENT: ${path}`))
							: Promise.resolve({
									size: bytes.byteLength,
									mtime: 0,
									mode: 0o644,
									isFile: true,
									isDirectory: false,
								})
					},
					readFile: (path: string, options?: { byteOffset?: number; byteLength?: number }) => {
						const bytes = files.get(path) ?? new Uint8Array()
						const start = options?.byteOffset ?? 0
						const end = options?.byteLength === undefined ? undefined : start + options.byteLength
						return Promise.resolve(new Blob([bytes.slice(start, end)]).stream())
					},
					writeFile: unused,
					mkdir: unused,
					rm: unused,
					find: unused,
					grep: unused,
					readdir: unused,
				},
			},
		})
		const read = (path: string) => execute({ id: "call_1", name: "read", arguments: { path } }, {})
		const small = await read("/workspace/small.png")
		expect(small.content.map(({ type }) => type)).toEqual(["text", "image"])
		const large = await read("/workspace/large.png")
		expect(large.content.map(({ type }) => type)).toEqual(["text"])
	})

	it("lets a machine reach the package registries only when its environment allows package managers", async () => {
		const limited = (allow_package_managers: boolean) =>
			allowedHostsOf({
				type: "cloud",
				networking: {
					type: "limited",
					allowed_hosts: ["example.com"],
					allow_mcp_servers: false,
					allow_package_managers,
				},
			})
		const reach = async (allowed: ReadonlyArray<string> | null, url: string) =>
			(
				await createMachineEgress({
					allowedHosts: () => allowed,
					fetch: () => Promise.resolve(new Response("ok")),
				})(new Request(url))
			).status
		expect(limited(false)).toEqual(["example.com"])
		expect(await reach(limited(true), "https://registry.npmjs.org/effect")).toBe(200)
		expect(await reach(limited(true), "https://example.com/")).toBe(200)
		expect(await reach(limited(false), "https://registry.npmjs.org/effect")).toBe(403)
		expect(await reach(limited(true), "https://example.org/")).toBe(403)
		expect(allowedHostsOf({ type: "cloud", networking: { type: "unrestricted" } })).toBeNull()
	})

	it("reads an allowed host the way the MCP servers' check does, port included", async () => {
		const reach = async (allowed: ReadonlyArray<string>, url: string) =>
			(
				await createMachineEgress({
					allowedHosts: () => allowed,
					fetch: () => Promise.resolve(new Response("ok")),
				})(new Request(url))
			).status
		const ported = ["registry.example:8443"]
		expect(await reach(ported, "https://registry.example:8443/pkg")).toBe(200)
		expect(await reach(ported, "https://registry.example/pkg")).toBe(403)
		expect(await reach(["registry.example"], "https://registry.example:8443/pkg")).toBe(403)
		expect(await reach(["registry.example"], "https://REGISTRY.example/pkg")).toBe(200)
		for (const [host, url] of [
			["registry.example:8443", "https://registry.example:8443/pkg"],
			["registry.example", "https://registry.example:8443/pkg"],
		] as const) {
			const networking = {
				type: "limited" as const,
				allowed_hosts: [host],
				allow_mcp_servers: false,
				allow_package_managers: false,
			}
			expect(await reach([host], url)).toBe(
				mcpHostAllowed(networking, new URL(url).host) ? 200 : 403,
			)
		}
	})
})
