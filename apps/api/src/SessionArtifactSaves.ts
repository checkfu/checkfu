import { AddArtifactVersion } from "@checkfu/domain/Artifact/AddArtifactVersion.command"
import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import { encodeMadeFrom } from "@checkfu/domain/Artifact/ArtifactMadeFrom"
import { CreateArtifact } from "@checkfu/domain/Artifact/CreateArtifact.command"
import { ReserveArtifact } from "@checkfu/domain/Artifact/ReserveArtifact.command"
import { File } from "@checkfu/domain/File/File.aggregate"
import { FileId } from "@checkfu/domain/File/File.id"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import { ARTIFACT_MOUNT_ROOT, artifactsOf } from "@checkfu/domain/Session/SessionResource"
import { SessionId } from "@checkfu/domain/Session/Session.id"
import { isClientEventId } from "@checkfu/sdk/IdempotencyKey"
import { MAX_ARTIFACT_DOCUMENT_BYTES } from "@checkfu/sdk/Limits"
import { isApiErrorEnvelope } from "@checkfu/sdk/Errors"
import {
	ArtifactDocumentData,
	ArtifactDocumentDeleted,
	ArtifactDocumentResource,
	MAX_ARTIFACT_DOCUMENT_DEPTH,
} from "@checkfu/sdk/Api"
import {
	ArtifactCollectionName,
	ArtifactDocumentId,
	ArtifactName,
	ArtifactPath,
	FileName,
} from "@checkfu/sdk/Schemas"
import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Mime from "effect/http/Mime"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { DocumentCalls, DocumentRefused, isDocumentRefused } from "./ArtifactData/DocumentCalls.ts"
import { outputFileId } from "./Files/OutputsSaverLive.ts"
import { SessionResources } from "./SessionResources.ts"
import { makeStoreFile } from "./Files/StoreFile.ts"
import { RESERVATION_LOST, artifactWrites, startedFrom } from "./Http/ArtifactsHandlers.ts"
import {
	DEFAULT_ARTIFACT_DATA_LIMIT,
	MAX_TOOL_ARTIFACT_FILE_BYTES,
	MAX_TOOL_ARTIFACT_FILES,
	MAX_TOOL_ARTIFACT_TOTAL_BYTES,
	SessionArtifactToolCalls,
} from "./Workspace/SessionArtifactTool.ts"
import type {
	SavedSessionArtifact,
	SavedSessionFile,
	SessionDataRequest,
	SessionDataResult,
} from "./Workspace/SessionArtifactTool.ts"

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

const told = (value: unknown, id: string | null = null, next_page: string | null = null) => ({
	ok: true as const,
	text: JSON.stringify(value),
	id,
	next_page,
})

const DATA_HELP = `data must be a JSON value with arrays and objects nested at most ${MAX_ARTIFACT_DOCUMENT_DEPTH} deep.`

