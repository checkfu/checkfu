import type { PassthroughDirent, PassthroughMount, PassthroughStat } from "@cloudflare/computer"
import type {
	MemoryFileInfo,
	MemoryMountInfo,
	MemoryOutcome,
	SessionMemory,
} from "./SessionMemory.ts"

// /mnt/memory as the workspace's filesystem sees it: one directory per attached store, served live
// from the store. Every write is a store write, so nothing is copied in or saved out, and as in any
// shared filesystem the last write to a memory wins. Directories are implicit, as in the store: one
// exists while a memory is below it.

type FsCode =
	| "EROFS"
	| "ENOENT"
	| "EEXIST"
	| "ENOSPC"
	| "EINVAL"
	| "EISDIR"
	| "EIO"
	| "ENOTDIR"
	| "ENOTEMPTY"
	| "EBUSY"

const failure = (code: FsCode, message: string): Error =>
	Object.assign(new Error(message), { code })

const refuse = (outcome: MemoryOutcome): string => {
	if (!outcome.ok) {
		throw failure(outcome.code, outcome.message)
	}
	return outcome.content_sha256
}

const encoder = new TextEncoder()
// A memory is UTF-8 text, kept byte for byte: a byte order mark stays, and bytes that are not UTF-8
// are refused rather than replaced.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

const decode = (bytes: ArrayBuffer, rel: string): string => {
	try {
		return strictUtf8.decode(bytes)
	} catch {
		throw failure("EINVAL", `A memory holds UTF-8 text; ${rel} is not.`)
	}
}

interface Located {
	readonly mount: MemoryMountInfo
	/** The path in the store, or "" for the store's own directory. */
	readonly path: string
}

const dirStat = (mount: MemoryMountInfo | undefined): PassthroughStat => ({
	type: "dir",
	size: 0,
	mtime: 0,
	mode: mount?.access === "read_only" ? 0o555 : 0o755,
})

const fileStat = (mount: MemoryMountInfo, size: number, mtime: number): PassthroughStat => ({
	type: "file",
	size,
	mtime,
	mode: mount.access === "read_only" ? 0o444 : 0o644,
})

const below = (files: ReadonlyArray<MemoryFileInfo>, dir: string) =>
	files.filter((file) => file.path.startsWith(`${dir}/`))

const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)

// Every file and directory below `dir`, named relative to it and after `prefix`, parents first.
const nested = (
	mount: MemoryMountInfo,
	files: ReadonlyArray<MemoryFileInfo>,
	dir: string,
	prefix: string,
): Array<PassthroughDirent> => {
	const entries = new Map<string, PassthroughDirent>()
	for (const file of below(files, dir)) {
		const parts = file.path.slice(dir.length + 1).split("/")
		for (let depth = 1; depth < parts.length; depth += 1) {
			const name = `${prefix}${parts.slice(0, depth).join("/")}`
			entries.set(name, { name, ...dirStat(mount) })
		}
		const name = `${prefix}${parts.join("/")}`
		entries.set(name, { name, ...fileStat(mount, file.size, file.updated_at) })
	}
	return [...entries.values()].sort((a, b) => a.name.split("/").length - b.name.split("/").length)
}

