import { describe, expect, it } from "@effect/vitest"
import { conversationName, parseConversation } from "../src/Pi/PiConversation.ts"
import { admitGeneration } from "../src/Workspace/WorkspaceFence.ts"
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context"
import { workspaceExtension, workspaceToolDeclarations } from "../src/Workspace/WorkspaceTools.ts"
import type { WorkspaceTool } from "../src/Workspace/WorkspaceTools.ts"

const store = () => {
	let newest: number | undefined
	return {
		get: () => newest,
		put: (generation: number) => {
			newest = generation
		},
	}
}

describe("session workspace", () => {
	it("serves the newest harness generation and refuses every older one", () => {
		const fence = store()
		expect(admitGeneration(fence, 1)).toBe(true)
		expect(admitGeneration(fence, 1)).toBe(true)
		// The next generation opens while the abandoned turn's harness is still running.
		expect(admitGeneration(fence, 2)).toBe(true)
		expect(admitGeneration(fence, 1)).toBe(false)
		expect(admitGeneration(fence, 2)).toBe(true)
		expect(admitGeneration(fence, 5)).toBe(true)
		expect([1, 2, 3, 4].map((generation) => admitGeneration(fence, generation))).toEqual([
			false,
			false,
			false,
			false,
		])
		expect(fence.get()).toBe(5)
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
