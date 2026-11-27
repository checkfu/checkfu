import type {
	PassthroughDirent,
	PassthroughMount,
	PassthroughStat,
	WorkspaceErrorCode,
} from "@cloudflare/computer"
import { MAX_MEMORY_CONTENT_BYTES } from "@checkfu/domain/Memory/MemoryTypes"
import type {
	MemoryFileInfo,
	MemoryMountInfo,
	MemoryOutcome,
	SessionMemory,
} from "./SessionMemory.ts"

const failure = (code: WorkspaceErrorCode, message: string): Error =>
	Object.assign(new Error(message), { code })

const refuse = (outcome: MemoryOutcome): string => {
	if (!outcome.ok) {
		throw failure(outcome.code, outcome.message)
	}
	return outcome.content_sha256
}

const encoder = new TextEncoder()
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

const decode = (bytes: Uint8Array, rel: string): string => {
	try {
		return strictUtf8.decode(bytes)
	} catch {
		throw failure("EINVAL", `A memory holds UTF-8 text; ${rel} is not.`)
	}
}

const readWriteBody = async (body: ReadableStream<Uint8Array>, rel: string): Promise<string> => {
	const reader = body.getReader()
	let bytes: Uint8Array | undefined
	let size = 0
	try {
		for (;;) {
			const chunk = await reader.read()
			if (chunk.done) {
				return bytes === undefined ? "" : decode(bytes.subarray(0, size), rel)
			}
			const nextSize = size + chunk.value.byteLength
			if (nextSize > MAX_MEMORY_CONTENT_BYTES) {
				void reader.cancel().catch(() => undefined)
				throw failure("EINVAL", `A memory holds at most ${MAX_MEMORY_CONTENT_BYTES} bytes.`)
			}
			if (nextSize > size) {
				bytes ??= new Uint8Array(MAX_MEMORY_CONTENT_BYTES)
				bytes.set(chunk.value, size)
				size = nextSize
			}
		}
	} finally {
		reader.releaseLock()
	}
}

interface Located {
	readonly mount: MemoryMountInfo
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

const nested = (
	mount: MemoryMountInfo,
	files: ReadonlyArray<MemoryFileInfo>,
	dir: string,
	prefix: string,
	recursive: boolean,
	limit: number,
	existing = 0,
): Array<PassthroughDirent> => {
	const entries = new Map<string, PassthroughDirent>()
	for (const file of files) {
		if (!file.path.startsWith(`${dir}/`)) {
			continue
		}
		const relative = file.path.slice(dir.length + 1)
		let slash = relative.indexOf("/")
		for (;;) {
			const name = prefix + (slash === -1 ? relative : relative.slice(0, slash))
			if (!entries.has(name)) {
				if (existing + entries.size >= limit) {
					throw failure("EIO", `More than ${limit} entries to list.`)
				}
				entries.set(name, {
					name,
					...(slash === -1 ? fileStat(mount, file.size, file.updated_at) : dirStat(mount)),
				})
			}
			if (!recursive || slash === -1) {
				break
			}
			slash = relative.indexOf("/", slash + 1)
		}
	}
	return [...entries.values()]
}

export const makeMemoryMount = (memory: SessionMemory, walkLimit = Infinity): PassthroughMount => {
	const locate = async (rel: string, fresh = false): Promise<Located | undefined> => {
		const [name, ...rest] = rel.split("/")
		const mount = (await memory.mounts(fresh)).find((mounted) => mounted.name === name)
		return mount === undefined
			? undefined
			: { mount, path: rest.length === 0 ? "" : `/${rest.join("/")}` }
	}
	const writable = async (rel: string, fresh = false): Promise<Located> => {
		const at = await locate(rel, fresh)
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
			const file = await memory.stat(at.mount.name, at.path)
			if (file !== null) {
				return fileStat(at.mount, file.size, file.updated_at)
			}
			return (await memory.list(at.mount.name)).some(({ path }) => path.startsWith(`${at.path}/`))
				? dirStat(at.mount)
				: null
		},
		readdir: async (rel, options) => {
			const limit = Math.min(walkLimit, options?.limit ?? walkLimit)
			if (rel === "") {
				const all = await memory.mounts()
				if (all.length > limit) {
					throw failure("EIO", `More than ${limit} entries to list.`)
				}
				const entries: Array<PassthroughDirent> = all.map((mount) => ({
					name: mount.name,
					...dirStat(mount),
				}))
				if (options?.recursive === true) {
					for (const mount of all) {
						for (const entry of nested(
							mount,
							await memory.list(mount.name),
							"",
							`${mount.name}/`,
							true,
							limit,
							entries.length,
						)) {
							entries.push(entry)
						}
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
			const entries = nested(at.mount, listing, at.path, "", options?.recursive === true, limit)
			if (at.path !== "" && entries.length === 0) {
				return null
			}
			return entries
		},
		readFile: async (rel) => {
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
			return {
				stat: fileStat(at.mount, bytes.byteLength, found.updated_at),
				body: new Blob([bytes]).stream(),
				offset: 0,
			}
		},
		writeFile: async (rel, body, options) => {
			const at = await writable(rel)
			if (at.path === "") {
				throw failure("EISDIR", `Is a directory: ${rel}`)
			}
			await write(at, await readWriteBody(body, rel), options.exclusive === true)
		},
		mkdir: async (rel) => {
			const at = await writable(rel, true)
			if (at.path !== "" && (await memory.stat(at.mount.name, at.path)) !== null) {
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
				await writable(from, true)
				return
			}
			const file = await read(source)
			if (below(await memory.list(target.mount.name), target.path).length > 0) {
				throw failure(file === null ? "ENOTEMPTY" : "EISDIR", `Directory not empty: ${to}`)
			}
			if (file === null && (await read(target)) !== null) {
				throw failure("ENOTDIR", `Not a directory: ${to}`)
			}
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
