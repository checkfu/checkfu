import { describe, expect, it } from "@effect/vitest"
import type { TranscriptContext } from "@earendil-works/pi-ai"
import * as Effect from "effect/Effect"
import { runPiDurableTurn } from "../src/Pi/PiDurableEngine.ts"
import { createCheckfuRegistry } from "../src/Pi/PiRefusals.ts"
import {
	MAX_INLINE_IMAGE_BYTES,
	WORKSPACE_TOOL_OPTIONS,
	asLiteral,
	boundWorkspaceResult,
	workspaceExtension,
	workspaceOutputLimits,
	workspaceToolDeclarations,
} from "../src/Workspace/WorkspaceTools.ts"
import type { WorkspaceToolResult } from "../src/Workspace/WorkspaceTools.ts"
import { makeAssistantReply, makeScriptedPiModels } from "./helpers/ApiHarness.ts"
import { createInMemoryPiDurableBackend } from "./helpers/InMemoryPiBackend.ts"

const unused = () => Promise.reject(new Error("not used by read"))

const oneFile = (path: string, bytes: Uint8Array) => ({
	stat: (at: string) =>
		at === path
			? Promise.resolve({
					size: bytes.byteLength,
					mtime: 0,
					mode: 0o644,
					isFile: true,
					isDirectory: false,
				})
			: Promise.reject(new Error(`ENOENT: ${at}`)),
	readFile: (_at: string, options?: { byteOffset?: number; byteLength?: number }) => {
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
})

const textOf = (result: WorkspaceToolResult) =>
	result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")

describe("workspace tool output", () => {
	it("returns a page of a large file through Pi with the offsets of the next page", async () => {
		const line = `${'"\\\u0001\u0002'.repeat(24)}\n`
		const bytes = new TextEncoder().encode(line.repeat(4000))
		const { createPiTools } = await import("@cloudflare/computer/tools/pi-ai")
		const { execute } = createPiTools({
			...WORKSPACE_TOOL_OPTIONS,
			workspace: { fs: oneFile("/workspace/big.txt", bytes) },
		})
		const registry = createCheckfuRegistry()
		registry.install(
			workspaceExtension(await workspaceToolDeclarations(), async (call) => {
				const { content, isError } = await execute(call, {})
				return boundWorkspaceResult(call.name, { content, isError })
			}),
		)
		const contexts: Array<TranscriptContext> = []
		const backend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels((model, context) => {
				contexts.push(context)
				if (contexts.length === 1) {
					return Promise.resolve({
						...makeAssistantReply(model, null, "", 3, 2),
						content: [
							{
								type: "toolCall",
								id: "call-1",
								name: "read",
								arguments: { path: "/workspace/big.txt" },
							},
						],
						stopReason: "toolUse",
					})
				}
				return Promise.resolve(makeAssistantReply(model, null, "read it", 3, 2))
			}),
			1,
			registry,
		)
		try {
			const outcome = await Effect.runPromise(
				runPiDurableTurn(backend, {
					operationId: "turn:1",
					unpublishedOperationIds: [],
					turn: 1,
					provider: "openai",
					modelId: "gpt-4o-mini",
					system: null,
					text: "Read the file.",
				}),
			)
			expect(outcome).toMatchObject({ ok: true, reply: { text: "read it" } })
			const result = contexts[1]?.messages.find((message) => message.role === "toolResult")
			const text =
				result?.role === "toolResult"
					? result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
					: ""
			const page = JSON.parse(text) as {
				readonly content: string
				readonly truncated: boolean
				readonly nextOffset?: number
			}
			expect(page.truncated).toBe(true)
			expect(page.nextOffset).toBeGreaterThan(1)
			expect(page.content.length).toBeGreaterThan(0)
		} finally {
			await backend.close()
		}
	})

	it("refuses in the workspace a result over its tool's limits, saying how to ask for less", () => {
		const { maxBytes, maxLines } = workspaceOutputLimits("grep")
		const fits: WorkspaceToolResult = {
			content: [{ type: "text", text: "a".repeat(maxBytes) }],
			isError: false,
		}
		expect(boundWorkspaceResult("grep", fits)).toBe(fits)

		const long = boundWorkspaceResult("grep", {
			content: [{ type: "text", text: "a".repeat(maxBytes + 1) }],
			isError: false,
		})
		expect(long.isError).toBe(true)
		expect(textOf(long)).toContain("Ask for less")

		const many = boundWorkspaceResult("find", {
			content: [{ type: "text", text: "a\n".repeat(maxLines) }],
			isError: false,
		})
		expect(many.isError).toBe(true)
	})

	it("tells Pi the same limits the workspace keeps to", async () => {
		const { tools } = workspaceExtension(await workspaceToolDeclarations(), () =>
			Promise.reject(new Error("not called")),
		)
		for (const tool of tools ?? []) {
			expect([tool.name, tool.outputLimits]).toEqual([tool.name, workspaceOutputLimits(tool.name)])
		}
	})

	it("tells Pi where Bash keeps working files and saves deliverables", async () => {
		const { tools } = workspaceExtension(await workspaceToolDeclarations(), () =>
			Promise.reject(new Error("not called")),
		)
		const bash = tools?.find(({ name }) => name === "bash")
		expect(bash?.description).toMatch(/\/workspace\b[^.]*working files/u)
		expect(bash?.description).toMatch(
			/deliverables[^.]*\/mnt\/session\/outputs\b[^.]*save them for the user/u,
		)
		expect(bash?.description).toMatch(/uploaded files[^.]*with the file tools/u)
	})

	it("leaves a change that succeeded a success, for Pi to shorten, and caps an edit's diff to fit", () => {
		const big = "x".repeat(200_000)
		for (const tool of ["edit", "write", "delete"]) {
			const changed = { content: [{ type: "text" as const, text: big }], isError: false }
			expect([tool, boundWorkspaceResult(tool, changed)]).toEqual([tool, changed])
		}
		const { maxDiffBytes } = WORKSPACE_TOOL_OPTIONS.edit
		expect(4 * maxDiffBytes + 1024).toBeLessThanOrEqual(workspaceOutputLimits("edit").maxBytes)
	})

	it("cuts a line too long to read, and reads on past it", async () => {
		const line = `${'{"k":"välue"},'.repeat(12_000)}`
		const fs = oneFile(
			"/workspace/data.min.json",
			new TextEncoder().encode(`short first line\n${line}\nlast\n`),
		)
		const { createPiTools } = await import("@cloudflare/computer/tools/pi-ai")
		const { execute } = createPiTools({ ...WORKSPACE_TOOL_OPTIONS, workspace: { fs } })
		const result = await execute(
			{ id: "call", name: "read", arguments: { path: "/workspace/data.min.json" } },
			{},
		)
		const [first, cut, last] = textOf(result).split("\n")
		expect([result.isError, first, last]).toEqual([false, "short first line", "last"])
		expect(line.startsWith((cut ?? "").slice(0, 2000))).toBe(true)
		expect((cut ?? "").length).toBeLessThan(2100)
	})

	it("refuses an image too large to show, rather than reading its bytes as text", async () => {
		const png = new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1)
		png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		const fs = oneFile("/workspace/big.png", png)
		const { createPiTools } = await import("@cloudflare/computer/tools/pi-ai")
		const { execute } = createPiTools({ ...WORKSPACE_TOOL_OPTIONS, workspace: { fs } })
		const result = await execute(
			{ id: "call", name: "read", arguments: { path: "/workspace/big.png" } },
			{},
		)
		expect(result.isError).toBe(true)
		expect(textOf(result)).toContain("inline model output limit")
	})

	it("hands grep to the workspace as a literal search, whatever the call asked for", () => {
		const grep = {
			id: "g",
			name: "grep",
			arguments: { query: "(a+)+$", regex: true, path: "/workspace" },
		}
		expect(asLiteral(grep)).toEqual({ ...grep, arguments: { ...grep.arguments, regex: false } })
		const read = { id: "r", name: "read", arguments: { path: "/workspace/a", regex: true } }
		expect(asLiteral(read)).toBe(read)
	})
})
