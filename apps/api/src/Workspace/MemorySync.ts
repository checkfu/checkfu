import type { MemoryAccess } from "@checkfu/domain/Session/SessionResource"

export interface MemoryManifestEntry {
	readonly path: string
	readonly content_sha256: string
}

export interface MemoryMount {
	readonly mount_path: string
	readonly access: MemoryAccess
	readonly manifest: ReadonlyArray<MemoryManifestEntry>
}

export interface MemoryFile extends MemoryManifestEntry {
	readonly content: string
}

/** A file that differs from the store, without its content. `base` is what the store last had. */
export interface MemoryWrite extends MemoryManifestEntry {
	readonly size_bytes: number
	readonly base: string | null
}

export interface MemoryChanges {
	readonly written: ReadonlyArray<MemoryWrite>
	readonly deleted: ReadonlyArray<{ readonly path: string; readonly base: string }>
}

/** What the store took: the hashes now there, and the paths now gone. */
export interface MemorySaved {
	readonly written: ReadonlyArray<MemoryManifestEntry>
	readonly deleted: ReadonlyArray<string>
}

/** The files of a workspace, as far as copying a memory store in and out needs them. */
export interface MemoryFiles {
	/** The file's text, or null when no file is there: nothing, or a directory. */
	readonly read: (file: string) => Promise<string | null>
	/** Puts the file there, in place of a directory at its path or a file where its directory goes. */
	readonly write: (file: string, content: string) => Promise<void>
	readonly remove: (file: string) => Promise<void>
	readonly list: (directory: string) => Promise<ReadonlyArray<string>>
}

/** Per mount, the hash of each memory as the store last had it: what a local change is a change from. */
export interface MemoryBases {
	readonly get: (mountPath: string) => Readonly<Record<string, string>>
	readonly put: (mountPath: string, base: Readonly<Record<string, string>>) => void
}

/** Whether a filesystem error says the file is not there, the one failure that reads as "no file". */
export const isMissingFile = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	(error.code === "ENOENT" || error.code === "ENOTDIR")

export const sha256Hex = async (text: string): Promise<string> => {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength

/**
 * A store can hold a path and a path below it, which no directory of files can.
 * The memories below are kept and the one that would be their directory is left out.
 */
const withoutDirectories = (
	manifest: ReadonlyArray<MemoryManifestEntry>,
): ReadonlyArray<MemoryManifestEntry> => {
	const paths = manifest.map(({ path }) => path)
	return manifest.filter(({ path }) => !paths.some((other) => other.startsWith(`${path}/`)))
}

/**
 * Keeps a workspace directory in step with a memory store, one turn at a time.
 *
 * Before a turn, `mount` takes the store's manifest. Where the store moved on
 * from the base, the store wins: the local file is replaced or removed. Where
 * it did not, a local change stays, to be saved.
 *
 * After a turn, `changes` lists every local file that differs from its base,
 * with that base, so the store can refuse a write that would undo another
 * session's. `contents` reads the ones to send, and `saved` records what the
 * store took as the new base. A change the store did not take stays pending.
 */
export const makeMemorySync = (files: MemoryFiles, bases: MemoryBases) => ({
	/** Returns the paths whose content the workspace needs. */
	mount: async (mount: MemoryMount): Promise<ReadonlyArray<string>> => {
		const manifest = withoutDirectories(mount.manifest)
		const base = { ...bases.get(mount.mount_path) }
		// What the store dropped goes first, so that a path that was a directory can become a file.
		const listed = new Set(manifest.map(({ path }) => path))
		for (const path of Object.keys(base)) {
			if (!listed.has(path)) {
				await files.remove(`${mount.mount_path}${path}`)
				delete base[path]
			}
		}
		const needed: Array<string> = []
		for (const { path, content_sha256 } of manifest) {
			if (base[path] === content_sha256) {
				continue
			}
			const local = await files.read(`${mount.mount_path}${path}`)
			if (local !== null && (await sha256Hex(local)) === content_sha256) {
				base[path] = content_sha256
			} else {
				needed.push(path)
			}
		}
		bases.put(mount.mount_path, base)
		return needed
	},

	fill: async (mountPath: string, memories: ReadonlyArray<MemoryFile>): Promise<void> => {
		const base = { ...bases.get(mountPath) }
		for (const { path, content, content_sha256 } of memories) {
			await files.write(`${mountPath}${path}`, content)
			base[path] = content_sha256
		}
		bases.put(mountPath, base)
	},

	changes: async (mountPath: string): Promise<MemoryChanges> => {
		const base = bases.get(mountPath)
		const written: Array<MemoryWrite> = []
		const present = new Set<string>()
		for (const file of await files.list(mountPath)) {
			const path = file.slice(mountPath.length)
			const content = await files.read(file)
			if (content === null) {
				continue
			}
			present.add(path)
			const content_sha256 = await sha256Hex(content)
			if (base[path] !== content_sha256) {
				written.push({
					path,
					content_sha256,
					size_bytes: byteLength(content),
					base: base[path] ?? null,
				})
			}
		}
		return {
			written,
			deleted: Object.entries(base)
				.filter(([path]) => !present.has(path))
				.map(([path, hash]) => ({ path, base: hash })),
		}
	},

	/** The content of the named memories as it is now. One that is gone is left out. */
	contents: async (
		mountPath: string,
		paths: ReadonlyArray<string>,
	): Promise<ReadonlyArray<MemoryFile>> => {
		const read: Array<MemoryFile> = []
		for (const path of paths) {
			const content = await files.read(`${mountPath}${path}`)
			if (content !== null) {
				read.push({ path, content, content_sha256: await sha256Hex(content) })
			}
		}
		return read
	},

	saved: (mountPath: string, saved: MemorySaved): void => {
		const base = { ...bases.get(mountPath) }
		for (const { path, content_sha256 } of saved.written) {
			base[path] = content_sha256
		}
		for (const path of saved.deleted) {
			delete base[path]
		}
		bases.put(mountPath, base)
	},
})

export type MemorySync = ReturnType<typeof makeMemorySync>
