import { describe, expect, it } from "@effect/vitest"
import { makeMemoryMount } from "../src/Workspace/MemoryMount.ts"
import type { MemoryOutcome, SessionMemory } from "../src/Workspace/SessionMemory.ts"

// One store held in a map, served the way the API serves a session's stores.
const fakeMemory = (
	files: Map<string, string>,
	access: "read_write" | "read_only" = "read_write",
) => {
	const ok = (content: string): MemoryOutcome => ({ ok: true, content_sha256: `sha:${content}` })
	const memory: SessionMemory = {
		mounts: () => Promise.resolve([{ name: "notes", access }]),
		list: () =>
			Promise.resolve(
				[...files].map(([path, content]) => ({ path, size: content.length, updated_at: 1 })),
			),
		read: (_name, path) => {
			const content = files.get(path)
			return Promise.resolve(
				content === undefined ? null : { content, content_sha256: `sha:${content}` },
			)
		},
		write: (_name, path, content) => {
			files.set(path, content)
			return Promise.resolve(ok(content))
		},
		remove: (_name, path) => {
			const content = files.get(path) ?? ""
			files.delete(path)
			return Promise.resolve(ok(content))
		},
	}
	return memory
}

const code = (operation: Promise<unknown>) =>
	operation.then(
		() => "ok",
		(error: unknown) => (error as { readonly code?: string }).code ?? String(error),
	)

describe("memory mount", () => {
	it("shows a store as directories that exist while a memory is below them", async () => {
		const files = new Map([
			["/todo.md", "Ship."],
			["/team/plan/q3.md", "Plan."],
		])
		const mount = makeMemoryMount(() => fakeMemory(files))
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
		const mount = makeMemoryMount(() => fakeMemory(files))
		expect(await code(mount.rm?.("notes/team", {}) ?? Promise.resolve())).toBe("ENOTEMPTY")
		expect(await code(mount.rm?.("notes", { recursive: true }) ?? Promise.resolve())).toBe("EBUSY")
		expect(await code(mount.mkdir?.("notes/team/a.md", {}) ?? Promise.resolve())).toBe("EEXIST")
		expect(await code(mount.rm?.("notes/team", { recursive: true }) ?? Promise.resolve())).toBe(
			"ok",
		)
		expect([...files.keys()]).toEqual([])
		expect(await code(mount.rm?.("notes/team", {}) ?? Promise.resolve())).toBe("ENOENT")
	})

	it("refuses every write to a read-only store, and any write outside a store", async () => {
		const files = new Map([["/rules.md", "Be kind."]])
		const mount = makeMemoryMount(() => fakeMemory(files, "read_only"))
		const body = () => new Blob(["Be cruel."]).stream()
		expect(
			await Promise.all([
				code(mount.writeFile?.("notes/rules.md", body(), {}) ?? Promise.resolve()),
				code(mount.rm?.("notes/rules.md", {}) ?? Promise.resolve()),
				code(mount.mkdir?.("notes/new", {}) ?? Promise.resolve()),
				code(mount.rename?.("notes/rules.md", "notes/moved.md", {}) ?? Promise.resolve()),
				code(mount.writeFile?.("another-store/x.md", body(), {}) ?? Promise.resolve()),
			]),
		).toEqual(["EROFS", "EROFS", "EROFS", "EROFS", "EROFS"])
		expect([...files]).toEqual([["/rules.md", "Be kind."]])
	})

	it("is reachable only while a turn has the workspace", async () => {
		const mount = makeMemoryMount(() => undefined)
		expect(await code(mount.readdir("", {}))).toBe("EIO")
	})
})
