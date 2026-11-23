import { createHash } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { isMissingFile, makeMemorySync, sha256Hex } from "../src/Workspace/MemorySync.ts"

const MOUNT = "/mnt/memory/notes"

const workspace = () => {
	const files = new Map<string, string>()
	let base: Readonly<Record<string, string>> = {}
	const sync = makeMemorySync(
		{
			read: (file) => Promise.resolve(files.get(file) ?? null),
			// As a filesystem would: the file takes the place of a directory at its path and
			// of a file standing where one of its directories goes.
			write: (file, content) => {
				for (const other of files.keys()) {
					if (other.startsWith(`${file}/`) || file.startsWith(`${other}/`)) {
						files.delete(other)
					}
				}
				files.set(file, content)
				return Promise.resolve()
			},
			remove: (file) => Promise.resolve(void files.delete(file)),
			list: (directory) =>
				Promise.resolve([...files.keys()].filter((file) => file.startsWith(`${directory}/`))),
		},
		{ get: () => base, put: (_mount, next) => void (base = next) },
	)
	// Copies the store in the way a turn does: what the workspace asks for is filled.
	const copyIn = async (store: Readonly<Record<string, string>>) => {
		const manifest = await Promise.all(
			Object.entries(store).map(async ([path, content]) => ({
				path,
				content_sha256: await sha256Hex(content),
			})),
		)
		const needed = await sync.mount({ mount_path: MOUNT, access: "read_write", manifest })
		await sync.fill(
			MOUNT,
			manifest
				.filter(({ path }) => needed.includes(path))
				.map((entry) => ({ ...entry, content: store[entry.path] ?? "" })),
		)
		return needed
	}
	return { files, sync, copyIn }
}

