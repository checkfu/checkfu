import type { PassthroughDirent, PassthroughMount, PassthroughStat } from "@cloudflare/computer"
import type { ArtifactFileInfo, SessionArtifacts } from "./SessionArtifacts.ts"

const DIR: PassthroughStat = { type: "dir", size: 0, mtime: 0, mode: 0o555 }

const fileStat = (size: number): PassthroughStat => ({ type: "file", size, mtime: 0, mode: 0o444 })

const failure = (code: "EIO" | "ENOTDIR", message: string): Error =>
	Object.assign(new Error(message), { code })

const nested = (
	files: ReadonlyArray<ArtifactFileInfo>,
	dir: string,
	prefix: string,
	recursive: boolean,
	walkLimit: number,
	existing = 0,
): Array<PassthroughDirent> => {
	const entries = new Map<string, PassthroughDirent>()
	const add = (entry: PassthroughDirent): void => {
		if (!entries.has(entry.name) && existing + entries.size >= walkLimit) {
			throw failure("EIO", `More than ${walkLimit} entries to list.`)
		}
		entries.set(entry.name, entry)
	}
	for (const file of files) {
		if (dir !== "" && !file.path.startsWith(`${dir}/`)) {
			continue
		}
		const parts = (dir === "" ? file.path : file.path.slice(dir.length + 1)).split("/")
		const depth = recursive ? parts.length : 1
		for (let at = 1; at <= depth; at += 1) {
			const name = `${prefix}${parts.slice(0, at).join("/")}`
			add(at === parts.length ? { name, ...fileStat(file.size) } : { name, ...DIR })
		}
	}
	return [...entries.values()].sort((a, b) => a.name.split("/").length - b.name.split("/").length)
}

const READ_CHUNK_BYTES = 256 * 1024

export const makeArtifactMount = (
	root: string,
	artifacts: SessionArtifacts,
	walkLimit: number,
	verifyEmptyReads = false,
): PassthroughMount => {
	const mounted = async () =>
		(await artifacts.mounts())
			.filter((path) => path.startsWith(`${root}/`))
			.map((path) => path.slice(root.length + 1))
	const files = (name: string, path = "") =>
		artifacts.files(`${root}/${name}`, path === "" ? null : path)
	const locate = async (rel: string) => {
		const [name = "", ...rest] = rel.split("/")
		return (await mounted()).includes(name) ? { name, path: rest.join("/") } : undefined
	}

	return {
		kind: "checkfu-artifacts",
		strategy: "passthrough",
		mode: "read-only",
		stat: async (rel) => {
			if (rel === "") {
				return DIR
			}
			const at = await locate(rel)
			if (at === undefined) {
				return null
			}
			if (at.path === "") {
				return DIR
			}
			const listing = await files(at.name, at.path)
			const file = listing.find((entry) => entry.path === at.path)
			if (file !== undefined) {
				return fileStat(file.size)
			}
			return listing.some((entry) => entry.path.startsWith(`${at.path}/`)) ? DIR : null
		},
		readdir: async (rel, options) => {
			const limit = Math.min(walkLimit, options?.limit ?? walkLimit)
			if (rel === "") {
				const all = await mounted()
				if (all.length > limit) {
					throw failure("EIO", `More than ${limit} entries to list.`)
				}
				const entries: Array<PassthroughDirent> = all.map((name) => ({ name, ...DIR }))
				if (options?.recursive === true) {
					for (const name of all) {
						for (const entry of nested(
							await files(name),
							"",
							`${name}/`,
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
			const listing = await files(at.name, at.path)
			if (listing.some((file) => file.path === at.path)) {
				throw failure("ENOTDIR", `Not a directory: ${rel}`)
			}
			const entries = nested(listing, at.path, "", options?.recursive === true, limit)
			if (at.path !== "" && entries.length === 0) {
				return null
			}
			return entries
		},
		readFile: async (rel, options) => {
			const at = await locate(rel)
			if (at === undefined || at.path === "") {
				return null
			}
			const file = (await files(at.name, at.path)).find((entry) => entry.path === at.path)
			if (file === undefined) {
				return null
			}
			const offset = Math.min(options?.range?.offset ?? 0, file.size)
			const end = offset + Math.min(options?.range?.length ?? file.size, file.size - offset)
			const mountPath = `${root}/${at.name}`
			if (
				verifyEmptyReads &&
				offset === end &&
				(await artifacts.read(mountPath, at.path, offset, 0)) === null
			) {
				return null
			}
			let next = offset
			return {
				stat: fileStat(file.size),
				body: new ReadableStream<Uint8Array>({
					pull: async (controller) => {
						if (next >= end) {
							controller.close()
							return
						}
						const length = Math.min(READ_CHUNK_BYTES, end - next)
						const bytes = await artifacts.read(mountPath, at.path, next, length)
						if (bytes === null) {
							controller.error(failure("EIO", `No longer available: ${rel}`))
							return
						}
						next += length
						controller.enqueue(bytes)
					},
				}),
				offset,
			}
		},
	}
}

/** One mount whose own directory holds the files, rather than a directory of mounts. */
export const makeFilesMount = (
	mountPath: string,
	artifacts: SessionArtifacts,
	walkLimit: number,
): PassthroughMount => {
	const at = mountPath.lastIndexOf("/")
	const name = mountPath.slice(at + 1)
	const inner = makeArtifactMount(mountPath.slice(0, at), artifacts, walkLimit, true)
	const inside = (rel: string) => (rel === "" ? name : `${name}/${rel}`)
	return {
		...inner,
		kind: "checkfu-files",
		stat: async (rel) => (await inner.stat(inside(rel))) ?? (rel === "" ? DIR : null),
		readdir: async (rel, options) =>
			(await inner.readdir(inside(rel), options)) ?? (rel === "" ? [] : null),
		readFile: (rel, options) => inner.readFile(inside(rel), options),
	}
}