const isCollection = Schema.is(ArtifactCollectionName)
const isDocumentId = Schema.is(ArtifactDocumentId)
const isDataCall = Schema.is(SessionArtifactToolCalls.sessionArtifactData.args)
const decodeData = Schema.decodeUnknownOption(Schema.fromJsonString(ArtifactDocumentData))
const encodeDocument = Schema.encodeSync(ArtifactDocumentResource)
const encodeDeleted = Schema.encodeSync(ArtifactDocumentDeleted)
const encodeList = Schema.encodeSync(
	Schema.Struct({
		data: Schema.Array(ArtifactDocumentResource),
		next_page: Schema.NullOr(Schema.String),
	}),
)

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
	const { build, fromFiles, copyIn, stage, capabilitiesOf, loadManifest } = yield* artifactWrites
	const resourcesOf = yield* SessionResources

	const stopped = (sessionId: string, turn: number) =>
		Effect.map(sessions.get(SessionId.make(sessionId)), (state) => {
			if (state._tag === "Uninitialized" || state._tag === "Terminated") {
				return refused("The session has ended.")
			}
			if (state._tag !== "Running" || state.turn !== turn || state.interrupted) {
				return refused("The turn is no longer running.")
			}
		})

	const documents = yield* DocumentCalls

	const dataOf = (
		id: ArtifactId,
		request: SessionDataRequest,
		beforeMutation: Effect.Effect<void, DocumentRefused>,
	) =>
		Effect.gen(function* () {
			const { operation, collection } = request
			if (!isCollection(collection)) {
				return refused(
					"collection must be a lowercase name of up to 32 letters, digits, - and _, starting with a letter.",
				)
			}
			if (operation === "list") {
				const after = request.page === "" ? 0 : Number(request.page)
				if (
					!Number.isSafeInteger(after) ||
					after < 0 ||
					(request.page !== "" && String(after) !== request.page)
				) {
					return refused("page must be the next_page of an earlier list.")
				}
				const result = yield* documents.list(
					id,
					collection,
					after,
					request.limit === 0 ? DEFAULT_ARTIFACT_DATA_LIMIT : request.limit,
				)
				return told(encodeList(result), null, result.next_page)
			}
			if (
				(operation === "add" || operation === "put") &&
				utf8Encoder.encode(request.data).byteLength > MAX_ARTIFACT_DOCUMENT_BYTES
			) {
				return refused(`A document may be at most ${MAX_ARTIFACT_DOCUMENT_BYTES} bytes of JSON.`)
			}
			if (operation === "add") {
				if (!isClientEventId(request.key)) {
					return refused(
						"add needs an idempotency key of 1 to 128 characters without surrounding whitespace.",
					)
				}
				const data = decodeData(request.data)
				if (Option.isNone(data)) {
					return refused(DATA_HELP)
				}
				const document = yield* documents.add(
					id,
					collection,
					data.value,
					request.key,
					"owner",
					beforeMutation,
				)
				return told(encodeDocument(document), document.id)
			}
			if (!isDocumentId(request.id)) {
				return refused(
					"id must be up to 64 letters, digits, - and _, starting with a letter or digit.",
				)
			}
			if (operation === "get") {
				const document = yield* documents.get(id, collection, request.id)
				return told(encodeDocument(document), document.id)
			}
			if (operation === "delete") {
				return told(
					encodeDeleted(yield* documents.remove(id, collection, request.id, beforeMutation)),
					request.id,
				)
			}
			const data = decodeData(request.data)
			if (Option.isNone(data)) {
				return refused(DATA_HELP)
			}
			const document = yield* documents.put(id, collection, request.id, data.value, beforeMutation)
			return told(encodeDocument(document), document.id)
		}).pipe(
			Effect.catchIf(isDocumentRefused, ({ message, status }) =>
				Effect.succeed(
					refused(
						request.operation === "add" && status === 503
							? `The add could have succeeded. Repeat it with key ${JSON.stringify(request.key)} to avoid another document.`
							: message,
					),
				),
			),
		)

	return {
		sessionArtifactData: (
			...args: typeof SessionArtifactToolCalls.sessionArtifactData.args.Type
		): Effect.Effect<SessionDataResult> =>
			explained(
				"Reaching the artifact's data",
				args[0],
				Effect.gen(function* () {
					const [sessionId, turn, name, request] = args
					if (!isDataCall(args) || !isSessionId(sessionId)) {
						return refused("Invalid session artifact data call.")
					}
					if (!isArtifactName(name)) {
						return refused("The artifact needs a name of 1 to 256 characters.")
					}
					const ended = yield* stopped(sessionId, turn)
					if (ended !== undefined) {
						return ended
					}
					const id = yield* sessionArtifactId(digest, sessionId, name)
					if ((yield* artifacts.get(id)).status !== "active") {
						return refused(
							`No artifact named ${JSON.stringify(name)} has been saved in this session. Save it with save_artifact first.`,
						)
					}
					const beforeMutation = stopped(sessionId, turn).pipe(
						Effect.flatMap((state) =>
							state === undefined
								? Effect.void
								: Effect.fail(new DocumentRefused({ status: 409, message: state.message })),
						),
					)
					return yield* dataOf(id, request, beforeMutation)
				}),
			),

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
					const [sessionId, turn, name, entries, madeFrom] = args
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
					const own = yield* fromFiles(wanted)
					const source =
						madeFrom === ""
							? undefined
							: artifactsOf(yield* resourcesOf(sessionId)).find(
									(mount) => mount.mount_path === madeFrom,
								)
					if (madeFrom !== "" && source === undefined) {
						return refused(
							`${madeFrom} is not an artifact attached to this session. made_from takes the mount path of one, such as ${ARTIFACT_MOUNT_ROOT}/document.`,
						)
					}
					const from = source === undefined ? undefined : ArtifactId.make(source.artifact_id)
					const resolved =
						source === undefined || from === undefined
							? own
							: yield* startedFrom(from, yield* loadManifest(from, source.manifest), own)
					const made_from =
						source === undefined || from === undefined
							? ""
							: encodeMadeFrom({ artifact_id: from, version: source.version })
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
									made_from,
									request: "",
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
								made_from,
								request: "",
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
