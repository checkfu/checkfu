import { describe, expect, it } from "@effect/vitest"
import { MAX_MEMORY_CONTENT_BYTES } from "@checkfu/domain/Memory/MemoryTypes"
import { makeMemoryMount } from "../src/Workspace/MemoryMount.ts"
import { withCallSignal } from "../src/Workspace/CallSignal.ts"
import { makeSessionMemory } from "../src/Workspace/SessionMemory.ts"
import type {
	MemoryMountInfo,
	MemoryOutcome,
	MemoryReceipt,
	PendingReceiptStore,
	PendingReceipts,
	SessionMemory,
} from "../src/Workspace/SessionMemory.ts"

const utf8 = new TextEncoder()

const fakeMemory = (
	files: Map<string, string>,
	access: "read_write" | "read_only" = "read_write",
	calls: Array<string> = [],
) => {
	const sha = (content: string) => `sha:${content}`
	const ok = (content: string): MemoryOutcome => ({
		ok: true,
		content_sha256: sha(content),
		receipt: null,
	})
	const changed: MemoryOutcome = { ok: false, code: "EEXIST", message: "changed" }
	const memory: SessionMemory = {
		mounts: () => Promise.resolve([{ name: "notes", access }]),
		list: () =>
			Promise.resolve(
				[...files].map(([path, content]) => ({
					path,
					size: utf8.encode(content).byteLength,
					updated_at: 1,
				})),
			),
		stat: (_name, path) => {
			const content = files.get(path)
			return Promise.resolve(
				content === undefined ? null : { size: utf8.encode(content).byteLength, updated_at: 1 },
			)
		},
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
	it("bounds a whole recursive memory walk and builds only direct children for a shallow listing", async () => {
		const memory = fakeMemory(
			new Map([
				["/team/plan/q3", "x"],
				["/team/plan/q4", "y"],
			]),
		)
		const seen: Array<string> = []
		const mount = makeMemoryMount({
			...memory,
			mounts: async () => ["a", "b", "c"].map((name) => ({ name, access: "read_write" })),
			list: async (name) => {
				seen.push(name)
				return memory.list(name)
			},
		})
		expect(await mount.readdir("a", { limit: 1 })).toMatchObject([{ name: "team" }])
		seen.length = 0
		await expect(mount.readdir("", { recursive: true, limit: 8 })).rejects.toThrow(
			"More than 8 entries",
		)
		expect(seen).toEqual(["a", "b"])
		expect(await mount.readdir("a", { recursive: true, limit: 4 })).toHaveLength(4)
	})

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

	it("stats UTF-8 bytes without reading memory content", async () => {
		const calls: Array<string> = []
		const mount = mountOver(new Map([["/note.md", "雪🌱"]]), { calls })
		expect(await mount.stat("notes/note.md")).toMatchObject({ type: "file", size: 7, mtime: 1 })
		expect(calls).toEqual([])
	})

	it("stats an overwritten file by its committed metadata while the listing is behind", async () => {
		const receipt = { stream: "note", version: 1 }
		const inner = fakeMemory(new Map())
		let updated = false
		const mount = makeMemoryMount(
			makeSessionMemory(
				{
					...inner,
					read: async () => {
						throw new Error("stat must not read the content")
					},
					stat: async () => (updated ? { size: 7, updated_at: 42 } : { size: 3, updated_at: 1 }),
					list: async () => {
						throw new Error("the listing is behind")
					},
					write: async () => {
						updated = true
						return { ok: true, content_sha256: "digest", receipt }
					},
				},
				heldIn(),
			),
		)
		expect(await mount.stat("notes/note.md")).toMatchObject({ type: "file", size: 3, mtime: 1 })
		await mount.writeFile?.("notes/note.md", body("雪🌱"), {})
		expect(await mount.stat("notes/note.md")).toMatchObject({ type: "file", size: 7, mtime: 42 })
	})

	it("checks fresh access for mount operations that do not issue a write", async () => {
		let access: MemoryMountInfo["access"] = "read_write"
		const inner = fakeMemory(new Map([["/note.md", "note"]]))
		const mount = makeMemoryMount(
			makeSessionMemory(
				{ ...inner, mounts: async () => [{ name: "notes", access }] },
				heldIn(),
				() => 0,
			),
		)
		expect(await mount.stat("notes")).toMatchObject({ mode: 0o755 })
		access = "read_only"
		expect(await code(mount.mkdir?.("notes/new", {}))).toBe("EROFS")
		expect(await code(mount.rename?.("notes/note.md", "notes/note.md", {}))).toBe("EROFS")
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

	it("stops a recursive delete or a directory move at the next memory once the call running it is stopped", async () => {
		const files = new Map([
			["/team/a.md", "A."],
			["/team/b.md", "B."],
			["/team/c.md", "C."],
		])
		const stopping = new AbortController()
		const removed: Array<string> = []
		const inner = fakeMemory(files)
		const mount = makeMemoryMount(
			makeSessionMemory(
				{
					...inner,
					list: (name) => inner.list(name),
					remove: async (name, path, expected) => {
						removed.push(path)
						stopping.abort()
						return inner.remove(name, path, expected)
					},
				},
				heldIn(),
			),
		)
		expect(
			await code(
				withCallSignal(stopping.signal, async () => mount.rm?.("notes/team", { recursive: true })),
			),
		).not.toBe("ok")
		expect([removed.length, files.size]).toEqual([1, 2])

		const moving = new AbortController()
		moving.abort()
		const writes: Array<string> = []
		const watched = makeMemoryMount(
			makeSessionMemory(
				{
					...inner,
					list: (name) => inner.list(name),
					write: (name, path, content, exclusive) => {
						writes.push(path)
						return inner.write(name, path, content, exclusive)
					},
				},
				heldIn(),
			),
		)
		expect(
			await code(
				withCallSignal(moving.signal, async () =>
					watched.rename?.("notes/team", "notes/moved", {}),
				),
			),
		).not.toBe("ok")
		expect([writes, files.size]).toEqual([[], 2])
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

	it("makes a same-path rename a no-op only when the source exists", async () => {
		const files = new Map([
			["/note.md", "Note"],
			["/directory/note.md", "Nested"],
		])
		const calls: Array<string> = []
		const mount = mountOver(files, { calls })
		for (const path of ["notes/note.md", "notes/directory"]) {
			expect(await code(mount.rename?.(path, path, {}))).toBe("ok")
		}
		for (const path of ["notes/missing.md", "notes/dir"]) {
			expect(await code(mount.rename?.(path, path, {}))).toBe("ENOENT")
		}
		expect([...files]).toEqual([
			["/note.md", "Note"],
			["/directory/note.md", "Nested"],
		])
		expect(calls).toEqual([])
	})

	it("refuses to move a directory into itself", async () => {
		const files = new Map([
			["/a.md", "A."],
			["/dir/x.md", "X."],
			["/dir/y.md", "Y."],
		])
		const mount = mountOver(files)
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

	it("accepts an empty write and a split UTF-8 character at the byte limit", async () => {
		const files = new Map<string, string>()
		const mount = mountOver(files)
		const content = "a".repeat(MAX_MEMORY_CONTENT_BYTES - 4) + "📝"
		const bytes = utf8.encode(content)
		const split = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.subarray(0, -2))
				controller.enqueue(bytes.subarray(-2))
				controller.close()
			},
		})

		expect(await code(mount.writeFile?.("notes/empty.md", body(""), {}))).toBe("ok")
		expect(await code(mount.writeFile?.("notes/full.md", split, {}))).toBe("ok")
		expect(files.get("/empty.md")).toBe("")
		expect(files.get("/full.md")).toBe(content)
	})

	it.each([false, true])(
		"cancels an oversized write before the sentinel (split: %s)",
		async (split) => {
			const calls: Array<string> = []
			const mount = mountOver(new Map(), { calls })
			const chunks = split
				? [utf8.encode("ab"), new Uint8Array(MAX_MEMORY_CONTENT_BYTES)]
				: [new Uint8Array(MAX_MEMORY_CONTENT_BYTES + 1)]
			let cancelled = false
			let pulledSentinel = false
			const source = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						const chunk = chunks.shift()
						if (chunk === undefined) {
							pulledSentinel = true
							controller.enqueue(utf8.encode("sentinel"))
							controller.close()
							return
						}
						controller.enqueue(chunk)
					},
					cancel() {
						cancelled = true
					},
				},
				{ highWaterMark: 0 },
			)

			expect(await code(mount.writeFile?.("notes/too-large.md", source, {}))).toBe("EINVAL")
			expect(cancelled).toBe(true)
			expect(pulledSentinel).toBe(false)
			expect(source.locked).toBe(false)
			expect(calls).toEqual([])
		},
	)

	it("releases the reader and preserves source failures", async () => {
		const calls: Array<string> = []
		const mount = mountOver(new Map(), { calls })
		const broke = new Error("source failed")
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(broke)
			},
		})

		await expect(mount.writeFile?.("notes/broken.md", source, {})).rejects.toBe(broke)
		expect(source.locked).toBe(false)
		expect(calls).toEqual([])
	})

	it("lets the last write win, and moves a directory one file at a time", async () => {
		const files = new Map([["/a.md", "first"]])
		const calls: Array<string> = []
		const mount = mountOver(files, { calls })
		await text(mount, "notes/a.md")
		files.set("/a.md", "theirs")
		expect(await code(mount.writeFile?.("notes/a.md", body("mine"), {}))).toBe("ok")
		expect(files.get("/a.md")).toBe("mine")
		expect(await code(mount.writeFile?.("notes/a.md", body("again"), { exclusive: true }))).toBe(
			"EEXIST",
		)

		files.set("/dir/x.md", "X.")
		files.set("/dir/y.md", "Y.")
		calls.length = 0
		expect(await code(mount.rename?.("notes/dir", "notes/moved", {}))).toBe("ok")
		expect(calls).toEqual([
			"read /dir",
			"read /moved",
			"read /dir/x.md",
			"write /moved/x.md",
			"remove /dir/x.md",
			"read /dir/y.md",
			"write /moved/y.md",
			"remove /dir/y.md",
		])
	})

	it("does not remove the source when the destination write reports a full store", async () => {
		const bytes = "Keep these bytes."
		const files = new Map([["/before.md", bytes]])
		const calls: Array<string> = []
		const mount = makeMemoryMount({
			...fakeMemory(files, "read_write", calls),
			write: async (name, path, value, exclusive) => {
				expect([name, path, value, exclusive]).toEqual(["notes", "/after.md", bytes, false])
				calls.push(`refuse ${path}`)
				return { ok: false, code: "ENOSPC", message: "Full store." }
			},
		})
		expect(await code(mount.rename?.("notes/before.md", "notes/after.md", {}))).toBe("ENOSPC")
		expect(calls.filter((call) => !call.startsWith("read"))).toEqual(["refuse /after.md"])
		expect(await text(mount, "notes/before.md")).toEqual(utf8.encode(bytes))
		expect(await text(mount, "notes/after.md")).toBeNull()
	})

	it("refuses to move onto a directory that holds memories, or a directory onto a memory", async () => {
		const files = new Map([
			["/draft/notes.md", "Draft."],
			["/published/notes.md", "Published."],
			["/one.md", "One."],
		])
		const calls: Array<string> = []
		const mount = mountOver(files, { calls })
		calls.length = 0
		expect(await code(mount.rename?.("notes/draft", "notes/published", {}))).toBe("ENOTEMPTY")
		expect(await code(mount.rename?.("notes/draft/notes.md", "notes/published", {}))).toBe("EISDIR")
		expect(await code(mount.rename?.("notes/draft", "notes/one.md", {}))).toBe("ENOTDIR")
		files.set("/a/b/c.md", "C.")
		expect(await code(mount.rename?.("notes/a/b", "notes/a", {}))).toBe("ENOTEMPTY")
		expect(calls.filter((call) => !call.startsWith("read"))).toEqual([])
		expect(files.get("/published/notes.md")).toBe("Published.")
	})
})

