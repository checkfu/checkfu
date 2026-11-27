import { ArtifactName, ArtifactPath, FileName } from "@checkfu/sdk/Schemas"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import {
	MAX_TOOL_ARTIFACT_FILE_BYTES,
	MAX_TOOL_ARTIFACT_FILES,
	MAX_TOOL_ARTIFACT_TOTAL_BYTES,
} from "./SessionArtifactTool.ts"
import type { SavedSessionArtifact, SavedSessionFile } from "./SessionArtifactTool.ts"
import { SESSION_OUTPUTS_PATH } from "./SessionOutputs.ts"
import type { OutputFiles } from "./SessionOutputs.ts"
import type { WorkspaceToolResult } from "./WorkspaceTools.ts"

const MEBIBYTE = 1024 * 1024

const MAX_TOOL_ARTIFACT_ENTRIES = 8 * MAX_TOOL_ARTIFACT_FILES

const decodeArguments = Schema.decodeUnknownOption(
	Schema.Struct({
		name: ArtifactName,
		directory: Schema.String.check(Schema.isMinLength(1)),
	}),
)

const isArtifactPath = Schema.is(ArtifactPath)
const isFileName = Schema.is(FileName)

export interface ArtifactToolPorts {
	readonly capture: (directory: string) => OutputFiles
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

const missingPath = (error: unknown) =>
	Predicate.hasProperty(error, "code") && (error.code === "ENOENT" || error.code === "ENOTDIR")

export const saveArtifact = async (
	args: unknown,
	ports: ArtifactToolPorts,
	signal?: AbortSignal,
): Promise<WorkspaceToolResult> => {
	const decoded = decodeArguments(args)
	if (decoded._tag === "None") {
		return refused("save_artifact needs a name and a directory.")
	}
	const { name, directory: requested } = decoded.value
	if (!requested.startsWith("/")) {
		return refused("directory must be an absolute path, for example /workspace/site.")
	}
	const relative = requested
		.split("/")
		.filter((part) => part !== "" && part !== ".")
		.join("/")
	const directory = `/${relative}`
	if (
		!isArtifactPath(relative) ||
		!["/workspace", SESSION_OUTPUTS_PATH].some(
			(root) => directory === root || directory.startsWith(`${root}/`),
		)
	) {
		return refused("Choose a directory under /workspace or /mnt/session/outputs.")
	}
	signal?.throwIfAborted()
	const capture = ports.capture(directory)
	const found = await capture.list(MAX_TOOL_ARTIFACT_ENTRIES + 1).catch((error: unknown) => {
		if (missingPath(error)) {
			return null
		}
		throw error
	})
	signal?.throwIfAborted()
	if (found === null) {
		return refused(`${directory} is not a directory.`)
	}
	if (found.length > MAX_TOOL_ARTIFACT_ENTRIES) {
		return refused(`${directory} holds more than ${MAX_TOOL_ARTIFACT_ENTRIES} files and folders.`)
	}
	const paths: Array<string> = []
	const tooLarge = (path: string) =>
		refused(`${path} is larger than ${MAX_TOOL_ARTIFACT_FILE_BYTES / MEBIBYTE} MiB.`)
	const tooMuch = refused(
		`The files total more than ${MAX_TOOL_ARTIFACT_TOTAL_BYTES / MEBIBYTE} MiB.`,
	)
	let expected = 0
	for (const { path, type, size } of found) {
		if (!isArtifactPath(path)) {
			return refused(`${JSON.stringify(path)} is not a path an artifact can hold. Rename it.`)
		}
		if (type === "dir") {
			continue
		}
		if (type !== "file") {
			return refused(`${path} is not a regular file. Remove it or save a different directory.`)
		}
		if (!isFileName(path.slice(path.lastIndexOf("/") + 1))) {
			return refused(`${JSON.stringify(path)} is not a path an artifact can hold. Rename it.`)
		}
		if (size > MAX_TOOL_ARTIFACT_FILE_BYTES) {
			return tooLarge(path)
		}
		expected += size
		if (expected > MAX_TOOL_ARTIFACT_TOTAL_BYTES) {
			return tooMuch
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
		signal?.throwIfAborted()
		const bytes = await capture
			.read(path, MAX_TOOL_ARTIFACT_FILE_BYTES + 1)
			.catch((error: unknown) => {
				if (missingPath(error)) {
					return null
				}
				throw error
			})
		signal?.throwIfAborted()
		if (bytes === null) {
			return refused(`${path} could not be read.`)
		}
		if (bytes.byteLength > MAX_TOOL_ARTIFACT_FILE_BYTES) {
			return tooLarge(path)
		}
		total += bytes.byteLength
		if (total > MAX_TOOL_ARTIFACT_TOTAL_BYTES) {
			return tooMuch
		}
		const saved = await ports.saveFile(path, bytes).catch(() => null)
		signal?.throwIfAborted()
		if (saved === null) {
			return refused(`Saving ${path} failed; try again.`)
		}
		if (!saved.ok) {
			return refused(saved.message)
		}
		entries.push({ path, file_id: saved.file_id })
	}
	signal?.throwIfAborted()
	const artifact = await ports.saveArtifact(name, entries).catch(() => null)
	if (artifact === null) {
		signal?.throwIfAborted()
		return refused("Saving the artifact failed; try again.")
	}
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
