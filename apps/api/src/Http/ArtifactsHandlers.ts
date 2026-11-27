import { AddArtifactVersion } from "@checkfu/domain/Artifact/AddArtifactVersion.command"
import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import type { ArtifactState } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import { ClaimArtifactIdempotencyKey } from "@checkfu/domain/Artifact/ClaimArtifactIdempotencyKey.command"
import {
	ArtifactVersionView,
	artifactVersionLookupKey,
} from "@checkfu/domain/Artifact/ArtifactVersionView.view"
import { CreateArtifact } from "@checkfu/domain/Artifact/CreateArtifact.command"
import { DeleteArtifact } from "@checkfu/domain/Artifact/DeleteArtifact.command"
import { File } from "@checkfu/domain/File/File.aggregate"
import type { FileId } from "@checkfu/domain/File/File.id"
import {
	ArtifactPublicationConflict,
	ArtifactVersionNotFound,
	KEEP_ACCESS,
	PublishArtifact,
} from "@checkfu/domain/Artifact/PublishArtifact.command"
import type { PublicationCondition } from "@checkfu/domain/Artifact/PublishArtifact.command"
import { ReserveArtifact } from "@checkfu/domain/Artifact/ReserveArtifact.command"
import { UnpublishArtifact } from "@checkfu/domain/Artifact/UnpublishArtifact.command"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import {
	ARTIFACT_DECLARATION_FILE,
	MAX_ARTIFACT_DECLARATION_BYTES,
	PublicationAddress,
} from "@checkfu/sdk/Schemas"
import { decodeGrant, encodeGrant, grantAt } from "@checkfu/domain/Artifact/ArtifactAccess"
import type {
	ArtifactAccessLevel,
	ArtifactDataGrant,
} from "@checkfu/domain/Artifact/ArtifactAccess"
import { decodeCapabilities } from "@checkfu/domain/Artifact/ArtifactCapabilities"
import { decodeMadeFrom, encodeMadeFrom } from "@checkfu/domain/Artifact/ArtifactMadeFrom"
import type { MadeFrom } from "@checkfu/domain/Artifact/ArtifactMadeFrom"
import * as Result from "effect/Result"
import {
	MAX_INLINE_FILE_BYTES,
	buildArtifactVersion,
	readDeclaration,
	SOURCE_ARTIFACT_DECLARATION_MESSAGE,
} from "../Artifacts/ArtifactFiles.ts"
import type {
	ArtifactManifest,
	ArtifactVersionEntry,
	ArtifactVersionFileInput,
	BuiltArtifactVersion,
} from "../Artifacts/ArtifactFiles.ts"
import { ArtifactStore, ArtifactStoreError } from "../Artifacts/ArtifactStore.ts"
import {
	DEFAULT_LINK_TTL_SECONDS,
	newPublicationToken,
	parsePublicationAddress,
	publicationAddress,
} from "../Content/ArtifactLink.ts"
import { ArtifactLinks } from "../Content/ArtifactLinks.ts"
import { FileStore } from "../Files/FileStore.ts"
import { CheckfuApi } from "./Api.ts"
import { makeLister } from "./Listing.ts"
import {
	reusedKey,
	canonicalJsonDigest,
	handled,
	idempotentCommandId,
	idempotentId,
	isPending,
	orPending,
	randomId,
	reject,
	sha256Json,
} from "./HttpHelpers.ts"

export const ArtifactReadWaitTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/ArtifactReadWaitTimeout",
	{ defaultValue: () => "5 seconds" },
)

export const keyedArtifactId = (digest: Digest.Digest["Service"], idempotencyKey: string) =>
	Effect.map(idempotentId(digest, "art", ["create", "artifact", "id", idempotencyKey]), (id) =>
		ArtifactId.make(id.slice(0, "art_".length + 32)),
	)

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

const encodeContent = (bytes: Uint8Array) => {
	try {
		return { encoding: "utf8" as const, content: strictUtf8.decode(bytes) }
	} catch {
		return { encoding: "base64" as const, content: Base64.encode(bytes) }
	}
}

