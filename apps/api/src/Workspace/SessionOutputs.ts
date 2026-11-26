import type { Workspace } from "@cloudflare/computer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { ArtifactPath } from "../Artifacts/ArtifactFiles.ts"
import { NonNegativeInt } from "@checkfu/sdk/Schemas"

export const OutputRead = Schema.Struct({ path: Schema.String, size: NonNegativeInt })
export type OutputRead = typeof OutputRead.Type

export const OutputFile = OutputRead.mapFields((fields) => ({ ...fields, sha256: Schema.String }))
export type OutputFile = typeof OutputFile.Type

export const OutputsListing = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true), files: Schema.Array(OutputFile) }),
	Schema.Struct({ ok: Schema.Literal(false), reason: Schema.String }),
])
export type OutputsListing = typeof OutputsListing.Type

export const OutputBytes = Schema.Struct({ path: Schema.String, bytes: Schema.Uint8Array })
export type OutputBytes = typeof OutputBytes.Type

export const SESSION_OUTPUTS_PATH = "/mnt/session/outputs"

export const MAX_OUTPUT_FILES = 64
export const MAX_OUTPUT_FILE_BYTES = 1024 * 1024
export const MAX_OUTPUT_TOTAL_BYTES = 4 * 1024 * 1024
export const MAX_OUTPUT_ENTRIES = 8 * MAX_OUTPUT_FILES

export const OutputEntry = Schema.Struct({ path: Schema.String, type: Schema.String })

export interface OutputFiles {
	readonly list: (limit: number) => Promise<ReadonlyArray<typeof OutputEntry.Type>>
	/** Read at most this many bytes from a regular file, relative to the output directory. */
	readonly read: (path: string, limit: number) => Promise<Uint8Array<ArrayBuffer>>
}

const isArtifactPath = Schema.is(ArtifactPath)

export const makeStoredOutputFiles = (workspace: Workspace): OutputFiles => {
	const provider = workspace.provider()
	const directory = (path: string): void => {
		if (!provider.lstatSync(path).isDirectory()) {
			throw Object.assign(new Error("Expected an output directory."), { code: "ENOTDIR" })
		}
	}
	const outputRoot = (): void => {
		let path = ""
		for (const part of SESSION_OUTPUTS_PATH.slice(1).split("/")) {
			path += `/${part}`
			directory(path)
		}
	}
	return {
		list: async (limit) => {
			outputRoot()
			const entries = await workspace.fs.find(SESSION_OUTPUTS_PATH, undefined, { limit })
			return entries.map(({ path, type }) => ({
				path: path.slice(SESSION_OUTPUTS_PATH.length + 1),
				type,
			}))
		},
		read: async (path, limit) => {
			if (!isArtifactPath(path)) {
				throw new Error("Invalid output path.")
			}
			// The checks and bounded range read run synchronously on the local SQLite store.
			outputRoot()
			const parts = path.split("/")
			let parent = SESSION_OUTPUTS_PATH
			for (const part of parts.slice(0, -1)) {
				parent += `/${part}`
				directory(parent)
			}
			const file = `${SESSION_OUTPUTS_PATH}/${path}`
			const stat = provider.lstatSync(file)
			if (!stat.isFile() || stat.nlink !== 1) {
				throw Object.assign(new Error("Expected a regular output file."), { code: "EAGAIN" })
			}
			const bytes = provider.readRangeSync(file, 0, limit)
			if (bytes.byteLength !== Math.min(stat.size, limit)) {
				throw Object.assign(new Error("Output size changed during capture."), { code: "EAGAIN" })
			}
			return Uint8Array.from(bytes)
		},
	}
}

const refused = (reason: string): OutputsListing => ({ ok: false, reason })

const hasCode = (error: unknown, code: string): boolean =>
	Predicate.hasProperty(error, "code") && error.code === code

const changedDuringCapture = (error: unknown): boolean =>
	["ENOENT", "ENOTDIR", "EAGAIN"].some((code) => hasCode(error, code))

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
	Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")

export const makeSessionOutputs = (files: OutputFiles) => ({
	list: async (): Promise<OutputsListing> => {
		const entries = await files.list(MAX_OUTPUT_ENTRIES + 1).catch((error: unknown) => {
			if (hasCode(error, "ENOENT")) {
				return []
			}
			if (hasCode(error, "ENOTDIR")) {
				return null
			}
			if (hasCode(error, "EAGAIN")) {
				return false
			}
			throw error
		})
		if (entries === false) {
			return refused("The output directory changed during capture.")
		}
		if (entries === null) {
			return refused(`${SESSION_OUTPUTS_PATH} is a file, not a directory.`)
		}
		if (entries.length > MAX_OUTPUT_ENTRIES) {
			return refused(`More than ${MAX_OUTPUT_ENTRIES} files and directories.`)
		}
		const paths: Array<string> = []
		for (const entry of entries) {
			if (!isArtifactPath(entry.path)) {
				return refused(`File path ${JSON.stringify(entry.path)} is not allowed.`)
			}
			if (entry.type === "file") {
				paths.push(entry.path)
			} else if (entry.type !== "dir") {
				return refused(`Output ${JSON.stringify(entry.path)} must be a regular file or directory.`)
			}
		}
		if (paths.length > MAX_OUTPUT_FILES) {
			return refused(`${paths.length} files; the limit is ${MAX_OUTPUT_FILES}.`)
		}

		const listed: Array<OutputFile> = []
		let remaining = MAX_OUTPUT_TOTAL_BYTES
		for (const path of paths) {
			const limit = Math.min(MAX_OUTPUT_FILE_BYTES, remaining)
			const bytes = await files.read(path, limit + 1).catch((error: unknown) => {
				if (changedDuringCapture(error)) {
					return null
				}
				throw error
			})
			if (bytes === null) {
				return refused(`Output ${JSON.stringify(path)} changed during capture.`)
			}
			if (bytes.byteLength > limit) {
				return refused(
					remaining < MAX_OUTPUT_FILE_BYTES
						? `Files total more than ${MAX_OUTPUT_TOTAL_BYTES} bytes.`
						: `File "${path}" exceeds the limit of ${MAX_OUTPUT_FILE_BYTES} bytes.`,
				)
			}
			remaining -= bytes.byteLength
			listed.push({ path, sha256: await sha256Hex(bytes), size: bytes.byteLength })
		}
		return { ok: true, files: listed }
	},

	read: async (wanted: ReadonlyArray<OutputRead>): Promise<ReadonlyArray<OutputBytes>> => {
		const outside = wanted.find(({ path }) => !isArtifactPath(path))
		if (outside !== undefined) {
			throw new Error(`${JSON.stringify(outside.path)} is not a path in the outputs directory.`)
		}
		if (
			wanted.length > MAX_OUTPUT_FILES ||
			wanted.some(
				({ size }) => !Number.isSafeInteger(size) || size < 0 || size > MAX_OUTPUT_FILE_BYTES,
			) ||
			wanted.reduce((total, { size }) => total + size, 0) > MAX_OUTPUT_TOTAL_BYTES
		) {
			throw new Error("Output read exceeds the capture limits.")
		}
		const read: Array<OutputBytes> = []
		for (const { path, size } of wanted) {
			const bytes = await files.read(path, size + 1).catch((error: unknown) => {
				if (changedDuringCapture(error)) {
					return null
				}
				throw error
			})
			if (bytes === null || bytes.byteLength !== size) {
				return read
			}
			read.push({ path, bytes })
		}
		return read
	},
})
