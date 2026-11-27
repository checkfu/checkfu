import { AddArtifactVersion } from "@checkfu/domain/Artifact/AddArtifactVersion.command"
import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import { CreateArtifact } from "@checkfu/domain/Artifact/CreateArtifact.command"
import { ReserveArtifact } from "@checkfu/domain/Artifact/ReserveArtifact.command"
import { File } from "@checkfu/domain/File/File.aggregate"
import { FileId } from "@checkfu/domain/File/File.id"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import { SessionId } from "@checkfu/domain/Session/Session.id"
import { isApiErrorEnvelope } from "@checkfu/sdk/Errors"
import { ArtifactName, ArtifactPath, FileName, MAX_ARTIFACT_FILES } from "@checkfu/sdk/Schemas"
import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Mime from "effect/http/Mime"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { outputFileId } from "./Files/OutputsSaverLive.ts"
import { makeStoreFile } from "./Files/StoreFile.ts"
import { artifactWrites } from "./Http/ArtifactsHandlers.ts"
import { idempotentCommandId } from "./Http/HttpHelpers.ts"
import type {
	SavedSessionArtifact,
	SavedSessionFile,
	SessionArtifactEntry,
} from "./Workspace/SessionArtifactTool.ts"

const DEFAULT_CONTENT_TYPE = "application/octet-stream"

const utf8Encoder = new TextEncoder()
const isArtifactPath = Schema.is(ArtifactPath)
const isArtifactName = Schema.is(ArtifactName)
const isFileName = Schema.is(FileName)

const refused = (message: string) => ({ ok: false as const, message })

export const sessionArtifactId = (
	digest: Digest.Digest["Service"],
	sessionId: string,
	name: string,
): Effect.Effect<ArtifactId> =>
	Effect.map(
		digest.digestHex(
			Digest.sha256,
			utf8Encoder.encode(JSON.stringify(["session", "artifact", sessionId, name])),
		),
		(hash) => ArtifactId.make(`art_${hash.slice(0, 32)}`),
	)

const explained = <A, E, R>(what: string, effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.catch((error) =>
			isApiErrorEnvelope(error)
				? Effect.succeed(refused(error.error.message))
				: Effect.andThen(
						Effect.logError(`${what} failed`, error),
						Effect.succeed(refused(`${what} failed; try again.`)),
					),
		),
	)

export const SessionArtifactSaves = Effect.gen(function* () {
	const sessions = yield* Session
	const artifacts = yield* Artifact
	const files = yield* File
	const digest = yield* Digest.Digest
	const storeFile = yield* makeStoreFile
	const { build, fromFiles, copyIn, stage } = yield* artifactWrites

	const live = (sessionId: string) =>
		Effect.map(
			sessions.get(SessionId.make(sessionId)),
			(state) => state._tag !== "Uninitialized" && state._tag !== "Terminated",
		)

	return {
		sessionFileSave: (
			sessionId: string,
			turn: number,
			path: string,
			bytes: Uint8Array,
		): Effect.Effect<SavedSessionFile> =>
			explained(
				"Saving the file",
				Effect.gen(function* () {
					const filename = path.slice(path.lastIndexOf("/") + 1)
					if (!isArtifactPath(path) || !isFileName(filename)) {
						return refused(`${JSON.stringify(path)} is not a path an artifact can hold.`)
					}
					if (!(yield* live(sessionId))) {
						return refused("The session has ended.")
					}
					const sha256 = yield* digest.digestHex(Digest.sha256, bytes)
					const id = yield* outputFileId(digest, sessionId, path, sha256)
					const outcome = yield* storeFile({
						id,
						filename,
						content_type: Option.getOrElse(Mime.getType(`./${path}`), () => DEFAULT_CONTENT_TYPE),
						origin: { session_id: sessionId, turn, path },
						body: Stream.make(bytes),
						size: bytes.byteLength,
					})
					if (outcome._tag === "Stored") {
						return { ok: true as const, file_id: id }
					}
					return refused(
						outcome._tag === "Taken"
							? `${path} was saved before with this content and then deleted.`
							: `Saving ${path} took too long; try again.`,
					)
				}),
			),

		sessionArtifactSave: (
			sessionId: string,
			name: string,
			entries: ReadonlyArray<SessionArtifactEntry>,
		): Effect.Effect<SavedSessionArtifact> =>
			explained(
				"Saving the artifact",
				Effect.gen(function* () {
					if (!isArtifactName(name)) {
						return refused("The artifact needs a name of 1 to 256 characters.")
					}
					if (entries.length === 0 || entries.length > MAX_ARTIFACT_FILES) {
						return refused(`An artifact holds 1 to ${MAX_ARTIFACT_FILES} files.`)
					}
					if (!(yield* live(sessionId))) {
						return refused("The session has ended.")
					}
					const wanted = entries.map((entry) => ({
						path: entry.path,
						file_id: FileId.make(entry.file_id),
					}))
					const foreign = yield* Effect.findFirst(wanted, ({ file_id }) =>
						Effect.map(files.get(file_id), (file) => file.origin_session_id !== sessionId),
					)
					if (Option.isSome(foreign)) {
						return refused(`${foreign.value.path} is not a file this session saved.`)
					}
					const id = yield* sessionArtifactId(digest, sessionId, name)
					const resolved = yield* fromFiles(wanted)
					const built = yield* build(resolved.files)
					const state = yield* artifacts.get(id)
					if (state.status === "deleted") {
						return refused(`The artifact named ${JSON.stringify(name)} was deleted.`)
					}
					if (state.status === "active") {
						if (state.manifest === built.manifest_hash) {
							return {
								ok: true as const,
								artifact_id: id,
								version: state.version,
								changed: false,
							}
						}
						yield* copyIn(id, resolved, null)
						yield* stage(id, built, null)
						const added = yield* artifacts.send(
							new AddArtifactVersion({
								artifact_id: id,
								expected_version: state.version,
								manifest: built.manifest_hash,
								file_count: built.file_count,
								total_bytes: built.total_bytes,
							}),
							{
								commandId: yield* idempotentCommandId(digest, "add-artifact-version", [
									id,
									state.version,
									built.manifest_hash,
								]),
							},
						)
						return {
							ok: true as const,
							artifact_id: id,
							version: added.reply.version,
							changed: true,
						}
					}
					const reservation = yield* artifacts.send(new ReserveArtifact({ artifact_id: id })).pipe(
						Effect.map((reserved) => reserved.reply.reservation),
						Effect.catchTag("ArtifactAlreadyExists", () => Effect.succeed(0)),
					)
					if (reservation !== 0) {
						yield* stage(id, null, reservation)
						yield* copyIn(id, resolved, reservation)
						yield* stage(id, built, reservation)
					}
					const created = yield* artifacts.send(
						new CreateArtifact({
							artifact_id: id,
							name,
							manifest: built.manifest_hash,
							file_count: built.file_count,
							total_bytes: built.total_bytes,
							reservation,
						}),
						{ commandId: `create-artifact:${id}` },
					)
					return {
						ok: true as const,
						artifact_id: id,
						version: created.reply.version,
						changed: true,
					}
				}),
			),
	}
})