export const stored = <A, E extends { readonly _tag: string }, R>(
	effect: Effect.Effect<A, E | ArtifactStoreError, R>,
) =>
	effect.pipe(
		Effect.catchTag("ArtifactStoreError", (error) =>
			Effect.andThen(
				Effect.logError("Artifact storage failed", error),
				reject(503, "Artifact storage is unavailable. Retry the request."),
			),
		),
	)

interface LocatedVersion {
	readonly version: number
	readonly manifest: string
	readonly capabilities: string
	readonly made_from: string
	readonly created_at: DateTime.Utc
}

const filesOf = (manifest: ArtifactManifest) => ({
	file_count: manifest.files.length,
	total_bytes: manifest.files.reduce((total, file) => total + file.size, 0),
	files: manifest.files,
})

interface Publication {
	readonly address: PublicationAddress
	readonly url: string
	readonly version: number | null
	readonly access: ArtifactAccessLevel
	readonly grants: ArtifactDataGrant
	readonly published_at: DateTime.Utc
}

const artifactResource = (
	id: ArtifactId,
	state: ArtifactState,
	manifest: ArtifactManifest,
	publication: Publication | null,
) => ({
	id,
	type: "artifact" as const,
	name: state.name,
	version: state.version,
	capabilities: decodeCapabilities(state.capabilities),
	made_from: decodeMadeFrom(state.made_from),
	...filesOf(manifest),
	publication,
	created_at: DateTime.makeUnsafe(state.created_at),
	updated_at: DateTime.makeUnsafe(state.updated_at),
})

const artifactSummary = (
	id: ArtifactId,
	state: ArtifactState,
	publication: Publication | null,
) => ({
	id,
	type: "artifact" as const,
	name: state.name,
	version: state.version,
	capabilities: decodeCapabilities(state.capabilities),
	made_from: decodeMadeFrom(state.made_from),
	file_count: state.file_count,
	total_bytes: state.total_bytes,
	publication,
	created_at: DateTime.makeUnsafe(state.created_at),
	updated_at: DateTime.makeUnsafe(state.updated_at),
})

const versionResource = (id: ArtifactId, found: LocatedVersion, manifest: ArtifactManifest) => ({
	type: "artifact_version" as const,
	artifact_id: id,
	version: found.version,
	capabilities: decodeCapabilities(found.capabilities),
	made_from: decodeMadeFrom(found.made_from),
	...filesOf(manifest),
	created_at: found.created_at,
})

export const RESERVATION_LOST = "The create took too long; retry the request."

const interrupted = reject(503, RESERVATION_LOST)

export const artifactReads = Effect.gen(function* () {
	const artifacts = yield* Artifact
	const store = yield* ArtifactStore
	const links = yield* ArtifactLinks

	const requireActive = (id: ArtifactId) =>
		artifacts.get(id).pipe(
			Effect.filterOrElse(
				(state) => state.status === "active",
				() => reject(404, `Artifact ${id} not found.`),
			),
		)

	const missingBytes = (id: ArtifactId, detail: Record<string, string>) =>
		Effect.gen(function* () {
			yield* requireActive(id)
			yield* Effect.logError("Artifact bytes are missing", { artifact_id: id, ...detail })
			return yield* reject(500, "Failed to load artifact files.")
		})

	const loadManifest = (id: ArtifactId, manifestHash: string) =>
		Effect.gen(function* () {
			const manifest = yield* stored(store.getManifest(id, manifestHash))
			return manifest ?? (yield* missingBytes(id, { manifest: manifestHash }))
		})

	const publicationOf = (id: ArtifactId, state: ArtifactState) =>
		Effect.gen(function* () {
			if (state.publication_token === "") {
				return null
			}
			const address = PublicationAddress.make(publicationAddress(id, state.publication_token))
			const publication: Publication = {
				address,
				url: yield* links.publicationUrl(address),
				version: state.pinned_version === 0 ? null : state.pinned_version,
				access: state.public_access === "" ? "view" : state.public_access,
				grants: decodeGrant(state.public_grant),
				published_at: DateTime.makeUnsafe(state.published_at),
			}
			return publication
		})

	const readArtifact = (id: ArtifactId, state: ArtifactState) =>
		Effect.gen(function* () {
			return artifactResource(
				id,
				state,
				yield* loadManifest(id, state.manifest),
				yield* publicationOf(id, state),
			)
		})

	const retrieve = (id: ArtifactId) =>
		Effect.flatMap(requireActive(id), (state) => readArtifact(id, state))

	return { requireActive, missingBytes, loadManifest, publicationOf, readArtifact, retrieve }
})

