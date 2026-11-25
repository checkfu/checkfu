import {
	ArtifactFile,
	MAX_ARTIFACT_FILE_BYTES,
	MAX_ARTIFACT_TOTAL_BYTES,
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

export interface BuiltArtifactVersion {
	readonly manifest: ArtifactManifest
	readonly manifest_json: string
	readonly manifest_hash: string
	readonly blobs: ReadonlyArray<ArtifactBlob>
	readonly file_count: number
	readonly total_bytes: number
}

const utf8Encoder = new TextEncoder()

const contentTypeOf = (file: ArtifactVersionFileInput): string =>
	file.content_type ??
	Option.getOrElse(Mime.getType(`./${file.path}`), () => DEFAULT_ARTIFACT_CONTENT_TYPE)

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

export const buildArtifactVersion = (
	digest: Digest.Digest["Service"],
	files: ReadonlyArray<ArtifactVersionFileInput>,
	kept: ReadonlyMap<string, number> = new Map(),
): Effect.Effect<BuiltArtifactVersion, InvalidArtifactFiles> =>
	Effect.gen(function* () {
		const seen = new Set<string>()
		const entries: Array<ArtifactFile> = []
		const blobs = new Map<string, ArtifactBlob>()
		let totalBytes = 0
		for (const file of files) {
			if (seen.has(file.path)) {
				return yield* new InvalidArtifactFiles({
					message: `File path "${file.path}" appears more than once.`,
				})
			}
			seen.add(file.path)
			if ("sha256" in file) {
				const size = kept.get(file.sha256)
				if (size === undefined) {
					return yield* new InvalidArtifactFiles({
						message:
							kept.size === 0
								? `File "${file.path}" keeps a stored file by sha256, but there is no earlier version to keep it from; send its content.`
								: `File "${file.path}" keeps sha256 ${file.sha256}, which the version being replaced does not hold; send its content.`,
					})
				}
				totalBytes += size
				if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
					return yield* new InvalidArtifactFiles({
						message: `Files total more than ${MAX_ARTIFACT_TOTAL_BYTES} bytes.`,
					})
				}
				entries.push({
					path: file.path,
					sha256: file.sha256,
					size,
					content_type: contentTypeOf(file),
				})
				continue
			}
			const bytes = yield* decodeContent(file)
			if (bytes.byteLength > MAX_ARTIFACT_FILE_BYTES) {
				return yield* new InvalidArtifactFiles({
					message: `File "${file.path}" is ${bytes.byteLength} bytes; the limit is ${MAX_ARTIFACT_FILE_BYTES}.`,
				})
			}
			totalBytes += bytes.byteLength
			if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
				return yield* new InvalidArtifactFiles({
					message: `Files total more than ${MAX_ARTIFACT_TOTAL_BYTES} bytes.`,
				})
			}
			const sha256 = yield* digest.digestHex(Digest.sha256, bytes)
			const content_type = contentTypeOf(file)
			entries.push({ path: file.path, sha256, size: bytes.byteLength, content_type })
			if (!blobs.has(sha256)) {
				blobs.set(sha256, { sha256, bytes })
			}
		}
		const conflict = fileUnderAnother(seen)
		if (conflict !== undefined) {
			return yield* new InvalidArtifactFiles({ message: conflict })
		}
		entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		const manifest: ArtifactManifest = {
			files: entries.map((entry) => ({
				path: entry.path,
				sha256: entry.sha256,
				size: entry.size,
				content_type: entry.content_type,
			})),
		}
		const manifest_json = JSON.stringify(manifest)
		const manifest_hash = yield* digest.digestHex(Digest.sha256, utf8Encoder.encode(manifest_json))
		return {
			manifest,
			manifest_json,
			manifest_hash,
			blobs: [...blobs.values()],
			file_count: entries.length,
			total_bytes: totalBytes,
		}
	})
