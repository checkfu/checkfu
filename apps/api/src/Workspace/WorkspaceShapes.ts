import { MemoryAccess, RepositoryCheckout } from "@checkfu/domain/Session/SessionResource"
import * as Schema from "effect/Schema"

// What crosses between the API Worker and the harness Worker for a session's workspace.

/** A turn of the session. Turn numbers only grow, so they order the session's turns. */
export const TurnToken = Schema.Struct({ turn: Schema.Finite })
export type TurnToken = typeof TurnToken.Type

export const RepositoryMount = Schema.Struct({
	id: Schema.String,
	url: Schema.String,
	mount_path: Schema.String,
	checkout: Schema.NullOr(RepositoryCheckout),
})
export type RepositoryMount = typeof RepositoryMount.Type

export const WorkspacePreparation = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true) }),
	Schema.Struct({ ok: Schema.Literal(false), resource_id: Schema.String, message: Schema.String }),
])
export type WorkspacePreparation = typeof WorkspacePreparation.Type

export const MemoryManifestEntry = Schema.Struct({
	path: Schema.String,
	content_sha256: Schema.String,
})
export type MemoryManifestEntry = typeof MemoryManifestEntry.Type

export const MemoryMount = Schema.Struct({
	mount_path: Schema.String,
	access: MemoryAccess,
	manifest: Schema.Array(MemoryManifestEntry),
})
export type MemoryMount = typeof MemoryMount.Type

export const MemoryFile = Schema.Struct({ ...MemoryManifestEntry.fields, content: Schema.String })
export type MemoryFile = typeof MemoryFile.Type

/** A file that differs from the store, without its content. `base` is what the store last had. */
export const MemoryWrite = Schema.Struct({
	...MemoryManifestEntry.fields,
	size_bytes: Schema.Finite,
	base: Schema.NullOr(Schema.String),
})
export type MemoryWrite = typeof MemoryWrite.Type

export const MemoryChanges = Schema.Struct({
	written: Schema.Array(MemoryWrite),
	deleted: Schema.Array(Schema.Struct({ path: Schema.String, base: Schema.String })),
})
export type MemoryChanges = typeof MemoryChanges.Type

/** What the store took: the hashes now there, and the paths now gone. */
export const MemorySaved = Schema.Struct({
	written: Schema.Array(MemoryManifestEntry),
	deleted: Schema.Array(Schema.String),
})
export type MemorySaved = typeof MemorySaved.Type
