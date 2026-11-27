import { ArtifactPath } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import type { SavedSessionArtifact, SavedSessionFile } from "./SessionArtifactTool.ts"
import type { WorkspaceTool, WorkspaceToolResult } from "./WorkspaceTools.ts"

const MEBIBYTE = 1024 * 1024

export const MAX_TOOL_ARTIFACT_FILES = 256
export const MAX_TOOL_ARTIFACT_FILE_BYTES = 8 * MEBIBYTE
export const MAX_TOOL_ARTIFACT_TOTAL_BYTES = 64 * MEBIBYTE
const MAX_TOOL_ARTIFACT_ENTRIES = 8 * MAX_TOOL_ARTIFACT_FILES

export const ARTIFACT_TOOL: WorkspaceTool = {
	name: "save_artifact",
	description: `Save a directory of your workspace as an artifact: a named set of files the user can open, share by link or publish, kept after the session ends. \`directory\` is the absolute path of the directory whose contents become the artifact's files, and \`name\` is what the user sees. Saving again with the same name adds a new version of the same artifact, and saving unchanged files changes nothing. A page should have an index.html at the top of the directory. At most ${MAX_TOOL_ARTIFACT_FILES} files, ${MAX_TOOL_ARTIFACT_FILE_BYTES / MEBIBYTE} MiB each and ${MAX_TOOL_ARTIFACT_TOTAL_BYTES / MEBIBYTE} MiB in total, all regular files.`,
	parameters: {
		type: "object",
		properties: {
			name: { type: "string" },
			directory: { type: "string" },
		},
		required: ["name", "directory"],
		additionalProperties: false,
	},
}

const decodeArguments = Schema.decodeUnknownOption(
	Schema.Struct({
		name: Schema.String.check(Schema.isMinLength(1)),
		directory: Schema.String.check(Schema.isMinLength(1)),
	}),
)

const isArtifactPath = Schema.is(ArtifactPath)

export interface ArtifactToolPorts {
	readonly find: (
		directory: string,
		limit: number,
	) => Promise<ReadonlyArray<{ readonly path: string; readonly type: string }>>
	/** The file's bytes, or more than `limit` of them when it is larger. */
	readonly read: (path: string, limit: number) => Promise<Uint8Array>
	readonly saveFile: (path: string, bytes: Uint8Array) => Promise<SavedSessionFile>
	readonly saveArtifact: (
		name: string,
		entries: ReadonlyArray<{ readonly path: string; readonly file_id: string }>,
	) => Promise<SavedSessionArtifact>
}

const told = (text: string, isError: boolean): WorkspaceToolResult => ({
	content: [{ type: "text", text }],
	isError,
})

const refused = (text: string) => told(text, true)

export const saveArtifact = async (
	args: unknown,
	ports: ArtifactToolPorts,
): Promise<WorkspaceToolResult> => {
	const decoded = decodeArguments(args)
	if (decoded._tag === "None") {
		return refused("save_artifact needs a name and a directory.")
	}
	const { name } = decoded.value
	const directory =
		decoded.value.directory.length > 1 && decoded.value.directory.endsWith("/")
			? decoded.value.directory.slice(0, -1)
			: decoded.value.directory
	if (!directory.startsWith("/")) {
		return refused("directory must be an absolute path, for example /workspace/site.")
	}
	const found = await ports.find(directory, MAX_TOOL_ARTIFACT_ENTRIES + 1).catch(() => null)
	if (found === null) {
		return refused(`${directory} is not a directory.`)
	}
	if (found.length > MAX_TOOL_ARTIFACT_ENTRIES) {
		return refused(`${directory} holds more than ${MAX_TOOL_ARTIFACT_ENTRIES} files and folders.`)
	}
	const prefix = directory === "/" ? "/" : `${directory}/`
	const paths: Array<string> = []
	for (const entry of found) {
		if (entry.type === "dir") {
			continue
		}
		const path = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path
		if (entry.type !== "file") {
			return refused(`${path} is not a regular file. Remove it or save a different directory.`)
		}
		if (!isArtifactPath(path)) {
			return refused(`${JSON.stringify(path)} is not a path an artifact can hold. Rename it.`)
		}
		paths.push(path)
	}
	if (paths.length === 0) {
		return refused(`${directory} holds no files.`)
	}
	if (paths.length > MAX_TOOL_ARTIFACT_FILES) {
		return refused(
			`${paths.length} files; an artifact saved here holds at most ${MAX_TOOL_ARTIFACT_FILES}.`,
		)
	}
	const entries: Array<{ readonly path: string; readonly file_id: string }> = []
	let total = 0
	for (const path of paths.toSorted()) {
		const bytes = await ports
			.read(`${prefix}${path}`, MAX_TOOL_ARTIFACT_FILE_BYTES)
			.catch(() => null)
		if (bytes === null) {
			return refused(`${path} could not be read.`)
		}
		if (bytes.byteLength > MAX_TOOL_ARTIFACT_FILE_BYTES) {
			return refused(`${path} is larger than ${MAX_TOOL_ARTIFACT_FILE_BYTES / MEBIBYTE} MiB.`)
		}
		total += bytes.byteLength
		if (total > MAX_TOOL_ARTIFACT_TOTAL_BYTES) {
			return refused(`The files total more than ${MAX_TOOL_ARTIFACT_TOTAL_BYTES / MEBIBYTE} MiB.`)
		}
		const saved = await ports.saveFile(path, bytes)
		if (!saved.ok) {
			return refused(saved.message)
		}
		entries.push({ path, file_id: saved.file_id })
	}
	const artifact = await ports.saveArtifact(name, entries)
	if (!artifact.ok) {
		return refused(artifact.message)
	}
	const files = `${entries.length} ${entries.length === 1 ? "file" : "files"}`
	return told(
		artifact.changed
			? `Saved ${JSON.stringify(name)} as artifact ${artifact.artifact_id}, version ${artifact.version}, with ${files}.`
			: `${JSON.stringify(name)} is unchanged: artifact ${artifact.artifact_id} is still at version ${artifact.version}, with ${files}.`,
		false,
	)
}

/** Reads until the stream ends or more than `limit` bytes have arrived. */
export const readUpTo = async (
	body: ReadableStream<Uint8Array>,
	limit: number,
): Promise<Uint8Array> => {
	const chunks: Array<Uint8Array> = []
	let size = 0
	const reader = body.getReader()
	try {
		while (size <= limit) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}
			chunks.push(value)
			size += value.byteLength
		}
	} finally {
		await reader.cancel().catch(() => undefined)
	}
	const bytes = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return bytes
}