export const makeMemoryMount = (memory: SessionMemory): PassthroughMount => {
	const locate = async (rel: string): Promise<Located | undefined> => {
		const [name, ...rest] = rel.split("/")
		const mount = (await memory.mounts()).find((mounted) => mounted.name === name)
		return mount === undefined
			? undefined
			: { mount, path: rest.length === 0 ? "" : `/${rest.join("/")}` }
	}
	const writable = async (rel: string): Promise<Located> => {
		const at = await locate(rel)
		if (at === undefined) {
			throw failure("EROFS", "Only an attached memory store can be written to.")
		}
		if (at.mount.access === "read_only") {
			throw failure("EROFS", `The memory store ${at.mount.name} is read-only.`)
		}
		return at
	}
	const read = (at: Located) => memory.read(at.mount.name, at.path)
	const write = async (at: Located, content: string, exclusive: boolean) => {
		refuse(await memory.write(at.mount.name, at.path, content, exclusive))
	}
	const remove = async (at: Located, expected: string | null) => {
		refuse(await memory.remove(at.mount.name, at.path, expected))
	}

	return {
		kind: "checkfu-memory",
		strategy: "passthrough",
		mode: "read-write",
		stat: async (rel) => {
			if (rel === "") {
				return dirStat(undefined)
			}
			const at = await locate(rel)
			if (at === undefined) {
				return null
			}
			if (at.path === "") {
				return dirStat(at.mount)
			}
			// A file is asked of the store itself, so one just written by anyone is found.
			const file = await read(at)
			if (file !== null) {
				return fileStat(at.mount, encoder.encode(file.content).byteLength, file.updated_at)
			}
			return below(await memory.list(at.mount.name), at.path).length > 0 ? dirStat(at.mount) : null
		},
		readdir: async (rel, options) => {
			if (rel === "") {
				const all = await memory.mounts()
				const entries: Array<PassthroughDirent> = all.map((mount) => ({
					name: mount.name,
					...dirStat(mount),
				}))
				if (options?.recursive === true) {
					for (const mount of all) {
						entries.push(...nested(mount, await memory.list(mount.name), "", `${mount.name}/`))
					}
				}
				return entries
			}
			const at = await locate(rel)
			if (at === undefined) {
				return null
			}
			const listing = await memory.list(at.mount.name)
			if (listing.some((file) => file.path === at.path)) {
				throw failure("ENOTDIR", `Not a directory: ${rel}`)
			}
			const entries = nested(at.mount, listing, at.path, "")
			if (at.path !== "" && entries.length === 0) {
				return null
			}
			return options?.recursive === true
				? entries
				: entries.filter((entry) => !entry.name.includes("/"))
		},
		readFile: async (rel, options) => {
			const at = await locate(rel)
			if (at === undefined) {
				return null
			}
			if (at.path === "") {
				throw failure("EISDIR", `Is a directory: ${rel}`)
			}
			const found = await read(at)
			if (found === null) {
				return null
			}
			const bytes = encoder.encode(found.content)
			const offset = Math.min(options?.range?.offset ?? 0, bytes.byteLength)
			const length = options?.range?.length
			const end = length === undefined ? bytes.byteLength : offset + length
			return {
				stat: fileStat(at.mount, bytes.byteLength, found.updated_at),
				body: new Blob([bytes.slice(offset, end)]).stream(),
				offset,
			}
		},
		writeFile: async (rel, body, options) => {
			const at = await writable(rel)
			if (at.path === "") {
				throw failure("EISDIR", `Is a directory: ${rel}`)
			}
			const bytes = await new Response(body).arrayBuffer()
			await write(at, decode(bytes, rel), options.exclusive === true)
			return fileStat(at.mount, bytes.byteLength, Date.now())
		},
		mkdir: async (rel) => {
			const at = await writable(rel)
			if (at.path !== "" && (await read(at)) !== null) {
				throw failure("EEXIST", `A memory is there: ${rel}`)
			}
		},
		rm: async (rel, options) => {
			const at = await writable(rel)
			if (at.path === "") {
				throw failure("EBUSY", `An attached memory store cannot be removed: ${rel}`)
			}
			if ((await read(at)) !== null) {
				await remove(at, null)
				return
			}
			const files = below(await memory.list(at.mount.name), at.path)
			if (files.length === 0) {
				throw failure("ENOENT", `No such file or directory: ${rel}`)
			}
			if (options.recursive !== true) {
				throw failure("ENOTEMPTY", `Directory not empty: ${rel}`)
			}
			for (const file of files) {
				await remove({ mount: at.mount, path: file.path }, null)
			}
		},
		rename: async (from, to) => {
			const source = await writable(from)
			const target = await writable(to)
			if (source.path === "" || target.path === "") {
				throw failure("EBUSY", `An attached memory store cannot be renamed: ${from}`)
			}
			if (source.mount.name === target.mount.name && source.path === target.path) {
				return
			}
			const file = await read(source)
			// Planned from paths alone: each file is read only when its turn to move comes.
			const moves =
				file !== null
					? [{ from: source, to: target }]
					: below(await memory.list(source.mount.name), source.path).map((entry) => ({
							from: { mount: source.mount, path: entry.path },
							to: {
								mount: target.mount,
								path: `${target.path}${entry.path.slice(source.path.length)}`,
							},
						}))
			if (moves.length === 0) {
				throw failure("ENOENT", `No such file or directory: ${from}`)
			}
			if (
				file === null &&
				source.mount.name === target.mount.name &&
				inside(target.path, source.path)
			) {
				throw failure("EINVAL", `A directory cannot be moved into itself: ${from} to ${to}`)
			}
			// Each file is written at its new path before it leaves its old one, and leaves it only if it
			// did not change while it moved, so a refused step leaves it where it was.
			for (const move of moves) {
				const found = await read(move.from)
				if (found === null) {
					throw failure("ENOENT", `No such file: ${move.from.path}`)
				}
				await write(move.to, found.content, false)
				await remove(move.from, found.content_sha256)
			}
		},
	}
}