type FileSource =
	| { readonly file_id: FileId; readonly size: number }
	| { readonly artifact_id: ArtifactId; readonly size: number }

export interface ResolvedFiles {
	readonly files: ReadonlyArray<ArtifactVersionEntry>
	readonly sources: ReadonlyMap<string, FileSource>
	readonly unavailable: FileId | undefined
}

const unusableDeclaration = (why: string) =>
	reject(400, `${ARTIFACT_DECLARATION_FILE} cannot be used: ${why}.`)

const declaredBy = (bytes: Uint8Array) => {
	const read = readDeclaration(bytes)
	return Result.isFailure(read) ? unusableDeclaration(read.failure) : Effect.succeed(read.success)
}

export const startedFrom = (from: ArtifactId, manifest: ArtifactManifest, own: ResolvedFiles) =>
	Effect.gen(function* () {
		if (own.files.some((file) => file.path === ARTIFACT_DECLARATION_FILE)) {
			return yield* reject(400, SOURCE_ARTIFACT_DECLARATION_MESSAGE)
		}
		const taken = new Set(manifest.files.map((file) => file.path))
		const clash = own.files.find((file) => taken.has(file.path))
		if (clash !== undefined) {
			return yield* reject(
				400,
				`${clash.path} comes from artifact ${from} and cannot be replaced. Leave it out, or make the version without made_from.`,
			)
		}
		const sources = new Map(own.sources)
		for (const file of manifest.files) {
			if (!sources.has(file.sha256)) {
				sources.set(file.sha256, { artifact_id: from, size: file.size })
			}
		}
		const merged: ResolvedFiles = {
			files: [...manifest.files, ...own.files],
			sources,
			unavailable: own.unavailable,
		}
		return merged
	})

