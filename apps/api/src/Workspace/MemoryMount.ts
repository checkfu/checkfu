import type { PassthroughDirent, PassthroughMount, PassthroughStat } from "@cloudflare/computer"
import type {
	MemoryFileInfo,
	MemoryMountInfo,
	MemoryOutcome,
	SessionMemory,
} from "./SessionMemory.ts"

// /mnt/memory as the workspace's filesystem sees it: one directory per mounted store, served live
// from the store. Every write is a store write, so nothing is copied in or saved out. Directories
// are implicit, as in the store: one exists while a memory is below it.

type FsCode = "EROFS" | "ENOENT" | "EEXIST" | "ENOSPC" | "EINVAL" | "EISDIR" | "EIO" | "ENOTDIR"
type FsCodeOrBusy = FsCode | "ENOTEMPTY" | "EBUSY"

const failure = (code: FsCodeOrBusy, message: string): Error =>
	Object.assign(new Error(message), { code })

const refuse = (outcome: MemoryOutcome): string => {
	if (!outcome.ok) {
		throw failure(outcome.code, outcome.message)
	}
	return outcome.content_sha256
}

const encoder = new TextEncoder()

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

const key = (name: string, path: string) => `${name}:${path}`

export const makeMemoryMount = (current: () => SessionMemory | undefined): PassthroughMount => {
	let session: SessionMemory | undefined
	let mounts: Promise<ReadonlyArray<MemoryMountInfo>> | undefined
	const listings = new Map<string, Promise<ReadonlyArray<MemoryFileInfo>>>()
	// The content each path had when this workspace last read or wrote it: what a write replaces.
	const seen = new Map<string, string>()

	// A turn's listings are asked for once and dropped by its own writes; a new turn asks again.
	const memory = (): SessionMemory => {
		const now = current()
		if (now === undefined) {
			throw failure("EIO", "Memory stores are reachable only while a turn runs.")
		}
		if (now !== session) {
			session = now
			mounts = undefined
			listings.clear()
		}
		return now
	}
	const allMounts = () => {
		const store = memory()
		mounts ??= store.mounts()
		return mounts
	}
	const files = (name: string) => {
		const store = memory()
		let listing = listings.get(name)
		if (listing === undefined) {
			listing = store.list(name)
			listings.set(name, listing)
		}
		return listing
	}
	const locate = async (rel: string): Promise<Located | undefined> => {
		const [name, ...rest] = rel.split("/")
		const mount = (await allMounts()).find((mounted) => mounted.name === name)
		return mount === undefined
			? undefined
			: { mount, path: rest.length === 0 ? "" : `/${rest.join("/")}` }
	}
	const writable = async (rel: string): Promise<Located> => {
		const at = await locate(rel)
		if (at === undefined) {
			throw failure("EROFS", "Only a mounted memory store can be written to.")
		}
		if (at.mount.access === "read_only") {
			throw failure("EROFS", `The memory store ${at.mount.name} is read-only.`)
		}
		return at
	}
	const exists = async (at: Located) =>
		(await files(at.mount.name)).some((file) => file.path === at.path)
	const write = async (at: Located, content: string, base: string | null | undefined) => {
		const outcome = await memory().write(at.mount.name, at.path, content, base)
		listings.delete(at.mount.name)
		const sha = refuse(outcome)
		seen.set(key(at.mount.name, at.path), sha)
		return sha
	}
	const remove = async (at: Located) => {
		const outcome = await memory().remove(
			at.mount.name,
			at.path,
			seen.get(key(at.mount.name, at.path)),
		)
		listings.delete(at.mount.name)
		refuse(outcome)
		seen.delete(key(at.mount.name, at.path))
	}
	// What a write at a path replaces: what was last seen there, nothing if nothing is there, and
	// otherwise whatever is there now.
	const baseOf = async (at: Located): Promise<string | null | undefined> =>
		seen.get(key(at.mount.name, at.path)) ?? ((await exists(at)) ? undefined : null)

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
			const listing = await files(at.mount.name)
			const file = listing.find((entry) => entry.path === at.path)
			if (file !== undefined) {
				return fileStat(at.mount, file.size, file.updated_at)
			}
			return below(listing, at.path).length > 0 ? dirStat(at.mount) : null
		},
		readdir: async (rel, options) => {
			if (rel === "") {
				const all = await allMounts()
				const entries: Array<PassthroughDirent> = all.map((mount) => ({
					name: mount.name,
					...dirStat(mount),
				}))
				if (options?.recursive === true) {
					for (const mount of all) {
						entries.push(...nested(mount, await files(mount.name), "", `${mount.name}/`))
					}
				}
				return entries
			}
			const at = await locate(rel)
			if (at === undefined) {
				return null
			}
			const listing = await files(at.mount.name)
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
			const read = await memory().read(at.mount.name, at.path)
			if (read === null) {
				return null
			}
			seen.set(key(at.mount.name, at.path), read.content_sha256)
			const bytes = encoder.encode(read.content)
			const offset = Math.min(options?.range?.offset ?? 0, bytes.byteLength)
			const length = options?.range?.length
			const end = length === undefined ? bytes.byteLength : offset + length
			return {
				stat: fileStat(at.mount, bytes.byteLength, 0),
				body: new Blob([bytes.slice(offset, end)]).stream(),
				offset,
			}
		},
		writeFile: async (rel, body, options) => {
			const at = await writable(rel)
			if (at.path === "") {
				throw failure("EISDIR", `Is a directory: ${rel}`)
			}
			const content = await new Response(body).text()
			await write(at, content, options.exclusive === true ? null : await baseOf(at))
			return fileStat(at.mount, encoder.encode(content).byteLength, Date.now())
		},
		mkdir: async (rel) => {
			const at = await writable(rel)
			if (at.path !== "" && (await exists(at))) {
				throw failure("EEXIST", `A memory is there: ${rel}`)
			}
		},
		rm: async (rel, options) => {
			const at = await writable(rel)
			if (at.path === "") {
				throw failure("EBUSY", `A mounted memory store cannot be removed: ${rel}`)
			}
			if (await exists(at)) {
				await remove(at)
				return
			}
			const inside = below(await files(at.mount.name), at.path)
			if (inside.length === 0) {
				throw failure("ENOENT", `No such file or directory: ${rel}`)
			}
			if (options.recursive !== true) {
				throw failure("ENOTEMPTY", `Directory not empty: ${rel}`)
			}
			for (const file of inside) {
				await remove({ mount: at.mount, path: file.path })
			}
		},
		rename: async (from, to) => {
			const source = await writable(from)
			const target = await writable(to)
			if (source.path === "" || target.path === "") {
				throw failure("EBUSY", `A mounted memory store cannot be renamed: ${from}`)
			}
			const moves = (await exists(source))
				? [{ from: source, to: target }]
				: below(await files(source.mount.name), source.path).map((file) => ({
						from: { mount: source.mount, path: file.path },
						to: {
							mount: target.mount,
							path: `${target.path}${file.path.slice(source.path.length)}`,
						},
					}))
			if (moves.length === 0) {
				throw failure("ENOENT", `No such file or directory: ${from}`)
			}
			// Each file is written at its new path before it leaves its old one, so a refused write
			// leaves it where it was.
			for (const move of moves) {
				const read = await memory().read(move.from.mount.name, move.from.path)
				if (read === null) {
					throw failure("ENOENT", `No such file: ${move.from.path}`)
				}
				seen.set(key(move.from.mount.name, move.from.path), read.content_sha256)
				await write(move.to, read.content, await baseOf(move.to))
				await remove(move.from)
			}
		},
	}
}
