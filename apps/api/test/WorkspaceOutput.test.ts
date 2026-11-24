import { describe, expect, it } from "@effect/vitest"
import type { TranscriptContext } from "@earendil-works/pi-ai"
import * as Effect from "effect/Effect"
import { runPiDurableTurn } from "../src/Pi/PiDurableEngine.ts"
import { createCheckfuRegistry } from "../src/Pi/PiRefusals.ts"
import { grepWithin, readLongLine } from "../src/Workspace/WorkspacePaging.ts"
import type { PagingFiles } from "../src/Workspace/WorkspacePaging.ts"
import {
	READ_PAGE_BYTES,
	WORKSPACE_TOOL_OPTIONS,
	boundWorkspaceResult,
	workspaceExtension,
	workspaceOutputLimits,
	workspaceToolDeclarations,
} from "../src/Workspace/WorkspaceTools.ts"
import type { WorkspaceToolResult } from "../src/Workspace/WorkspaceTools.ts"
import { makeAssistantReply, makeScriptedPiModels } from "./helpers/ApiHarness.ts"
import { createInMemoryPiDurableBackend } from "./helpers/InMemoryPiBackend.ts"

const unused = () => Promise.reject(new Error("not used by read"))

// A filesystem holding one file, as far as `read` needs one.
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
		// Quotes, backslashes and control characters, which JSON escaping makes longest.
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

	it("keeps a change a success when its result is too large to return", () => {
		const big = "x".repeat(200_000)
		const edited = boundWorkspaceResult("edit", {
			content: [
				{
					type: "text",
					text: JSON.stringify({ path: "/workspace/a", editsApplied: 2, diff: big, patch: big }),
				},
			],
			isError: false,
		})
		expect(edited.isError).toBe(false)
		const kept = JSON.parse(textOf(edited)) as {
			readonly path?: string
			readonly editsApplied?: number
			readonly diff?: string
			readonly note?: string
		}
		expect(kept).toMatchObject({ path: "/workspace/a", editsApplied: 2 })
		expect(kept).not.toHaveProperty("diff")
		expect(kept.note).toContain("diff, patch")

		const committed = boundWorkspaceResult("git", {
			content: [{ type: "text", text: `[main 1a2b3c] Big\n${big}` }],
			isError: false,
		})
		expect(committed.isError).toBe(false)
		expect(textOf(committed).startsWith("[main 1a2b3c] Big")).toBe(true)
		expect(textOf(committed)).toContain("more bytes of its output are not shown")
		expect(new TextEncoder().encode(textOf(committed)).byteLength).toBeLessThanOrEqual(
			workspaceOutputLimits("git").maxBytes,
		)
	})

	it("keeps a shortened change within both limits, however its output is shaped", () => {
		const limits = workspaceOutputLimits("git")
		const within = (result: WorkspaceToolResult) => {
			const text = textOf(result)
			return [
				result.isError,
				new TextEncoder().encode(text).byteLength <= limits.maxBytes,
				text.split("\n").length <= limits.maxLines,
				text.includes("succeeded"),
			]
		}
		// Many small fields: none is left out on its own, so the whole object is too large.
		const fields = Object.fromEntries(
			Array.from({ length: 20_000 }, (_, index) => [`k${index}`, index]),
		)
		expect(
			within(
				boundWorkspaceResult("git", {
					content: [{ type: "text", text: JSON.stringify(fields) }],
					isError: false,
				}),
			),
		).toEqual([false, true, true, true])
		// A short line many times: under the byte limit, over the line limit.
		expect(
			within(
				boundWorkspaceResult("git", {
					content: [{ type: "text", text: "ok\n".repeat(3000) }],
					isError: false,
				}),
			),
		).toEqual([false, true, true, true])
	})

	it("moves a grep page on when its first match does not fit with its context", async () => {
		const { maxBytes } = workspaceOutputLimits("grep")
		const escaped = '"\\'.repeat(400)
		const files: PagingFiles = {
			grep: (_query, path, options) =>
				Promise.resolve(
					Array.from({ length: options.limit }, (_, index) => ({
						path,
						line: options.offset + index + 100,
						text: `match ${escaped}`,
						context: Array.from({ length: 20 }, (_, at) => ({
							line: at,
							text: escaped,
							isMatch: false,
						})),
					})),
				),
			stat: () => Promise.reject(new Error("not used")),
			readFile: () => Promise.reject(new Error("not used")),
		}
		const page = JSON.parse(
			textOf(await grepWithin(files, { query: "match", context: 10, offset: 7 }, maxBytes / 8)),
		) as { count: number; nextOffset?: number; matches: ReadonlyArray<{ context?: unknown }> }
		expect(page.count).toBeGreaterThanOrEqual(1)
		expect(page.nextOffset).toBe(7 + page.count)
	})

	it("collects grep matches a batch at a time and ends a page at its byte budget", async () => {
		const line = "match ".repeat(20_000)
		const asked: Array<number> = []
		const files: PagingFiles = {
			grep: (_query, path, options) => {
				asked.push(options.limit)
				const total = 300
				const from = options.offset
				const to = Math.min(total, from + options.limit)
				return Promise.resolve(
					Array.from({ length: Math.max(0, to - from) }, (_, index) => ({
						path: `${path}/file.min.js`,
						line: from + index + 1,
						text: line,
						context: [{ line: from + index, text: line, isMatch: false }],
					})),
				)
			},
			stat: () => Promise.reject(new Error("not used")),
			readFile: () => Promise.reject(new Error("not used")),
		}
		const { maxBytes } = workspaceOutputLimits("grep")
		const page = await grepWithin(files, { query: "match", context: 1 }, maxBytes)
		expect(page.isError).toBe(false)
		expect(new TextEncoder().encode(textOf(page)).byteLength).toBeLessThanOrEqual(maxBytes)
		const parsed = JSON.parse(textOf(page)) as { count: number; nextOffset?: number; note?: string }
		expect(parsed.count).toBeGreaterThan(0)
		expect(parsed.nextOffset).toBe(parsed.count)
		expect(parsed.note).toContain("nextOffset")
		expect(Math.max(...asked)).toBeLessThanOrEqual(20)

		const short: PagingFiles = {
			...files,
			grep: (_query, path, options) =>
				Promise.resolve(
					Array.from(
						{ length: Math.max(0, Math.min(250, options.offset + options.limit) - options.offset) },
						(_, index) => ({
							path,
							line: options.offset + index + 1,
							text: "match",
						}),
					),
				),
		}
		const first = JSON.parse(textOf(await grepWithin(short, { query: "match" }, maxBytes))) as {
			count: number
			nextOffset?: number
		}
		expect(first).toMatchObject({ count: 200, nextOffset: 200 })
		const last = JSON.parse(
			textOf(await grepWithin(short, { query: "match", offset: 200 }, maxBytes)),
		) as { count: number; nextOffset?: number }
		expect(last.count).toBe(50)
		expect(last).not.toHaveProperty("nextOffset")
	})

	it("keeps a grep page that ends early within its budget, note included", async () => {
		const { maxBytes } = workspaceOutputLimits("grep")
		// Lines of every length, so that some page fills its budget to within a note's length.
		for (let length = 50; length <= 500; length += 7) {
			const files: PagingFiles = {
				grep: (_query, path, options) =>
					Promise.resolve(
						Array.from({ length: options.limit }, (_, index) => ({
							path,
							line: options.offset + index + 1,
							text: "m".repeat(length),
						})),
					),
				stat: () => Promise.reject(new Error("not used")),
				readFile: () => Promise.reject(new Error("not used")),
			}
			const page = await grepWithin(files, { query: "m", limit: 1000 }, maxBytes)
			expect([length, new TextEncoder().encode(textOf(page)).byteLength <= maxBytes]).toEqual([
				length,
				true,
			])
		}
	})

	it("reads a line longer than a page in byte slices that join back into the line", async () => {
		const line = `${'{"k":"välue"},'.repeat(12_000)}`
		const bytes = new TextEncoder().encode(`short first line\n${line}\nlast\n`)
		const fs = oneFile("/workspace/data.min.json", bytes)
		const { createPiTools } = await import("@cloudflare/computer/tools/pi-ai")
		const { execute } = createPiTools({ ...WORKSPACE_TOOL_OPTIONS, workspace: { fs } })
		const files: PagingFiles = { ...fs, grep: () => Promise.reject(new Error("not used")) }
		interface ReadPosition {
			readonly offset?: number
			readonly byteOffset?: number
			readonly limit: number
		}
		const read = async (args: ReadPosition) => {
			const result = await execute(
				{ id: "call", name: "read", arguments: { path: "/workspace/data.min.json", ...args } },
				{},
			)
			const text = textOf(result)
			if (!result.isError) {
				return text
			}
			const page = await readLongLine(
				files,
				{ path: "/workspace/data.min.json", ...args },
				READ_PAGE_BYTES,
			)
			return page === undefined ? text : textOf(page)
		}
		let joined = ""
		let next: ReadPosition = { offset: 2, limit: 1 }
		for (let pages = 0; pages < 20; pages += 1) {
			const page = JSON.parse(await read(next)) as {
				content: string
				nextOffset?: number
				nextByteOffset?: number
			}
			joined += page.content
			if (page.nextByteOffset === undefined || joined.length >= line.length) {
				break
			}
			next = { offset: page.nextOffset ?? 2, byteOffset: page.nextByteOffset, limit: 1 }
		}
		expect(joined.startsWith(line)).toBe(true)
	})
})