export const artifactWrites = Effect.gen(function* () {
	const store = yield* ArtifactStore
	const files = yield* File
	const fileStore = yield* FileStore
	const digest = yield* Digest.Digest
	const { loadManifest, missingBytes } = yield* artifactReads

	const build = (files: ReadonlyArray<ArtifactVersionEntry>, kept?: ReadonlyMap<string, number>) =>
		buildArtifactVersion(digest, files, kept).pipe(
			Effect.catchTag("InvalidArtifactFiles", (error) => reject(400, error.message)),
		)

	const fromFiles = (entries: ReadonlyArray<ArtifactVersionFileInput>) =>
		Effect.gen(function* () {
			const named = [
				...new Set(entries.flatMap((entry) => ("file_id" in entry ? [entry.file_id] : []))),
			]
			const states = new Map(
				yield* Effect.forEach(
					named,
					(file_id) => Effect.map(files.get(file_id), (state) => [file_id, state] as const),
					{ concurrency: 8 },
				),
			)
			const resolved: Array<ArtifactVersionEntry> = []
			const unavailable = named.find((file_id) => states.get(file_id)?.status === "deleted")
			const sources = new Map<string, FileSource>()
			for (const entry of entries) {
				if (!("file_id" in entry)) {
					resolved.push(entry)
					continue
				}
				const file = states.get(entry.file_id)
				if (file === undefined || file.status === "") {
					return yield* reject(404, `File ${entry.file_id} not found.`)
				}
				sources.set(file.sha256, {
					file_id: entry.file_id,
					size: file.size,
				})
				resolved.push({
					path: entry.path,
					sha256: file.sha256,
					size: file.size,
					content_type: entry.content_type ?? file.content_type,
				})
			}
			return { files: resolved, sources, unavailable }
		})

	const copyIn = (
		id: ArtifactId,
		{
			sources,
			unavailable,
		}: {
			readonly sources: ReadonlyMap<string, FileSource>
			readonly unavailable: FileId | undefined
		},
		reservation: number | null,
	) =>
		Effect.gen(function* () {
			if (unavailable !== undefined) {
				return yield* reject(404, `File ${unavailable} not found.`)
			}
			yield* Effect.forEach(
				sources,
				([sha256, source]) =>
					Effect.gen(function* () {
						if ((yield* stored(store.blobSize(id, sha256))) !== null) {
							return
						}
						const { size } = source
						const named =
							"file_id" in source ? `File ${source.file_id}` : `Artifact ${source.artifact_id}`
						const body =
							"file_id" in source
								? yield* fileStore.content(source.file_id).pipe(
										Effect.map((content) =>
											content === null
												? null
												: content.pipe(
														Stream.mapError((cause) => new ArtifactStoreError({ cause })),
													),
										),
										Effect.catchTag("FileStoreError", (error) =>
											Effect.andThen(
												Effect.logError("File storage failed", error),
												reject(503, "File storage is unavailable. Retry the request."),
											),
										),
									)
								: yield* stored(store.blobStream(source.artifact_id, sha256))
						if (body === null) {
							return "file_id" in source
								? yield* reject(404, `${named} not found.`)
								: yield* missingBytes(source.artifact_id, { sha256 })
						}
						const copied = yield* stored(store.putBlob(id, sha256, body, size, reservation)).pipe(
							Effect.catchTags({
								ArtifactPurged: () => reject(404, `Artifact ${id} not found.`),
								ArtifactReservationStale: () => interrupted,
							}),
						)
						if (copied === "mismatch") {
							yield* Effect.logError("A source's bytes do not match their sha256", {
								named,
								sha256,
							})
							return yield* reject(500, `${named} could not be read.`)
						}
					}),
				{ concurrency: 4, discard: true },
			)
		})

	const stage = (id: ArtifactId, built: BuiltArtifactVersion | null, reservation: number | null) =>
		stored(store.stage(id, built, reservation)).pipe(
			Effect.catchTags({
				ArtifactPurged: () => reject(404, `Artifact ${id} not found.`),
				ArtifactReservationStale: () => interrupted,
			}),
		)

	const keptIn = (
		id: ArtifactId,
		files: ReadonlyArray<ArtifactVersionFileInput>,
		manifestHash: string,
	) =>
		Effect.gen(function* () {
			const kept = new Map<string, number>()
			if (!files.some((file) => "sha256" in file)) {
				return kept
			}
			for (const file of (yield* loadManifest(id, manifestHash)).files) {
				kept.set(file.sha256, file.size)
			}
			return kept
		})

	const capabilitiesOf = (
		id: ArtifactId,
		built: BuiltArtifactVersion,
		sources: ReadonlyMap<string, FileSource>,
	) =>
		Effect.gen(function* () {
			const declared = built.manifest.files.find((file) => file.path === ARTIFACT_DECLARATION_FILE)
			if (declared === undefined) {
				return ""
			}
			if (declared.size > MAX_ARTIFACT_DECLARATION_BYTES) {
				return yield* unusableDeclaration(
					`it is larger than ${MAX_ARTIFACT_DECLARATION_BYTES} bytes`,
				)
			}
			const inline = built.blobs.find((blob) => blob.sha256 === declared.sha256)?.bytes
			if (inline !== undefined) {
				return yield* declaredBy(inline)
			}
			if (declared.size === 0) {
				return yield* declaredBy(new Uint8Array())
			}
			const held = yield* stored(store.getBlob(id, declared.sha256))
			if (held !== null) {
				return yield* declaredBy(held)
			}
			const source = sources.get(declared.sha256)
			if (source === undefined) {
				return yield* reject(404, `Artifact ${id} not found.`)
			}
			if ("artifact_id" in source) {
				const copied = yield* stored(store.getBlob(source.artifact_id, declared.sha256))
				return copied === null
					? yield* missingBytes(source.artifact_id, { sha256: declared.sha256 })
					: yield* declaredBy(copied)
			}
			const sent = yield* fileStore
				.read(source.file_id, { offset: 0, length: declared.size })
				.pipe(
					Effect.catchTag("FileStoreError", (error) =>
						Effect.andThen(
							Effect.logError("File storage failed", error),
							reject(503, "File storage is unavailable. Retry the request."),
						),
					),
				)
			return sent === null
				? yield* reject(404, `File ${source.file_id} not found.`)
				: yield* declaredBy(sent)
		})

	return { build, fromFiles, copyIn, stage, keptIn, capabilitiesOf, loadManifest }
})

