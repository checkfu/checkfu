import { describe, expect, it } from "@effect/vitest"
import { conversationName, parseConversation } from "../src/Pi/PiConversation.ts"
import { makeTurnFence } from "../src/Workspace/WorkspaceFence.ts"
import type { TurnToken } from "../src/Workspace/WorkspaceFence.ts"
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context"
import { workspaceExtension, workspaceToolDeclarations } from "../src/Workspace/WorkspaceTools.ts"
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

const turn = (generation: number, number: number): TurnToken => ({ generation, turn: number })

describe("session workspace", () => {
	it("admits the newest turn and refuses every older one, by generation and then turn", async () => {
		const fence = makeTurnFence(store())
		expect(await fence.enter(turn(0, 1))).toBe(true)
		expect(await fence.enter(turn(0, 1))).toBe(true)
		// An interrupted turn keeps its generation; the turn after it is still newer.
		expect(await fence.enter(turn(0, 2))).toBe(true)
		expect(await fence.enter(turn(0, 1))).toBe(false)
		expect(await fence.run(turn(0, 1), () => Promise.resolve("written"))).toBeUndefined()
		expect(await fence.run(turn(0, 2), () => Promise.resolve("written"))).toBe("written")
		// An abandoned turn moves the generation on, whatever the turn number.
		expect(await fence.enter(turn(1, 2))).toBe(true)
		expect(await fence.run(turn(0, 9), () => Promise.resolve("written"))).toBeUndefined()
	})

	it("admits a turn only after the calls of the turn before it have finished", async () => {
		const fence = makeTurnFence(store())
		await fence.enter(turn(0, 1))
		const order: Array<string> = []
		let finishWrite: () => void = () => undefined
		const write = fence.run(turn(0, 1), async () => {
			order.push("old write started")
			await new Promise<void>((resolve) => {
				finishWrite = resolve
			})
			order.push("old write finished")
		})
		const entering = fence.enter(turn(0, 2)).then((entered) => {
			order.push(`new turn entered: ${entered}`)
		})
		// A call of the old turn that arrives now is refused, though one of its calls still runs.
		expect(await fence.run(turn(0, 1), () => Promise.resolve("late"))).toBeUndefined()
		await Promise.resolve()
		expect(order).toEqual(["old write started"])
		finishWrite()
		await Promise.all([write, entering])
		expect(order).toEqual(["old write started", "old write finished", "new turn entered: true"])
	})

	it("refuses a turn that a later one overtook while it waited for running calls", async () => {
		const fence = makeTurnFence(store())
		await fence.enter(turn(0, 1))
		let finish: () => void = () => undefined
		const write = fence.run(
			turn(0, 1),
			() =>
				new Promise<void>((resolve) => {
					finish = resolve
				}),
		)
		const second = fence.enter(turn(0, 2))
		const third = fence.enter(turn(0, 3))
		finish()
		await write
		expect(await second).toBe(false)
		expect(await third).toBe(true)
	})

	it("drains the calls already running, and not one that starts later", async () => {
		const fence = makeTurnFence(store())
		await fence.enter(turn(0, 1))
		const order: Array<string> = []
		let finish: () => void = () => undefined
		const write = fence.run(turn(0, 1), async () => {
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

	it("reads the session and the generation back from a conversation name", () => {
		expect(parseConversation(conversationName("sess_1", 3))).toEqual({
			sessionId: "sess_1",
			generation: 3,
		})
		expect(parseConversation("0:sess:with:colons")).toEqual({
			sessionId: "sess:with:colons",
			generation: 0,
		})
		for (const name of [
			undefined,
			"",
			"sess_1",
			":sess_1",
			"1:",
			"x:sess_1",
			"-1:sess_1",
			"1.5:s",
		]) {
			expect(() => parseConversation(name)).toThrow("conversation name")
		}
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
})
