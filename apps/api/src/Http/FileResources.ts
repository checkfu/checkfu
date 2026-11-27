import type { FileState } from "@checkfu/domain/File/File.aggregate"
import type { FileId } from "@checkfu/domain/File/File.id"
import { SessionId } from "@checkfu/domain/Session/Session.id"
import * as DateTime from "effect/DateTime"

export const fileResource = (id: FileId, state: FileState) => ({
	id,
	type: "file" as const,
	filename: state.filename,
	content_type: state.content_type,
	size: state.size,
	sha256: state.sha256,
	origin:
		state.origin_turn === 0
			? { type: "upload" as const }
			: {
					type: "session" as const,
					session_id: SessionId.make(state.origin_session_id),
					turn: state.origin_turn,
					path: state.origin_path,
				},
	created_at: DateTime.makeUnsafe(state.created_at),
})