export const ArtifactsLive = HttpApiBuilder.group(CheckfuApi, "artifacts", (handlers) =>
	Effect.gen(function* () {
		const artifacts = yield* Artifact
		const versionViews = yield* ArtifactVersionView
		const store = yield* ArtifactStore
		const links = yield* ArtifactLinks
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom
		const list = yield* makeLister
		const { requireActive, missingBytes, loadManifest, publicationOf, readArtifact, retrieve } =
			yield* artifactReads

		const { build, fromFiles, copyIn, stage, keptIn, capabilitiesOf } = yield* artifactWrites

		const manifestOf = (id: ArtifactId, hash: string, built?: BuiltArtifactVersion) =>
			built !== undefined && built.manifest_hash === hash
				? Effect.succeed(built.manifest)
				: loadManifest(id, hash)

		const sentWith = (
			id: ArtifactId,
			idempotencyKey: string | undefined,
			request:
				| {
						readonly operation: "publish"
						readonly pinned_version: number
						readonly access: string
						readonly if_current?: PublicationCondition
				  }
				| { readonly operation: "unpublish"; readonly if_current?: string },
		) =>
			Effect.gen(function* () {
				if (idempotencyKey === undefined) {
					return undefined
				}
				const fingerprint = yield* sha256Json(digest, request)
				const claim = yield* artifacts.send(
					new ClaimArtifactIdempotencyKey({ artifact_id: id, fingerprint }),
					{ commandId: yield* idempotentCommandId(digest, "publication", [id, idempotencyKey]) },
				)
				if (
					!claim.events.some(
						(event) =>
							event._tag === "artifact.idempotency_key_claimed" &&
							event.fingerprint === fingerprint,
					)
				) {
					return yield* reusedKey
				}
				const commandId = yield* idempotentCommandId(digest, `${request.operation}-artifact`, [
					request.operation,
					"artifact",
					id,
					idempotencyKey,
				])
				return { commandId }
			})

		const locateVersion = (id: ArtifactId, state: ArtifactState, version: number) =>
			Effect.gen(function* () {
				if (version > state.version) {
					return yield* reject(404, `Artifact ${id} has no version ${version}.`)
				}
				if (version === state.version) {
					const head: LocatedVersion = {
						version,
						manifest: state.manifest,
						capabilities: state.capabilities,
						made_from: state.made_from,
						created_at: DateTime.makeUnsafe(state.updated_at),
					}
					return head
				}
				const key = artifactVersionLookupKey(id, version)
				const found =
					Option.getOrNull(yield* versionViews.get(key)) ??
					(yield* versionViews
						.waitFor(key, { version: { gte: 1 } }, { timeout: yield* ArtifactReadWaitTimeout })
						.pipe(Effect.tapErrorTag("WaitTimeout", () => requireActive(id))))
				if (found === null) {
					return yield* reject(503, `Artifact ${id} version ${version} projection is not ready.`)
				}
				return found
			})

		const startingFrom = (source: MadeFrom | undefined, own: ResolvedFiles) =>
			Effect.gen(function* () {
				if (source === undefined) {
					return own.files.length === 0
						? yield* reject(
								400,
								"A version needs files, or made_from naming a version to start from.",
							)
						: { ...own, made_from: "" }
				}
				const from = source.artifact_id
				const found = yield* locateVersion(from, yield* requireActive(from), source.version)
				return {
					...(yield* startedFrom(from, yield* loadManifest(from, found.manifest), own)),
					made_from: encodeMadeFrom(source),
				}
			})

		const loadVersion = (id: ArtifactId, version: number, built?: BuiltArtifactVersion) =>
			Effect.gen(function* () {
				const found = yield* locateVersion(id, yield* requireActive(id), version)
				return { found, manifest: yield* manifestOf(id, found.manifest, built) }
			})

		const writeRequest = (payload: {
			readonly files?: ReadonlyArray<ArtifactVersionFileInput>
			readonly made_from?: MadeFrom
			readonly name?: string
		}) =>
			canonicalJsonDigest(digest, {
				name: payload.name,
				made_from: payload.made_from,
				files: (payload.files ?? []).toSorted((a, b) =>
					a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
				),
			})

		const createdArtifact = (id: ArtifactId, state: ArtifactState, built?: BuiltArtifactVersion) =>
			Effect.gen(function* () {
				if (state.status === "deleted") {
					return yield* reject(404, `Artifact ${id} was deleted after creation committed.`)
				}
				const found = yield* locateVersion(id, state, 1)
				const manifest = yield* manifestOf(id, found.manifest, built)
				return artifactResource(
					id,
					{
						...state,
						version: 1,
						capabilities: found.capabilities,
						made_from: found.made_from,
						updated_at: state.created_at,
					},
					manifest,
					null,
				)
			})

		return handlers
			.handle("create", ({ payload, headers }) =>
				Effect.gen(function* () {
					const idempotencyKey = headers["idempotency-key"]
					const id =
						idempotencyKey === undefined
							? ArtifactId.make(yield* randomId(random, "art"))
							: yield* keyedArtifactId(digest, idempotencyKey)
					const request = idempotencyKey === undefined ? "" : yield* writeRequest(payload)
					const existing = yield* artifacts.get(id)
					if (idempotencyKey !== undefined && existing.status !== "") {
						if (existing.creation_request !== request) {
							return yield* reusedKey
						}
						return yield* createdArtifact(id, existing).pipe(orPending(id, "artifact"))
					}
					const resolved = yield* startingFrom(
						payload.made_from,
						yield* fromFiles(payload.files ?? []),
					)
					const built = yield* build(resolved.files)
					const capabilities = yield* capabilitiesOf(id, built, resolved.sources)
					let reservation = 0
					if (existing.status === "") {
						reservation = yield* artifacts.send(new ReserveArtifact({ artifact_id: id })).pipe(
							Effect.map((reserved) => reserved.reply.reservation),
							Effect.catchTag("ArtifactAlreadyExists", () => Effect.succeed(0)),
						)
						if (reservation !== 0) {
							yield* stage(id, null, reservation)
							yield* copyIn(id, resolved, reservation)
							yield* stage(id, built, reservation)
						}
					}
					yield* artifacts
						.send(
							new CreateArtifact({
								artifact_id: id,
								name: payload.name,
								manifest: built.manifest_hash,
								file_count: built.file_count,
								total_bytes: built.total_bytes,
								capabilities,
								made_from: resolved.made_from,
								request,
								reservation,
							}),
							{ commandId: `create-artifact:${id}:${request}` },
						)
						.pipe(
							Effect.catchTags({
								ArtifactReservationLapsed: () => interrupted,
								ArtifactAlreadyExists: () =>
									Effect.flatMap(artifacts.get(id), (current) =>
										idempotencyKey !== undefined && current.creation_request === request
											? Effect.void
											: reusedKey,
									),
							}),
						)
					return yield* Effect.flatMap(artifacts.get(id), (state) =>
						createdArtifact(id, state, built),
					).pipe(orPending(id, "artifact"))
				}).pipe(handled),
			)
			.handle("list", ({ query }) =>
				list("artifact", query, (id) =>
					Effect.gen(function* () {
						const artifactId = ArtifactId.make(id)
						const state = yield* requireActive(artifactId)
						return artifactSummary(artifactId, state, yield* publicationOf(artifactId, state))
					}),
				).pipe(handled),
			)
			.handle("get", ({ params }) => retrieve(params.artifact_id).pipe(handled))
			.handle("publish", ({ params, payload, headers }) =>
				Effect.gen(function* () {
					const id = params.artifact_id
					const pinned_version =
						payload.version === undefined || payload.version === "latest" ? 0 : payload.version
					const access = payload.access ?? KEEP_ACCESS
					const expected = payload.if_current
					let condition: PublicationCondition | undefined
					if (expected !== undefined) {
						const publication = expected.publication
						if (publication === null) {
							condition = {
								head_version: expected.version,
								pinned_version: 0,
								token: "",
								access: KEEP_ACCESS,
								grant: "",
							}
						} else {
							const address = parsePublicationAddress(publication.address)
							const grant = encodeGrant(publication.grants)
							if (address?.artifactId !== id || grant === undefined) {
								return yield* new ArtifactPublicationConflict({ artifact_id: id })
							}
							condition = {
								head_version: expected.version,
								token: address.token,
								pinned_version: publication.version ?? 0,
								access: publication.access,
								grant,
							}
						}
					}
					const precondition = condition === undefined ? {} : { if_current: condition }
					const sendOptions = yield* sentWith(id, headers["idempotency-key"], {
						operation: "publish",
						pinned_version,
						access,
						...precondition,
					})
					const state = yield* requireActive(id)
					const served = pinned_version === 0 ? state.version : pinned_version
					if (served > state.version) {
						return yield* new ArtifactVersionNotFound({ artifact_id: id, version: served })
					}
					const grant =
						access === "read" || access === "write"
							? (encodeGrant(
									grantAt(
										access,
										decodeCapabilities((yield* locateVersion(id, state, served)).capabilities),
									),
								) ?? "")
							: ""
					yield* artifacts.send(
						new PublishArtifact({
							artifact_id: id,
							token: yield* newPublicationToken(random),
							pinned_version,
							access,
							grant,
							...precondition,
						}),
						sendOptions,
					)
					return yield* readArtifact(id, yield* requireActive(id))
				}).pipe(handled),
			)
			.handle("unpublish", ({ params, query, headers }) =>
				Effect.gen(function* () {
					const id = params.artifact_id
					const expected = query.if_current
					const address = expected === undefined ? undefined : parsePublicationAddress(expected)
					if (expected !== undefined && address?.artifactId !== id) {
						return yield* new ArtifactPublicationConflict({ artifact_id: id })
					}
					const condition = address ? { if_current: address.token } : {}
					const sendOptions = yield* sentWith(id, headers["idempotency-key"], {
						operation: "unpublish",
						...condition,
					})
					yield* artifacts.send(
						new UnpublishArtifact({ artifact_id: id, ...condition }),
						sendOptions,
					)
					return yield* readArtifact(id, yield* requireActive(id))
				}).pipe(handled),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const id = params.artifact_id
					const state = yield* artifacts.get(id)
					if (state.status === "") {
						return yield* reject(404, `Artifact ${id} not found.`)
					}
					if (state.status !== "deleted") {
						yield* artifacts
							.send(new DeleteArtifact({ artifact_id: id }))
							.pipe(
								Effect.catchTag("ArtifactNotFound", (refused) =>
									Effect.flatMap(artifacts.get(id), (now) =>
										now.status === "deleted" ? Effect.void : Effect.fail(refused),
									),
								),
							)
					}
					yield* stored(store.purge(id))
					return { id, type: "artifact_deleted" as const }
				}).pipe(handled),
			)
			.handle("createVersion", ({ params, payload }) =>
				Effect.gen(function* () {
					const id = params.artifact_id
					const state = yield* requireActive(id)
					const sent = payload.files ?? []
					const request = yield* writeRequest(payload)
					if (state.version !== payload.version) {
						if (state.version === payload.version + 1 && state.version_request === request) {
							const replay = yield* loadVersion(id, state.version).pipe(
								orPending(id, "artifact_version"),
							)
							return isPending(replay)
								? { ...replay, version: state.version }
								: versionResource(id, replay.found, replay.manifest)
						}
						return yield* reject(
							409,
							`Artifact ${id} is at version ${state.version}, not ${payload.version}.`,
						)
					}
					const resolved = yield* startingFrom(payload.made_from, yield* fromFiles(sent))
					const built = yield* build(resolved.files, yield* keptIn(id, sent, state.manifest))
					const capabilities = yield* capabilitiesOf(id, built, resolved.sources)
					yield* copyIn(id, resolved, null)
					yield* stage(id, built, null)
					const receipt = yield* artifacts.send(
						new AddArtifactVersion({
							artifact_id: id,
							expected_version: payload.version,
							manifest: built.manifest_hash,
							file_count: built.file_count,
							total_bytes: built.total_bytes,
							capabilities,
							made_from: resolved.made_from,
							request,
						}),
						{
							commandId: yield* idempotentCommandId(digest, "add-artifact-version", [
								id,
								payload.version,
								request,
							]),
						},
					)
					const version = receipt.reply.version
					const result = yield* loadVersion(id, version, built).pipe(
						orPending(id, "artifact_version"),
					)
					if (isPending(result)) {
						return { ...result, version }
					}
					return versionResource(id, result.found, result.manifest)
				}).pipe(handled),
			)
			.handle("getVersion", ({ params }) =>
				Effect.gen(function* () {
					const { found, manifest } = yield* loadVersion(params.artifact_id, params.version)
					return versionResource(params.artifact_id, found, manifest)
				}).pipe(handled),
			)
			.handle("createLink", ({ params, payload }) =>
				Effect.gen(function* () {
					const id = params.artifact_id
					const { version } = params
					if (version > (yield* requireActive(id)).version) {
						return yield* reject(404, `Artifact ${id} has no version ${version}.`)
					}
					const expiresAt =
						Math.floor((yield* Clock.currentTimeMillis) / 1000) +
						(payload.expires_in ?? DEFAULT_LINK_TTL_SECONDS)
					const access = payload.access ?? "view"
					const url = yield* links.mint({ artifactId: id, version, expiresAt, access })
					return {
						type: "artifact_link" as const,
						artifact_id: id,
						version,
						url,
						access,
						expires_at: DateTime.makeUnsafe(expiresAt * 1000),
					}
				}).pipe(handled),
			)
			.handleRaw("getFileContent", ({ params, query }) =>
				Effect.gen(function* () {
					const id = params.artifact_id
					const { manifest } = yield* loadVersion(id, params.version)
					const file = manifest.files.find((entry) => entry.path === query.file)
					if (file === undefined) {
						return yield* reject(
							404,
							`Artifact ${id} version ${params.version} has no file "${query.file}".`,
						)
					}
					const body =
						(yield* stored(store.blobStream(id, file.sha256))) ??
						(yield* missingBytes(id, { sha256: file.sha256 }))
					return HttpServerResponse.stream(body, {
						contentType: file.content_type,
						contentLength: file.size,
						headers: {
							"content-disposition": "attachment",
							"content-security-policy": "sandbox",
							"x-content-type-options": "nosniff",
						},
					})
				}).pipe(handled),
			)
			.handle("getFile", ({ params, query }) =>
				Effect.gen(function* () {
					const id = params.artifact_id
					const { manifest } = yield* loadVersion(id, params.version)
					const file = manifest.files.find((entry) => entry.path === query.file)
					if (file === undefined) {
						return yield* reject(
							404,
							`Artifact ${id} version ${params.version} has no file "${query.file}".`,
						)
					}
					if (file.size > MAX_INLINE_FILE_BYTES) {
						return yield* reject(
							400,
							`File "${file.path}" is ${file.size} bytes, too large to return as JSON; download it from GET /v1/artifacts/${id}/versions/${params.version}/content?file=${encodeURIComponent(file.path)}.`,
						)
					}
					const bytes =
						(yield* stored(store.getBlob(id, file.sha256))) ??
						(yield* missingBytes(id, { sha256: file.sha256 }))
					return {
						type: "artifact_file" as const,
						path: file.path,
						sha256: file.sha256,
						size: file.size,
						content_type: file.content_type,
						...encodeContent(bytes),
					}
				}).pipe(handled),
			)
	}),
)