describe("session memory", () => {
	it("shares the mounted stores across file stats until the cached list expires", async () => {
		let now = 0
		let reads = 0
		const inner = fakeMemory(new Map())
		const mount = makeMemoryMount(
			makeSessionMemory(
				{
					...inner,
					mounts: () => {
						reads += 1
						return inner.mounts()
					},
				},
				heldIn(),
				() => now,
			),
		)
		for (let index = 0; index < 20; index += 1) {
			await mount.stat(`notes/file-${index}.md`)
		}
		expect(reads).toBe(1)
		now += 11_000
		await mount.stat("notes/after.md")
		expect(reads).toBe(2)
	})

	it("shares one pending mount lookup across callers and retries a failed lookup", async () => {
		const pending = Promise.withResolvers<ReadonlyArray<MemoryMountInfo>>()
		const inner = fakeMemory(new Map())
		let reads = 0
		const memory = makeSessionMemory(
			{
				...inner,
				mounts: () => {
					reads += 1
					return reads === 1 ? pending.promise : inner.mounts()
				},
			},
			heldIn(),
		)
		const results = Promise.allSettled([memory.mounts(), memory.mounts()])
		await Promise.resolve()
		expect(reads).toBe(1)
		pending.reject(new Error("try again"))
		expect((await results).map((answer) => answer.status)).toEqual(["rejected", "rejected"])
		expect(await memory.mounts()).toEqual([{ name: "notes", access: "read_write" }])
		expect(reads).toBe(2)
	})

	it("preserves missing results and transport errors while reporting projection lag to file tools", async () => {
		const failure = new Error("transport disconnected")
		let busy = true
		const memory = makeSessionMemory(
			{
				...fakeMemory(new Map()),
				read: (_, path) =>
					path === "/offline" ? Promise.reject(failure) : Promise.resolve(busy ? "busy" : null),
				stat: () => Promise.resolve(busy ? "busy" : null),
			},
			heldIn(),
		)
		const expected = { code: "EIO", message: "The memory store is busy. Try again." }
		await expect(memory.read("notes", "/m")).rejects.toMatchObject(expected)
		await expect(memory.stat("notes", "/m")).rejects.toMatchObject(expected)
		await expect(memory.read("notes", "/offline")).rejects.toBe(failure)
		busy = false
		expect(await memory.read("notes", "/m")).toBeNull()
		expect(await memory.stat("notes", "/m")).toBeNull()
	})

	it("asks each listing for the writes it was acknowledged for, until a listing has shown them", async () => {
		const asked: Array<ReadonlyArray<MemoryReceipt>> = []
		let lagging = false
		let version = 0
		const memory = makeSessionMemory(
			{
				mounts: () => Promise.resolve([]),
				read: () => Promise.resolve(null),
				stat: () => Promise.resolve(null),
				remove: () => Promise.resolve({ ok: true, content_sha256: "", receipt: null }),
				list: (_, after) => {
					asked.push(after)
					return Promise.resolve(lagging ? ("busy" as const) : [])
				},
				write: (_, path) => {
					version += 1
					return Promise.resolve({
						ok: true,
						content_sha256: "",
						receipt: { stream: `Memory${path}`, version },
					})
				},
			},
			heldIn(),
		)
		await memory.list("notes")
		await memory.write("notes", "/a.md", "one", false)
		await memory.write("notes", "/a.md", "two", false)
		await memory.write("notes", "/b.md", "one", false)
		await memory.write("other", "/c.md", "one", false)
		lagging = true
		await expect(memory.list("notes")).rejects.toMatchObject({
			code: "EIO",
			message: "The memory store is busy. Try again.",
		})
		lagging = false
		await memory.list("notes")
		await memory.remove("notes", "/b.md", null)
		await memory.list("notes")
		await memory.list("other")
		const latest = [
			{ stream: "Memory/a.md", version: 2 },
			{ stream: "Memory/b.md", version: 3 },
		]
		expect(asked).toEqual([[], latest, latest, [], [{ stream: "Memory/c.md", version: 4 }]])
	})

	it("keeps the newest unconfirmed write of each memory when the workspace is evicted, and when writes finish out of order", async () => {
		const asked: Array<ReadonlyArray<MemoryReceipt>> = []
		const finishing: Array<number> = []
		const calls = {
			mounts: () => Promise.resolve([]),
			read: () => Promise.resolve(null),
			stat: () => Promise.resolve(null),
			remove: () => Promise.resolve({ ok: true as const, content_sha256: "", receipt: null }),
			list: (_: string, after: ReadonlyArray<MemoryReceipt>) => {
				asked.push(after)
				return Promise.resolve([])
			},
			write: () =>
				Promise.resolve({
					ok: true as const,
					content_sha256: "",
					receipt: { stream: "Memory/a.md", version: finishing.shift() ?? 0 },
				}),
		}
		const held = heldIn()
		finishing.push(3, 2)
		const before = makeSessionMemory(calls, held)
		await before.write("notes", "/a.md", "three", false)
		await before.write("notes", "/a.md", "two", false)
		const after = makeSessionMemory(calls, held)
		await after.list("notes")
		await after.list("notes")
		expect(asked).toEqual([[{ stream: "Memory/a.md", version: 3 }], []])
		await after.list("constructor")
		await after.list("constructor")
		expect(asked.slice(2)).toEqual([[], []])
	})
})

const heldIn = (): PendingReceiptStore => {
	let held: PendingReceipts | undefined
	return {
		get: () => held,
		put: (pending) => {
			held = pending
		},
	}
}
