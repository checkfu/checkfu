import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import {
	ArtifactPath,
	MAX_ARTIFACT_FILES,
	MAX_ARTIFACT_FILE_BYTES,
	MAX_ARTIFACT_TOTAL_BYTES,
} from "../Artifacts/ArtifactFiles.ts"
import { NonNegativeInt } from "@checkfu/sdk/Schemas"

export const OutputFile = Schema.Struct({
	path: Schema.String,
	sha256: Schema.String,
	size: NonNegativeInt,
})
export type OutputFile = typeof OutputFile.Type

export const OutputsListing = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true), files: Schema.Array(OutputFile) }),
	Schema.Struct({ ok: Schema.Literal(false), reason: Schema.String }),
])
export type OutputsListing = typeof OutputsListing.Type

export const OutputBytes = Schema.Struct({ path: Schema.String, bytes: Schema.Uint8Array })
export type OutputBytes = typeof OutputBytes.Type

export const SESSION_OUTPUTS_PATH = "/mnt/session/outputs"

export const MAX_OUTPUT_ENTRIES = 8 * MAX_ARTIFACT_FILES

export interface OutputFiles {
	readonly list: (
		directory: string,
		limit: number,
	) => Promise<ReadonlyArray<{ readonly path: string; readonly type: string }>>
	readonly size: (file: string) => Promise<number>
	readonly read: (file: string) => Promise<Uint8Array<ArrayBuffer>>
}

const isArtifactPath = Schema.is(ArtifactPath)

const refused = (reason: string): OutputsListing => ({ ok: false, reason })

const hasCode = (error: unknown, code: string): boolean =>
	Predicate.hasProperty(error, "code") && error.code === code

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
	Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")

export const makeSessionOutputs = (files: OutputFiles) => ({
	list: async (): Promise<OutputsListing> => {
		const entries = await files
			.list(SESSION_OUTPUTS_PATH, MAX_OUTPUT_ENTRIES + 1)
			.catch((error: unknown) => {
				if (hasCode(error, "ENOENT")) {
					return []
				}
				if (hasCode(error, "ENOTDIR")) {
					return null
				}
				throw error
			})
		if (entries === null) {
			return refused(`${SESSION_OUTPUTS_PATH} is a file, not a directory.`)
		}
		if (entries.length > MAX_OUTPUT_ENTRIES) {
			return refused(`More than ${MAX_OUTPUT_ENTRIES} files and directories.`)
		}
		const found = entries.filter((entry) => entry.type === "file").map((entry) => entry.path)
		if (found.length > MAX_ARTIFACT_FILES) {
			return refused(`${found.length} files; the limit is ${MAX_ARTIFACT_FILES}.`)
		}
		const paths: Array<string> = []
		let totalBytes = 0
		for (const file of found) {
			const path = file.slice(SESSION_OUTPUTS_PATH.length + 1)
			if (!isArtifactPath(path)) {
				return refused(`File path ${JSON.stringify(path)} is not allowed.`)
			}
			const size = await files.size(file)
			if (size > MAX_ARTIFACT_FILE_BYTES) {
				return refused(`File "${path}" is ${size} bytes; the limit is ${MAX_ARTIFACT_FILE_BYTES}.`)
			}
			totalBytes += size
			if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
				return refused(`Files total more than ${MAX_ARTIFACT_TOTAL_BYTES} bytes.`)
			}
			paths.push(path)
		}
		const listed: Array<OutputFile> = []
		for (const path of paths) {
			const bytes = await files.read(`${SESSION_OUTPUTS_PATH}/${path}`)
			listed.push({ path, sha256: await sha256Hex(bytes), size: bytes.byteLength })
		}
		return { ok: true, files: listed }
	},

	read: async (paths: ReadonlyArray<string>): Promise<ReadonlyArray<OutputBytes>> => {
		const read: Array<OutputBytes> = []
		for (const path of paths) {
			read.push({ path, bytes: await files.read(`${SESSION_OUTPUTS_PATH}/${path}`) })
		}
		return read
	},
})
