// What a session's workspace may do with the memory stores mounted in it. The API serves this for
// the length of one turn: the harness reaches the stores only through it, and only while the API
// waits on that turn.

export type MemoryAccessMode = "read_write" | "read_only"

/** A mounted store: its directory name under /mnt/memory and what the session may do in it. */
export interface MemoryMountInfo {
	readonly name: string
	readonly access: MemoryAccessMode
}

/** A memory as a file: its path in the store, its size in bytes and when it last changed. */
export interface MemoryFileInfo {
	readonly path: string
	readonly size: number
	readonly updated_at: number
}

export interface MemoryContent {
	readonly content: string
	readonly content_sha256: string
}

export type MemoryErrorCode = "EROFS" | "ENOENT" | "EEXIST" | "ENOSPC" | "EINVAL" | "EISDIR" | "EIO"

export type MemoryOutcome =
	| { readonly ok: true; readonly content_sha256: string }
	| { readonly ok: false; readonly code: MemoryErrorCode; readonly message: string }

export interface SessionMemory {
	readonly mounts: () => Promise<ReadonlyArray<MemoryMountInfo>>
	readonly list: (name: string) => Promise<ReadonlyArray<MemoryFileInfo>>
	readonly read: (name: string, path: string) => Promise<MemoryContent | null>
	/**
	 * `base` is the hash of the content the session last read there: null creates only, and
	 * undefined replaces whatever is there. A base that no longer matches is refused (EEXIST), so
	 * one session never silently undoes another's change.
	 */
	readonly write: (
		name: string,
		path: string,
		content: string,
		base: string | null | undefined,
	) => Promise<MemoryOutcome>
	readonly remove: (name: string, path: string, base: string | undefined) => Promise<MemoryOutcome>
}
