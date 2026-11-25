import { describe, expect, it } from "@effect/vitest"
import { makeMemoryMount } from "../src/Workspace/MemoryMount.ts"
import type { MemoryOutcome, SessionMemory } from "../src/Workspace/SessionMemory.ts"

// One store held in a map, served the way the API serves a session's stores. Each call is
// recorded, so a test can see what was asked of the store and in what order.
const fakeMemory = (
	files: Map<string, string>,
	access: "read_write" | "read_only" = "read_write",
	calls: Array<string> = [],
) => {
	const sha = (content: string) => `sha:${content}`
	const ok = (content: string): MemoryOutcome => ({ ok: true, content_sha256: sha(content) })
	const changed: MemoryOutcome = { ok: false, code: "EEXIST", message: "changed" }
	const memory: SessionMemory = {
		mounts: () => Promise.resolve([{ name: "notes", access }]),
		list: () =>
			Promise.resolve(
				[...files].map(([path, content]) => ({ path, size: content.length, updated_at: 1 })),
			),
		read: (_name, path) => {
			calls.push(`read ${path}`)
			const content = files.get(path)
			return Promise.resolve(
				content === undefined ? null : { content, content_sha256: sha(content), updated_at: 1 },
			)
		},
		write: (_name, path, content, exclusive) => {
			calls.push(`write ${path}`)
			if (exclusive && files.has(path)) {
				return Promise.resolve(changed)
			}
			files.set(path, content)
			return Promise.resolve(ok(content))
		},
		remove: (_name, path, expected) => {
			calls.push(`remove ${path}`)
			const now = files.get(path)
			if (now === undefined || (expected !== null && sha(now) !== expected)) {
				return Promise.resolve(changed)
			}
			files.delete(path)
			return Promise.resolve(ok(now))
		},
	}
	return memory
}

const mountOver = (
	files: Map<string, string>,
	options: { readonly access?: "read_write" | "read_only"; readonly calls?: Array<string> } = {},
) => makeMemoryMount(fakeMemory(files, options.access, options.calls))

const code = (operation: Promise<unknown> | undefined) =>
	(operation ?? Promise.resolve()).then(
		() => "ok",
		(error: unknown) => (error as { readonly code?: string }).code ?? String(error),
	)

const body = (text: string | Uint8Array<ArrayBuffer>) => new Blob([text]).stream()
const text = async (mount: ReturnType<typeof mountOver>, rel: string) => {
	const read = await mount.readFile(rel)
	return read === null ? null : new Uint8Array(await new Response(read.body).arrayBuffer())
}

