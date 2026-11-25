import { describe, expect, it } from "@effect/vitest"
import type { TranscriptContext } from "@earendil-works/pi-ai"
import * as Effect from "effect/Effect"
import { runPiDurableTurn } from "../src/Pi/PiDurableEngine.ts"
import { createCheckfuRegistry } from "../src/Pi/PiRefusals.ts"
import { grepWithin, refusedFind } from "../src/Workspace/WorkspacePaging.ts"
import type { PagingFiles } from "../src/Workspace/WorkspacePaging.ts"
import {
	MAX_INLINE_IMAGE_BYTES,
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
		}
		const page = JSON.parse(
			textOf(await grepWithin(files, { query: "match", context: 10, offset: 7 }, maxBytes / 8)),
		) as { count: number; nextOffset?: number; matches: ReadonlyArray<{ context?: unknown }> }
		expect(page.count).toBeGreaterThanOrEqual(1)
		expect(page.nextOffset).toBe(7 + page.count)
	})

	it("scans once per call for a page of matches, and ends a page at its byte budget", async () => {
		const line = "match ".repeat(20_000)
		const asked: Array<readonly [number, number]> = []
		const files: PagingFiles = {
			grep: (_query, path, options) => {
				asked.push([options.offset, options.limit])
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
		}
		const { maxBytes } = workspaceOutputLimits("grep")
		const budget = maxBytes / 8
		const page = await grepWithin(files, { query: "match", context: 1, limit: 1000 }, budget)
		expect(page.isError).toBe(false)
		expect(new TextEncoder().encode(textOf(page)).byteLength).toBeLessThanOrEqual(budget)
		const parsed = JSON.parse(textOf(page)) as { count: number; nextOffset?: number; note?: string }
		expect(parsed.count).toBeGreaterThan(0)
		expect(parsed.nextOffset).toBe(parsed.count)
		expect(parsed.note).toContain("nextOffset")
		expect(asked).toEqual([[0, 21]])

		const short: PagingFiles = {
			...files,
			grep: (_query, path, options) =>
				Promise.resolve(
					Array.from(
						{ length: Math.max(0, Math.min(25, options.offset + options.limit) - options.offset) },
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
		expect(first).toMatchObject({ count: 20, nextOffset: 20 })
		const last = JSON.parse(
			textOf(await grepWithin(short, { query: "match", offset: 20 }, maxBytes)),
		) as { count: number; nextOffset?: number }
		expect(last.count).toBe(5)
		expect(last).not.toHaveProperty("nextOffset")
	})

	it("searches for a pattern only where its matching time is bounded", async () => {
		const asked: Array<boolean> = []
		const files = (bounded: boolean) => ({
			boundsPatterns: (path: string) => bounded && path === "/workspace",
			grep: (_: string, __: string, options: { readonly regex: boolean }) => {
				asked.push(options.regex)
				return Promise.resolve([])
			},
		})
		const refused = await grepWithin(files(false), { query: "(a+)+$", regex: true }, 1024)
		expect(refused.isError).toBe(true)
		expect(textOf(refused)).toContain("the text as written")
		expect((await grepWithin(files(false), { query: "(a+)+$" }, 1024)).isError).toBe(false)
		expect((await grepWithin(files(true), { query: "(a+)+$", regex: true }, 1024)).isError).toBe(
			false,
		)
		const elsewhere = await grepWithin(
			files(true),
			{ query: "(a+)+$", regex: true, path: "/mnt/memory" },
			1024,
		)
		expect(elsewhere.isError).toBe(true)
		expect(asked).toEqual([false, true])
	})

	it("takes only a glob it can match in bounded time, for the files a search reads and the ones find lists", async () => {
		let searched = 0
		const files: PagingFiles = {
			grep: () => {
				searched += 1
				return Promise.resolve([])
			},
		}
		const wide = "**/*a*a*a*a*b"
		const long = `${"a".repeat(260)}.ts`
		for (const globs of [{ include: wide }, { exclude: [wide] }, { include: ["**/*.ts", long] }]) {
			const refused = await grepWithin(files, { query: "x", ...globs }, 1024)
			expect([refused.isError, textOf(refused)]).toEqual([
				true,
				expect.stringContaining("at most 4 runs of *"),
			])
		}
		expect(searched).toBe(0)
		const taken = await grepWithin(
			files,
			{
				query: "x",
				include: "**/__tests__/**/*.test.*",
				exclude: ["node_modules/**", "**/.git/**"],
			},
			1024,
		)
		expect([taken.isError, searched]).toEqual([false, 1])

		expect(refusedFind({ pattern: wide })?.isError).toBe(true)
		expect(refusedFind({ pattern: "**/*.ts", exclude: wide })?.isError).toBe(true)
		expect(refusedFind({ pattern: "**/*.ts", exclude: [long] })?.isError).toBe(true)
		expect(refusedFind({ pattern: "src/**/*.{ts,tsx}", exclude: ["**/dist/**"] })).toBeUndefined()
		expect(refusedFind({ path: "/workspace" })).toBeUndefined()
	})

	it("keeps a grep page that ends early within its budget, note included", async () => {
		const { maxBytes } = workspaceOutputLimits("grep")
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
			}
			const page = await grepWithin(files, { query: "m", limit: 1000 }, maxBytes)
			expect([length, new TextEncoder().encode(textOf(page)).byteLength <= maxBytes]).toEqual([
				length,
				true,
			])
		}
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

	it("holds grep's whole result to what one call returns: the query it echoes, and an error's text", async () => {
		const { maxBytes } = workspaceOutputLimits("grep")
		const long = "q".repeat(80_000)
		const empty: PagingFiles = { grep: () => Promise.resolve([]) }
		const failing: PagingFiles = {
			grep: () => Promise.reject(new Error(`Invalid regular expression: /${long}/`)),
		}
		for (const files of [empty, failing]) {
			const page = boundWorkspaceResult("grep", await grepWithin(files, { query: long }, 1024))
			expect([page.isError, new TextEncoder().encode(textOf(page)).byteLength <= maxBytes]).toEqual(
				[true, true],
			)
		}
	})
})
