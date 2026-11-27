import { ArtifactName } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import { ARTIFACT_DATA_OPERATIONS, MAX_ARTIFACT_DATA_LIMIT } from "./SessionArtifactTool.ts"
import type { SessionDataRequest, SessionDataResult } from "./SessionArtifactTool.ts"
import type { WorkspaceToolResult } from "./WorkspaceTools.ts"

const decodeArguments = Schema.decodeUnknownOption(
	Schema.Struct({
		name: ArtifactName,
		collection: Schema.String.check(Schema.isMinLength(1)),
		operation: Schema.Literals(ARTIFACT_DATA_OPERATIONS),
		id: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
		data: Schema.optionalKey(Schema.Json),
		page: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
		limit: Schema.optionalKey(
			Schema.Int.check(
				Schema.isGreaterThanOrEqualTo(1),
				Schema.isLessThanOrEqualTo(MAX_ARTIFACT_DATA_LIMIT),
			),
		),
	}),
)

const told = (text: string, isError: boolean): WorkspaceToolResult => ({
	content: [{ type: "text", text }],
	isError,
})

export const artifactData = async (
	args: unknown,
	ask: (name: string, request: SessionDataRequest) => Promise<SessionDataResult>,
): Promise<WorkspaceToolResult> => {
	const decoded = decodeArguments(args)
	if (decoded._tag === "None") {
		return told(
			`artifact_data needs a name, a collection and an operation (${ARTIFACT_DATA_OPERATIONS.join(", ")}).`,
			true,
		)
	}
	const { name, collection, operation, id, data, page, limit } = decoded.value
	const needsId = operation === "get" || operation === "put" || operation === "delete"
	if (needsId && id === undefined) {
		return told(`${operation} needs the document's id.`, true)
	}
	const needsData = operation === "add" || operation === "put"
	if (needsData && data === undefined) {
		return told(`${operation} needs data: the JSON value to store.`, true)
	}
	const result = await ask(name, {
		operation,
		collection,
		id: needsId ? (id ?? "") : "",
		data: needsData ? JSON.stringify(data) : "",
		page: operation === "list" ? (page ?? "") : "",
		limit: operation === "list" ? (limit ?? 0) : 0,
	}).catch(() => null)
	if (result === null) {
		return told("The artifact's data could not be reached; try again.", true)
	}
	return result.ok ? told(result.text, false) : told(result.message, true)
}