describe("memory mount", () => {
	it("shows a store as directories that exist while a memory is below them", async () => {
		const mount = mountOver(
			new Map([
				["/todo.md", "Ship."],
				["/team/plan/q3.md", "Plan."],
			]),
		)
		expect((await mount.readdir("", {}))?.map(({ name, type }) => [name, type])).toEqual([
			["notes", "dir"],
		])
		expect(
			(await mount.readdir("notes", {}))?.map(({ name, type }) => [name, type]).toSorted(),
		).toEqual([
			["team", "dir"],
			["todo.md", "file"],
		])
		expect(
			(await mount.readdir("notes", { recursive: true }))?.map(({ name }) => name).toSorted(),
		).toEqual(["team", "team/plan", "team/plan/q3.md", "todo.md"])
		expect((await mount.stat("notes/team/plan"))?.type).toBe("dir")
		expect((await mount.stat("notes/todo.md"))?.size).toBe(5)
		expect(await mount.stat("notes/missing")).toBeNull()
		expect(await mount.stat("other")).toBeNull()
		expect(await code(mount.readdir("notes/todo.md", {}))).toBe("ENOTDIR")
	})

	it("removes a directory only with its memories, and never a store's own directory", async () => {
		const files = new Map([
			["/team/a.md", "A."],
			["/team/b.md", "B."],
		])
		const mount = mountOver(files)
		expect(await code(mount.rm?.("notes/team", {}))).toBe("ENOTEMPTY")
		expect(await code(mount.rm?.("notes", { recursive: true }))).toBe("EBUSY")
		expect(await code(mount.mkdir?.("notes/team/a.md", {}))).toBe("EEXIST")
		expect(await code(mount.rm?.("notes/team", { recursive: true }))).toBe("ok")
		expect([...files.keys()]).toEqual([])
		expect(await code(mount.rm?.("notes/team", {}))).toBe("ENOENT")
	})

	it("refuses every write to a read-only store, and any write outside a store", async () => {
		const files = new Map([["/rules.md", "Be kind."]])
		const mount = mountOver(files, { access: "read_only" })
		expect(
			await Promise.all([
				code(mount.writeFile?.("notes/rules.md", body("Be cruel."), {})),
				code(mount.rm?.("notes/rules.md", {})),
				code(mount.mkdir?.("notes/new", {})),
				code(mount.rename?.("notes/rules.md", "notes/moved.md", {})),
				code(mount.writeFile?.("another-store/x.md", body("x"), {})),
			]),
		).toEqual(["EROFS", "EROFS", "EROFS", "EROFS", "EROFS"])
		expect([...files]).toEqual([["/rules.md", "Be kind."]])
	})

	it("leaves a memory renamed onto itself, and refuses to move a directory into itself", async () => {
		const files = new Map([
			["/a.md", "A."],
			["/dir/x.md", "X."],
			["/dir/y.md", "Y."],
		])
		const mount = mountOver(files)
		expect(await code(mount.rename?.("notes/a.md", "notes/a.md", {}))).toBe("ok")
		expect(await code(mount.rename?.("notes/dir", "notes/dir/sub", {}))).toBe("EINVAL")
		expect(Object.fromEntries(files)).toEqual({
			"/a.md": "A.",
			"/dir/x.md": "X.",
			"/dir/y.md": "Y.",
		})
		expect(await code(mount.rename?.("notes/dir", "notes/moved", {}))).toBe("ok")
		expect(Object.fromEntries(files)).toEqual({
			"/a.md": "A.",
			"/moved/x.md": "X.",
			"/moved/y.md": "Y.",
		})
	})

	it("keeps a memory's bytes exactly, and refuses bytes that are not UTF-8", async () => {
		const files = new Map<string, string>()
		const mount = mountOver(files)
		const withMark = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])
		expect(await code(mount.writeFile?.("notes/bom.md", body(withMark), {}))).toBe("ok")
		expect(await text(mount, "notes/bom.md")).toEqual(withMark)
		const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe])
		expect(await code(mount.writeFile?.("notes/image.png", body(binary), {}))).toBe("EINVAL")
		expect(files.has("/image.png")).toBe(false)
	})

	it("lets the last write win, and moves a directory one file at a time", async () => {
		const files = new Map([["/a.md", "first"]])
		const calls: Array<string> = []
		const mount = mountOver(files, { calls })
		await text(mount, "notes/a.md")
		files.set("/a.md", "theirs")
		expect(await code(mount.writeFile?.("notes/a.md", body("mine"), {}))).toBe("ok")
		expect(files.get("/a.md")).toBe("mine")
		// An exclusive create still refuses a memory that is there.
		expect(await code(mount.writeFile?.("notes/a.md", body("again"), { exclusive: true }))).toBe(
			"EEXIST",
		)

		files.set("/dir/x.md", "X.")
		files.set("/dir/y.md", "Y.")
		calls.length = 0
		expect(await code(mount.rename?.("notes/dir", "notes/moved", {}))).toBe("ok")
		// Each file is read when it moves, not all of them first.
		expect(calls).toEqual([
			"read /dir",
			"read /dir/x.md",
			"write /moved/x.md",
			"remove /dir/x.md",
			"read /dir/y.md",
			"write /moved/y.md",
			"remove /dir/y.md",
		])
	})
})
