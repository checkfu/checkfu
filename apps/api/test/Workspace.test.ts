import { describe, expect, it } from "@effect/vitest"
import { conversationName, parseConversation } from "../src/Pi/PiConversation.ts"
import { admitGeneration } from "../src/Workspace/WorkspaceFence.ts"
import { workspaceExtension } from "../src/Workspace/WorkspaceTools.ts"
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
})