describe("memory sync", () => {
	it("hashes text as SHA-256 over its UTF-8 bytes", async () => {
		expect(await sha256Hex("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		)
		expect(await sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		)
		for (const text of ["Tabs, not spaces. ✓", "é".repeat(1000)]) {
			expect(await sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"))
		}
	})

	it("asks for a store's memories once, and for nothing while both sides are unchanged", async () => {
		const { files, sync, copyIn } = workspace()
		const store = { "/style.md": "Tabs.", "/team/todo.md": "Ship." }
		expect(await copyIn(store)).toEqual(["/style.md", "/team/todo.md"])
		expect(Object.fromEntries(files)).toEqual({
			[`${MOUNT}/style.md`]: "Tabs.",
			[`${MOUNT}/team/todo.md`]: "Ship.",
		})
		expect(await copyIn(store)).toEqual([])
		expect(await sync.changes(MOUNT)).toEqual({ written: [], deleted: [] })
	})

	it("reports what the session wrote, changed and deleted, each with what it replaced", async () => {
		const { files, sync, copyIn } = workspace()
		await copyIn({ "/style.md": "Tabs.", "/old.md": "Remove me.", "/same.md": "Untouched." })
		files.set(`${MOUNT}/style.md`, "Spaces.")
		files.set(`${MOUNT}/new/idea.md`, "Ship it.")
		files.delete(`${MOUNT}/old.md`)
		files.set("/workspace/elsewhere.md", "Not memory.")

		expect(await sync.changes(MOUNT)).toEqual({
			written: [
				{
					path: "/style.md",
					content_sha256: await sha256Hex("Spaces."),
					size_bytes: 7,
					base: await sha256Hex("Tabs."),
				},
				{
					path: "/new/idea.md",
					content_sha256: await sha256Hex("Ship it."),
					size_bytes: 8,
					base: null,
				},
			],
			deleted: [{ path: "/old.md", base: await sha256Hex("Remove me.") }],
		})
		// The content crosses separately, for the paths asked for; one that is gone is left out.
		files.set(`${MOUNT}/wide.md`, "é")
		expect((await sync.changes(MOUNT)).written.at(-1)).toMatchObject({
			path: "/wide.md",
			size_bytes: 2,
		})
		expect(await sync.contents(MOUNT, ["/new/idea.md", "/old.md", "/style.md"])).toEqual([
			{ path: "/new/idea.md", content: "Ship it.", content_sha256: await sha256Hex("Ship it.") },
			{ path: "/style.md", content: "Spaces.", content_sha256: await sha256Hex("Spaces.") },
		])
	})

	it("takes what the store saved as the new base, so a memory deleted elsewhere stays deleted", async () => {
		const { files, sync, copyIn } = workspace()
		await copyIn({ "/old.md": "Remove me." })
		files.set(`${MOUNT}/idea.md`, "Ship it.")
		files.delete(`${MOUNT}/old.md`)
		const { written, deleted } = await sync.changes(MOUNT)
		// The store took the write and the delete.
		sync.saved(MOUNT, {
			written: written.map(({ path, content_sha256 }) => ({ path, content_sha256 })),
			deleted: deleted.map(({ path }) => path),
		})
		expect(await sync.changes(MOUNT)).toEqual({ written: [], deleted: [] })

		// Another writer deletes the new memory before the next turn.
		expect(await copyIn({})).toEqual([])
		expect(Object.fromEntries(files)).toEqual({})
		expect(await sync.changes(MOUNT)).toEqual({ written: [], deleted: [] })
	})

	it("keeps a change the store refused pending, and lets the store's version replace it", async () => {
		const { files, sync, copyIn } = workspace()
		await copyIn({ "/style.md": "Tabs." })
		files.set(`${MOUNT}/style.md`, "Session edit.")
		files.set(`${MOUNT}/idea.md`, "Kept.")
		// Only the new file was taken.
		sync.saved(MOUNT, {
			written: [{ path: "/idea.md", content_sha256: await sha256Hex("Kept.") }],
			deleted: [],
		})
		expect((await sync.changes(MOUNT)).written.map(({ path }) => path)).toEqual(["/style.md"])
		expect(await copyIn({ "/style.md": "Other writer.", "/idea.md": "Kept." })).toEqual([
			"/style.md",
		])
		expect(files.get(`${MOUNT}/style.md`)).toBe("Other writer.")
	})

	it("follows a path that turns from a directory into a file, and back", async () => {
		const { files, sync, copyIn } = workspace()
		await copyIn({ "/notes/todo.md": "Ship.", "/notes/deep/plan.md": "Plan." })
		expect(await copyIn({ "/notes": "One file now." })).toEqual(["/notes"])
		expect(Object.fromEntries(files)).toEqual({ [`${MOUNT}/notes`]: "One file now." })
		expect(await sync.changes(MOUNT)).toEqual({ written: [], deleted: [] })

		expect(await copyIn({ "/notes/todo.md": "A directory again." })).toEqual(["/notes/todo.md"])
		expect(Object.fromEntries(files)).toEqual({ [`${MOUNT}/notes/todo.md`]: "A directory again." })
		expect(await sync.changes(MOUNT)).toEqual({ written: [], deleted: [] })
	})

	it("mounts the memories below when a store holds a path both as a memory and as their directory", async () => {
		const { files, sync, copyIn } = workspace()
		const store = {
			"/notes": "Cannot be a file here.",
			"/notes/todo.md": "Ship.",
			"/other.md": "Fine.",
		}
		expect(await copyIn(store)).toEqual(["/notes/todo.md", "/other.md"])
		expect(Object.fromEntries(files)).toEqual({
			[`${MOUNT}/notes/todo.md`]: "Ship.",
			[`${MOUNT}/other.md`]: "Fine.",
		})
		// The memory left out is neither changed nor deleted by this session.
		expect(await sync.changes(MOUNT)).toEqual({ written: [], deleted: [] })
		expect(await copyIn(store)).toEqual([])
	})

	it("keeps a session's unsaved change while the store has not moved, and reports it again", async () => {
		const { files, sync, copyIn } = workspace()
		const store = { "/style.md": "Tabs." }
		await copyIn(store)
		files.set(`${MOUNT}/style.md`, "Spaces.")
		expect(await copyIn(store)).toEqual([])
		expect(files.get(`${MOUNT}/style.md`)).toBe("Spaces.")
		expect((await sync.changes(MOUNT)).written.map(({ path, base }) => [path, base])).toEqual([
			["/style.md", await sha256Hex("Tabs.")],
		])
	})

	it("lets the store win wherever it moved on, over a session's own change", async () => {
		const { files, sync, copyIn } = workspace()
		await copyIn({ "/style.md": "Tabs.", "/gone.md": "Deleted elsewhere." })
		files.set(`${MOUNT}/style.md`, "Session edit.")
		files.set(`${MOUNT}/gone.md`, "Session edit.")

		expect(await copyIn({ "/style.md": "Other writer." })).toEqual(["/style.md"])
		expect(Object.fromEntries(files)).toEqual({ [`${MOUNT}/style.md`]: "Other writer." })
		expect(await sync.changes(MOUNT)).toEqual({ written: [], deleted: [] })
	})

	it("needs nothing when the store took the session's own write", async () => {
		const { files, sync, copyIn } = workspace()
		await copyIn({ "/style.md": "Tabs." })
		files.set(`${MOUNT}/style.md`, "Spaces.")
		files.set(`${MOUNT}/new.md`, "New.")
		// The store now holds what the session wrote back.
		expect(await copyIn({ "/style.md": "Spaces.", "/new.md": "New." })).toEqual([])
		expect(await sync.changes(MOUNT)).toEqual({ written: [], deleted: [] })
	})

	it("does not treat a file as copied until it is filled", async () => {
		const { files, sync } = workspace()
		const manifest = [{ path: "/style.md", content_sha256: await sha256Hex("Tabs.") }]
		expect(await sync.mount({ mount_path: MOUNT, access: "read_write", manifest })).toEqual([
			"/style.md",
		])
		// The fill never arrived. A stale local file must not be saved over the store's.
		files.set(`${MOUNT}/style.md`, "Stale.")
		expect((await sync.changes(MOUNT)).written.map(({ path, base }) => [path, base])).toEqual([
			["/style.md", null],
		])
		expect(await sync.mount({ mount_path: MOUNT, access: "read_write", manifest })).toEqual([
			"/style.md",
		])
	})

	it("fails when the workspace cannot be listed or read, and never reports that as a deletion", async () => {
		const base = { "/style.md": await sha256Hex("Tabs.") }
		const failing = (broken: "list" | "read") =>
			makeMemorySync(
				{
					read: () =>
						broken === "read"
							? Promise.reject(new Error("storage offline"))
							: Promise.resolve("Tabs."),
					write: () => Promise.resolve(),
					remove: () => Promise.resolve(),
					list: () =>
						broken === "list"
							? Promise.reject(new Error("storage offline"))
							: Promise.resolve([`${MOUNT}/style.md`]),
				},
				{ get: () => base, put: () => undefined },
			)
		await expect(failing("list").changes(MOUNT)).rejects.toThrow("storage offline")
		await expect(failing("read").changes(MOUNT)).rejects.toThrow("storage offline")
	})

	it("reads only a missing file as no file", () => {
		expect(isMissingFile(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe(true)
		expect(isMissingFile(Object.assign(new Error("not a directory"), { code: "ENOTDIR" }))).toBe(
			true,
		)
		expect(isMissingFile(Object.assign(new Error("busy"), { code: "EBUSY" }))).toBe(false)
		expect(isMissingFile(new Error("storage offline"))).toBe(false)
		expect(isMissingFile(null)).toBe(false)
	})
})
