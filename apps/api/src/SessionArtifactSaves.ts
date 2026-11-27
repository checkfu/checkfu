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
import { ArtifactName, ArtifactPath, FileName } from "@checkfu/sdk/Schemas"
import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Mime from "effect/http/Mime"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { outputFileId } from "./Files/OutputsSaverLive.ts"
import { makeStoreFile } from "./Files/StoreFile.ts"
import { RESERVATION_LOST, artifactWrites } from "./Http/ArtifactsHandlers.ts"
import {
	MAX_TOOL_ARTIFACT_FILE_BYTES,
	MAX_TOOL_ARTIFACT_FILES,
	MAX_TOOL_ARTIFACT_TOTAL_BYTES,
	SessionArtifactToolCalls,
} from "./Workspace/SessionArtifactTool.ts"
import type { SavedSessionArtifact, SavedSessionFile } from "./Workspace/SessionArtifactTool.ts"

const DEFAULT_CONTENT_TYPE = "application/octet-stream"
const RETRY = "retry" as const
const MAX_ATTEMPTS = 4
const FILE_COPIES = [0, 1, 2, 3] as const
const RETRY_PAUSE = "20 millis"

const retry = () => Effect.succeed(RETRY)

const utf8Encoder = new TextEncoder()
const isArtifactPath = Schema.is(ArtifactPath)
const isArtifactName = Schema.is(ArtifactName)
const isFileName = Schema.is(FileName)
const isSessionId = Schema.is(SessionId)
const isFileId = Schema.is(FileId)
const isFileSave = Schema.is(SessionArtifactToolCalls.sessionFileSave.args)
const isArtifactSave = Schema.is(SessionArtifactToolCalls.sessionArtifactSave.args)

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

const explained = <A, E, R>(what: string, sessionId: string, effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.catch((error) =>
			isApiErrorEnvelope(error)
				? Effect.succeed(refused(error.error.message))
				: Effect.andThen(
						Effect.logError(`${what} failed`, error),
						Effect.succeed(refused(`${what} failed; try again.`)),
					),
		),
		Effect.annotateLogs({
			request_id: typeof sessionId === "string" ? `session-tool:${sessionId}` : "session-tool",
		}),
	)

