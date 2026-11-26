import {
	ArtifactFile,
	ArtifactPath,
	MAX_ARTIFACT_FILES,
	MAX_ARTIFACT_FILE_BYTES,
	MAX_ARTIFACT_TOTAL_BYTES,
	MAX_INLINE_FILE_BYTES,
	MAX_INLINE_TOTAL_BYTES,
} from "@checkfu/sdk/Schemas"
import type { ArtifactFileInput, ArtifactVersionFileInput } from "@checkfu/sdk/Schemas"
import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as Mime from "effect/http/Mime"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

export {
	ArtifactContentType,
	ArtifactFile,
	ArtifactFileInput,
	ArtifactFilesInput,
	ArtifactKeptFileInput,
	ArtifactPath,
	ArtifactVersionFileInput,
	ArtifactVersionFilesInput,
	MAX_ARTIFACT_BODY_BYTES,
	MAX_ARTIFACT_CONTENT_TYPE_LENGTH,
	MAX_ARTIFACT_FILES,
	MAX_ARTIFACT_FILE_BYTES,
	MAX_ARTIFACT_PATH_LENGTH,
	MAX_ARTIFACT_TOTAL_BYTES,
	MAX_INLINE_FILE_BYTES,
	MAX_INLINE_TOTAL_BYTES,
	Sha256Hex,
} from "@checkfu/sdk/Schemas"

export const DEFAULT_ARTIFACT_CONTENT_TYPE = "application/octet-stream"

export const ArtifactManifest = Schema.Struct({
	files: Schema.Array(ArtifactFile),
})
export type ArtifactManifest = typeof ArtifactManifest.Type

export const ArtifactManifestJson = Schema.fromJsonString(ArtifactManifest)

export class InvalidArtifactFiles extends Schema.TaggedError<
	InvalidArtifactFiles,
	{ readonly brand: unique symbol }
>()("InvalidArtifactFiles", { message: Schema.String }) {}

export interface ArtifactBlob {
	readonly sha256: string
	readonly bytes: Uint8Array
}

export interface SealedArtifactFiles {
	readonly manifest: ArtifactManifest
	readonly manifest_json: string
	readonly manifest_hash: string
	readonly file_count: number
	readonly total_bytes: number
}

export interface BuiltArtifactVersion extends SealedArtifactFiles {
	readonly blobs: ReadonlyArray<ArtifactBlob>
}

export interface ArtifactFileEntry {
	readonly path: string
	readonly sha256: string
	readonly size: number
	readonly content_type?: string | undefined
}

const utf8Encoder = new TextEncoder()

const isArtifactPath = Schema.is(ArtifactPath)

const decodeContent = (
	file: ArtifactFileInput,
): Effect.Effect<Uint8Array, InvalidArtifactFiles> => {
	if (file.encoding !== "base64") {
		return file.content.isWellFormed()
			? Effect.succeed(utf8Encoder.encode(file.content))
			: Effect.fail(
					new InvalidArtifactFiles({
						message: `File "${file.path}" content has an unpaired surrogate; send it as base64.`,
					}),
				)
	}
	const decoded = Base64.decode(file.content)
	return Result.isSuccess(decoded)
		? Effect.succeed(decoded.success)
		: Effect.fail(
				new InvalidArtifactFiles({ message: `File "${file.path}" content is not valid base64.` }),
			)
}

const fileUnderAnother = (paths: ReadonlySet<string>): string | undefined => {
	for (const path of paths) {
		let slash = path.indexOf("/")
		while (slash !== -1) {
			const parent = path.slice(0, slash)
			if (paths.has(parent)) {
				return `File path "${parent}" is also a folder of "${path}"; a path cannot be both.`
			}
			slash = path.indexOf("/", slash + 1)
		}
	}
	return undefined
}

const overBudget = (path: string, size: number, totalBytes: number) =>
	size > MAX_ARTIFACT_FILE_BYTES
		? new InvalidArtifactFiles({
				message: `File "${path}" is ${size} bytes; the limit is ${MAX_ARTIFACT_FILE_BYTES}.`,
			})
		: totalBytes > MAX_ARTIFACT_TOTAL_BYTES
			? new InvalidArtifactFiles({
					message: `Files total more than ${MAX_ARTIFACT_TOTAL_BYTES} bytes.`,
				})
			: undefined

