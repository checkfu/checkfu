import { describe, expect, it } from "@effect/vitest"
import { makeTurnFence } from "../src/Workspace/WorkspaceFence.ts"
import type { TurnToken } from "../src/Workspace/WorkspaceFence.ts"
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context"
import {
	MAX_INLINE_IMAGE_BYTES,
	WORKSPACE_TOOL_OPTIONS,
	workspaceExtension,
	workspaceToolDeclarations,
} from "../src/Workspace/WorkspaceTools.ts"
import type { WorkspaceTool } from "../src/Workspace/WorkspaceTools.ts"

const store = () => {
	let newest: TurnToken | undefined
	return {
		get: () => newest,
		put: (token: TurnToken) => {
			newest = token
		},
	}
}

const turn = (number: number): TurnToken => ({ turn: number })

describe("session workspace", () => {
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
		// A call of the old turn that arrives now is refused, though one of its calls still runs.
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
		const names = ["read", "ls", "find", "grep", "write", "edit", "delete", "git"]
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
			git: "unsafe",
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
			"git",
		])
		expect(declared.every(({ description }) => description.length > 0)).toBe(true)
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

		// A live call carries the turn's signal, so its wait ends with the turn.
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
})
