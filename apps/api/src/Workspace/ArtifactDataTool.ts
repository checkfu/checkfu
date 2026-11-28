import { MAX_ARTIFACT_DOCUMENT_BYTES, MAX_ARTIFACT_DOCUMENT_PAGE_SIZE } from "@checkfu/sdk/Limits"
import { CLIENT_EVENT_ID_MAX_LENGTH } from "@checkfu/sdk/IdempotencyKey"
import { ArtifactName } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import { ARTIFACT_DATA_OPERATIONS } from "./SessionArtifactTool.ts"
import type { SessionDataRequest, SessionDataResult } from "./SessionArtifactTool.ts"
import type { WorkspaceToolResult } from "./WorkspaceTools.ts"

const RESULT_CHUNK_BYTES = 4096
const MAX_INLINE_RESULT_BYTES = 16 * 1024
const encoder = new TextEncoder()

export const ArtifactDataToolArguments = Schema.Struct({
	name: ArtifactName,
	collection: Schema.String.check(Schema.isMinLength(1)),
	operation: Schema.Literals(ARTIFACT_DATA_OPERATIONS),
	id: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMinLength(1)))),
	data: Schema.optionalKey(Schema.Json),
	key: Schema.optionalKey(
		Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(CLIENT_EVENT_ID_MAX_LENGTH)),
	),
	page: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMinLength(1)))),
	limit: Schema.optionalKey(
		Schema.NullOr(
			Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_ARTIFACT_DOCUMENT_PAGE_SIZE })),
		),
	),
})

const decodeArguments = Schema.decodeUnknownOption(ArtifactDataToolArguments)

const told = (text: string, isError: boolean): WorkspaceToolResult => ({
	content: [{ type: "text", text }],
	isError,
})

export const artifactData = async (
	args: unknown,
	ports: {
		readonly ask: (name: string, request: SessionDataRequest) => Promise<SessionDataResult>
		readonly defaultKey: string
		readonly writeResult: (text: string) => Promise<string>
	},
): Promise<WorkspaceToolResult> => {
	const decoded = decodeArguments(args)
	if (decoded._tag === "None") {
		return told(
			`artifact_data needs name (1 to 256 characters), collection and operation (${ARTIFACT_DATA_OPERATIONS.join(", ")}). id is text, data any JSON value, limit an integer from 1 to ${MAX_ARTIFACT_DOCUMENT_PAGE_SIZE}, and page the next_page text of an earlier list.`,
			true,
		)
	}
	const { name, collection, operation, id, data, page, limit, key } = decoded.value
	const needsId = operation === "get" || operation === "put" || operation === "delete"
	if (needsId && (id === undefined || id === null)) {
		return told(`${operation} needs the document's id.`, true)
	}
	const needsData = operation === "add" || operation === "put"
	if (needsData && data === undefined) {
		return told(`${operation} needs data: the JSON value to store.`, true)
	}
	const encoded = needsData ? JSON.stringify(data) : ""
	if (encoder.encode(encoded).byteLength > MAX_ARTIFACT_DOCUMENT_BYTES) {
		return told(`A document may be at most ${MAX_ARTIFACT_DOCUMENT_BYTES} bytes of JSON.`, true)
	}
	const addKey = operation === "add" ? (key ?? ports.defaultKey) : ""
	const result = await ports
		.ask(name, {
			operation,
			collection,
			id: needsId ? (id ?? "") : "",
			data: encoded,
			page: operation === "list" ? (page ?? "") : "",
			limit: operation === "list" ? (limit ?? 0) : 0,
			key: addKey,
		})
		.catch(() => null)
	if (result === null) {
		return told(
			operation === "add"
				? `The add could have succeeded. Repeat it with key ${JSON.stringify(addKey)} to avoid another document.`
				: "The artifact's data could not be reached. Check its state before retrying.",
			true,
		)
	}
	if (!result.ok) {
		return told(result.message, true)
	}
	if (encoder.encode(result.text).byteLength <= MAX_INLINE_RESULT_BYTES) {
		return told(result.text, false)
	}
	const path = await ports.writeResult(result.text).catch(() => null)
	const fields = { id: result.id, next_page: result.next_page }
	return path === null
		? told(
				JSON.stringify({
					...fields,
					message:
						"The operation finished but its full result could not be saved in the workspace.",
				}),
				true,
			)
		: told(JSON.stringify({ ...fields, path }), false)
}

export const readArtifactDataResult = async (
	byteOffset: unknown,
	read: (offset: number, length: number) => Promise<ReadableStream<Uint8Array>>,
): Promise<WorkspaceToolResult> => {
	const start = byteOffset ?? 0
	if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 0) {
		return told("byteOffset must be a nonnegative integer.", true)
	}
	try {
		const bytes = new Uint8Array(
			await new Response(await read(start, RESULT_CHUNK_BYTES + 1)).arrayBuffer(),
		)
		let end = Math.min(RESULT_CHUNK_BYTES, bytes.length)
		while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
			end -= 1
		}
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes.subarray(0, end),
		)
		return told(
			JSON.stringify({
				text,
				next_byte_offset: end < bytes.length ? start + end : null,
			}),
			false,
		)
	} catch {
		return told(
			"The result could not be read. Start at byteOffset 0 and use next_byte_offset for each following read.",
			true,
		)
	}
}
