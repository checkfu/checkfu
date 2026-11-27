import * as Schema from "effect/Schema"

export const MAX_TOOL_ARTIFACT_FILES = 256
export const MAX_TOOL_ARTIFACT_FILE_BYTES = 8 * 1024 * 1024
export const MAX_TOOL_ARTIFACT_TOTAL_BYTES = 64 * 1024 * 1024

const Session = Schema.String
const Turn = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const Refused = Schema.Struct({ ok: Schema.Literal(false), message: Schema.String })

export const SavedSessionFile = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true), file_id: Schema.String }),
	Refused,
])
export type SavedSessionFile = typeof SavedSessionFile.Type

export const SessionArtifactEntry = Schema.Struct({ path: Schema.String, file_id: Schema.String })
export type SessionArtifactEntry = typeof SessionArtifactEntry.Type

export const SavedSessionArtifact = Schema.Union([
	Schema.Struct({
		ok: Schema.Literal(true),
		artifact_id: Schema.String,
		version: Schema.Int,
		changed: Schema.Boolean,
	}),
	Refused,
])
export type SavedSessionArtifact = typeof SavedSessionArtifact.Type

export const DEFAULT_ARTIFACT_DATA_LIMIT = 50
export const MAX_ARTIFACT_DATA_LIMIT = 100

export const ARTIFACT_DATA_OPERATIONS = ["list", "get", "add", "put", "delete"] as const

export const SessionDataRequest = Schema.Struct({
	operation: Schema.Literals(ARTIFACT_DATA_OPERATIONS),
	collection: Schema.String,
	id: Schema.String,
	data: Schema.String,
	page: Schema.String,
	limit: Schema.Int,
})
export type SessionDataRequest = typeof SessionDataRequest.Type

export const SessionDataResult = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true), text: Schema.String }),
	Refused,
])
export type SessionDataResult = typeof SessionDataResult.Type

export const SessionArtifactToolCalls = {
	sessionFileSave: {
		args: Schema.Tuple([Session, Turn, Schema.String, Schema.Uint8Array]),
		result: SavedSessionFile,
	},
	sessionArtifactSave: {
		args: Schema.Tuple([Session, Turn, Schema.String, Schema.Array(SessionArtifactEntry)]),
		result: SavedSessionArtifact,
	},
	sessionArtifactData: {
		args: Schema.Tuple([Session, Turn, Schema.String, SessionDataRequest]),
		result: SessionDataResult,
	},
}