export const SessionArtifactSaves = Effect.gen(function* () {
	const sessions = yield* Session
	const artifacts = yield* Artifact
	const files = yield* File
	const digest = yield* Digest.Digest
	const storeFile = yield* makeStoreFile
	const { build, fromFiles, copyIn, stage, capabilitiesOf } = yield* artifactWrites

	const stopped = (sessionId: string, turn: number) =>
		Effect.map(sessions.get(SessionId.make(sessionId)), (state) => {
			if (state._tag === "Uninitialized" || state._tag === "Terminated") {
				return refused("The session has ended.")
			}
			if (state._tag !== "Running" || state.turn !== turn || state.interrupted) {
				return refused("The turn is no longer running.")
			}
		})

	return {
		sessionFileSave: (
			...args: typeof SessionArtifactToolCalls.sessionFileSave.args.Type
		): Effect.Effect<SavedSessionFile> =>
			explained(
				"Saving the file",
				args[0],
				Effect.gen(function* () {
					const [sessionId, turn, path, bytes] = args
					if (!isFileSave(args) || !isSessionId(sessionId)) {
						return refused("Invalid session file save.")
					}
					if (bytes.byteLength > MAX_TOOL_ARTIFACT_FILE_BYTES) {
						return refused("The file exceeds the artifact file size limit.")
					}
					const filename = path.slice(path.lastIndexOf("/") + 1)
					if (!isArtifactPath(path) || !isFileName(filename)) {
						return refused(`${JSON.stringify(path)} is not a path an artifact can hold.`)
					}
					const sha256 = yield* digest.digestHex(Digest.sha256, bytes)
					const save = (hash: string) =>
						Effect.gen(function* () {
							const id = yield* outputFileId(digest, sessionId, path, hash)
							const ended = yield* stopped(sessionId, turn)
							if (ended !== undefined) {
								return ended
							}
							const confirmTurn = stopped(sessionId, turn).pipe(
								Effect.flatMap((ended) =>
									ended === undefined
										? Effect.void
										: Effect.fail({ _tag: "ArtifactSaveStopped" as const, ended }),
								),
							)
							const outcome = yield* storeFile(
								{
									id,
									filename,
									content_type: Option.getOrElse(
										Mime.getType(`./${path}`),
										() => DEFAULT_CONTENT_TYPE,
									),
									origin: { session_id: sessionId, turn, path },
									body: Stream.make(bytes),
									size: bytes.byteLength,
								},
								{ beforeCommit: confirmTurn, contentAddressed: true },
							).pipe(Effect.catchTag("ArtifactSaveStopped", ({ ended }) => Effect.succeed(ended)))
							if ("ok" in outcome) {
								return outcome
							}
							if (outcome._tag === "Taken") {
								return RETRY
							}
							return outcome._tag === "Stored"
								? { ok: true as const, file_id: id }
								: refused(`Saving ${path} took too long; try again.`)
						})
					for (const copy of FILE_COPIES) {
						const outcome = yield* save(copy === 0 ? sha256 : `${sha256}:turn:${turn}:${copy}`)
						if (outcome !== RETRY) {
							return outcome
						}
					}
					return refused(`${path} keeps being deleted after it is saved.`)
				}),
			),

		sessionArtifactSave: (
			...args: typeof SessionArtifactToolCalls.sessionArtifactSave.args.Type
		): Effect.Effect<SavedSessionArtifact> =>
			explained(
				"Saving the artifact",
				args[0],
				Effect.gen(function* () {
					const [sessionId, turn, name, entries] = args
					if (!isArtifactSave(args) || !isSessionId(sessionId)) {
						return refused("Invalid session artifact save.")
					}
					if (entries.length === 0 || entries.length > MAX_TOOL_ARTIFACT_FILES) {
						return refused(`An artifact holds 1 to ${MAX_TOOL_ARTIFACT_FILES} files.`)
					}
					if (!isArtifactName(name)) {
						return refused("The artifact needs a name of 1 to 256 characters.")
					}
					if (!entries.every((entry) => isArtifactPath(entry.path) && isFileId(entry.file_id))) {
						return refused("The artifact contains an invalid file entry.")
					}
					const ended = yield* stopped(sessionId, turn)
					if (ended !== undefined) {
						return ended
					}
					const wanted = entries.map((entry) => ({
						path: entry.path,
						file_id: FileId.make(entry.file_id),
					}))
					const owned = yield* Effect.forEach(
						wanted,
						({ path, file_id }) =>
							Effect.map(
								files.get(file_id),
								(file) => file.origin_session_id === sessionId && file.origin_path === path,
							),
						{ concurrency: 8 },
					)
					const foreign = wanted.find((_, index) => !owned[index])
					if (foreign !== undefined) {
						return refused(`${foreign.path} is not a file this session saved.`)
					}
					const id = yield* sessionArtifactId(digest, sessionId, name)
					const resolved = yield* fromFiles(wanted)
					const built = yield* build(resolved.files)
					if (
						built.total_bytes > MAX_TOOL_ARTIFACT_TOTAL_BYTES ||
						built.manifest.files.some((file) => file.size > MAX_TOOL_ARTIFACT_FILE_BYTES)
					) {
						return refused("The files exceed the artifact size limits.")
					}
					const capabilities = yield* capabilitiesOf(id, built, resolved.sources)
					const saved = (version: number, changed: boolean) => ({
						ok: true as const,
						artifact_id: id,
						version,
						changed,
					})
					const deleted = refused(`The artifact named ${JSON.stringify(name)} was deleted.`)

					const attempt = Effect.gen(function* () {
						const before = yield* stopped(sessionId, turn)
						if (before !== undefined) {
							return before
						}
						const state = yield* artifacts.get(id)
						if (state.status === "deleted") {
							return deleted
						}
						if (state.status === "active") {
							if (state.manifest === built.manifest_hash) {
								return saved(state.version, false)
							}
							yield* copyIn(id, resolved, null)
							yield* stage(id, built, null)
							const ended = yield* stopped(sessionId, turn)
							if (ended !== undefined) {
								return ended
							}
							const added = yield* artifacts.send(
								new AddArtifactVersion({
									artifact_id: id,
									expected_version: state.version,
									manifest: built.manifest_hash,
									file_count: built.file_count,
									total_bytes: built.total_bytes,
									capabilities,
								}),
							)
							return saved(added.reply.version, true)
						}
						const reservation =
							state.open_reservation ||
							(yield* artifacts.send(new ReserveArtifact({ artifact_id: id }), {
								commandId: `reserve-session-artifact:${state.reservations}`,
							})).reply.reservation
						yield* stage(id, null, reservation)
						yield* copyIn(id, resolved, reservation)
						yield* stage(id, built, reservation)
						const ended = yield* stopped(sessionId, turn)
						if (ended !== undefined) {
							return ended
						}
						const created = yield* artifacts.send(
							new CreateArtifact({
								artifact_id: id,
								name,
								manifest: built.manifest_hash,
								file_count: built.file_count,
								total_bytes: built.total_bytes,
								capabilities,
								reservation,
							}),
						)
						return saved(created.reply.version, true)
					}).pipe(
						Effect.catchTags({
							ArtifactAlreadyExists: retry,
							ArtifactNotFound: retry,
							ArtifactReservationLapsed: retry,
							ArtifactVersionConflict: retry,
						}),
						Effect.catchIf(
							(error) => isApiErrorEnvelope(error) && error.error.message === RESERVATION_LOST,
							retry,
						),
					)
					for (let left = MAX_ATTEMPTS; left > 0; left -= 1) {
						const outcome = yield* attempt
						if (outcome !== RETRY) {
							return outcome
						}
						if (left > 1) {
							yield* Effect.sleep(RETRY_PAUSE)
						}
					}
					return refused("Saving the artifact did not finish. Try again.")
				}),
			),
	}
})