export const sealArtifactFiles = (
	digest: Digest.Digest["Service"],
	files: ReadonlyArray<ArtifactFileEntry>,
): Effect.Effect<SealedArtifactFiles, InvalidArtifactFiles> =>
	Effect.gen(function* () {
		if (files.length > MAX_ARTIFACT_FILES) {
			return yield* new InvalidArtifactFiles({
				message: `${files.length} files; the limit is ${MAX_ARTIFACT_FILES}.`,
			})
		}
		const seen = new Set<string>()
		const entries: Array<ArtifactFile> = []
		let totalBytes = 0
		for (const file of files) {
			if (!isArtifactPath(file.path)) {
				return yield* new InvalidArtifactFiles({
					message: `File path ${JSON.stringify(file.path)} is not allowed.`,
				})
			}
			if (seen.has(file.path)) {
				return yield* new InvalidArtifactFiles({
					message: `File path "${file.path}" appears more than once.`,
				})
			}
			seen.add(file.path)
			totalBytes += file.size
			const over = overBudget(file.path, file.size, totalBytes)
			if (over !== undefined) {
				return yield* over
			}
			entries.push({
				path: file.path,
				sha256: file.sha256,
				size: file.size,
				content_type:
					file.content_type ??
					Option.getOrElse(Mime.getType(`./${file.path}`), () => DEFAULT_ARTIFACT_CONTENT_TYPE),
			})
		}
		const conflict = fileUnderAnother(seen)
		if (conflict !== undefined) {
			return yield* new InvalidArtifactFiles({ message: conflict })
		}
		entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		const manifest: ArtifactManifest = { files: entries }
		const manifest_json = JSON.stringify(manifest)
		const manifest_hash = yield* digest.digestHex(Digest.sha256, utf8Encoder.encode(manifest_json))
		return {
			manifest,
			manifest_json,
			manifest_hash,
			file_count: entries.length,
			total_bytes: totalBytes,
		}
	})

export const buildArtifactVersion = (
	digest: Digest.Digest["Service"],
	files: ReadonlyArray<ArtifactVersionFileInput>,
	kept: ReadonlyMap<string, number> = new Map(),
): Effect.Effect<BuiltArtifactVersion, InvalidArtifactFiles> =>
	Effect.gen(function* () {
		const entries: Array<ArtifactFileEntry> = []
		const blobs = new Map<string, ArtifactBlob>()
		let totalBytes = 0
		let inlineBytes = 0
		for (const file of files) {
			if ("sha256" in file) {
				const size = kept.get(file.sha256)
				if (size === undefined) {
					return yield* new InvalidArtifactFiles({
						message: `File "${file.path}" names sha256 ${file.sha256}, which this artifact does not hold; upload those bytes first, or send the file's content.`,
					})
				}
				totalBytes += size
				const over = overBudget(file.path, size, totalBytes)
				if (over !== undefined) {
					return yield* over
				}
				entries.push({
					path: file.path,
					sha256: file.sha256,
					size,
					content_type: file.content_type,
				})
				continue
			}
			const bytes = yield* decodeContent(file)
			if (bytes.byteLength > MAX_INLINE_FILE_BYTES) {
				return yield* new InvalidArtifactFiles({
					message: `File "${file.path}" is ${bytes.byteLength} bytes, over the ${MAX_INLINE_FILE_BYTES} a file sent inline may hold; upload it to the artifact and name it by sha256.`,
				})
			}
			inlineBytes += bytes.byteLength
			if (inlineBytes > MAX_INLINE_TOTAL_BYTES) {
				return yield* new InvalidArtifactFiles({
					message: `Files sent inline total more than ${MAX_INLINE_TOTAL_BYTES} bytes; upload the larger ones to the artifact and name them by sha256.`,
				})
			}
			totalBytes += bytes.byteLength
			const over = overBudget(file.path, bytes.byteLength, totalBytes)
			if (over !== undefined) {
				return yield* over
			}
			const sha256 = yield* digest.digestHex(Digest.sha256, bytes)
			entries.push({
				path: file.path,
				sha256,
				size: bytes.byteLength,
				content_type: file.content_type,
			})
			if (!blobs.has(sha256)) {
				blobs.set(sha256, { sha256, bytes })
			}
		}
		return { ...(yield* sealArtifactFiles(digest, entries)), blobs: [...blobs.values()] }
	})
