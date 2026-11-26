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
import { OpenArtifact } from "@checkfu/domain/Artifact/OpenArtifact.command"
import { PublishArtifact } from "@checkfu/domain/Artifact/PublishArtifact.command"
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
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import { PublicationAddress } from "@checkfu/sdk/Schemas"
import { MAX_ARTIFACT_FILE_BYTES, buildArtifactVersion } from "../Artifacts/ArtifactFiles.ts"
import type {
	ArtifactManifest,
	ArtifactVersionFileInput,
	BuiltArtifactVersion,
} from "../Artifacts/ArtifactFiles.ts"
import { ArtifactStore, ArtifactStoreError } from "../Artifacts/ArtifactStore.ts"
import {
	DEFAULT_LINK_TTL_SECONDS,
	newPublicationToken,
	publicationAddress,
} from "../Content/ArtifactLink.ts"
import { ArtifactLinks } from "../Content/ArtifactLinks.ts"
import { CheckfuApi } from "./Api.ts"
import { makeLister } from "./Listing.ts"
import {
	IDEMPOTENCY_KEY_REUSED,
	createCommandId,
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

const stored = <A, E extends { readonly _tag: string }, R>(
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
	...filesOf(manifest),
	created_at: found.created_at,
})

const interrupted = reject(503, "The create took too long; retry the request.")

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
				published_at: DateTime.makeUnsafe(state.published_at),
			}
			return publication
		})

	const readArtifact = (id: ArtifactId, state: ArtifactState) =>
		Effect.gen(function* () {
			const manifest: ArtifactManifest =
				state.manifest === "" ? { files: [] } : yield* loadManifest(id, state.manifest)
			return artifactResource(id, state, manifest, yield* publicationOf(id, state))
		})

	const retrieve = (id: ArtifactId) =>
		Effect.flatMap(requireActive(id), (state) => readArtifact(id, state))

	return { requireActive, missingBytes, loadManifest, publicationOf, readArtifact, retrieve }
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

		const build = (
			files: ReadonlyArray<ArtifactVersionFileInput>,
			kept?: ReadonlyMap<string, number>,
		) =>
			buildArtifactVersion(digest, files, kept).pipe(
				Effect.catchTag("InvalidArtifactFiles", (error) => reject(400, error.message)),
			)

		const stage = (id: ArtifactId, built: BuiltArtifactVersion, reservation: number | null) =>
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
				const named = [...new Set(files.flatMap((file) => ("sha256" in file ? [file.sha256] : [])))]
				if (named.length === 0) {
					return kept
				}
				if (manifestHash !== "") {
					for (const file of (yield* loadManifest(id, manifestHash)).files) {
						kept.set(file.sha256, file.size)
					}
				}
				const unknown = named.filter((sha256) => !kept.has(sha256))
				const sizes = yield* Effect.forEach(
					unknown,
					(sha256) => stored(store.blobSize(id, sha256)),
					{
						concurrency: 8,
					},
				)
				unknown.forEach((sha256, index) => {
					const size = sizes[index]
					if (size !== null && size !== undefined) {
						kept.set(sha256, size)
					}
				})
				return kept
			})

		const manifestOf = (id: ArtifactId, hash: string, built?: BuiltArtifactVersion) =>
			built !== undefined && built.manifest_hash === hash
				? Effect.succeed(built.manifest)
				: loadManifest(id, hash)

		const sentWith = (
			id: ArtifactId,
			idempotencyKey: string | undefined,
			request:
				| { readonly operation: "publish"; readonly pinned_version: number }
				| { readonly operation: "unpublish" },
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
					return yield* reject(409, IDEMPOTENCY_KEY_REUSED)
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

		const loadVersion = (id: ArtifactId, version: number, built?: BuiltArtifactVersion) =>
			Effect.gen(function* () {
				const found = yield* locateVersion(id, yield* requireActive(id), version)
				return { found, manifest: yield* manifestOf(id, found.manifest, built) }
			})

		return handlers
			.handle("create", ({ payload, headers }) =>
				Effect.gen(function* () {
					const idempotencyKey = headers["idempotency-key"]
					const built = payload.files === undefined ? undefined : yield* build(payload.files)
					let id: ArtifactId
					let sendOptions: { readonly commandId: string } | undefined
					if (idempotencyKey !== undefined) {
						id = yield* keyedArtifactId(digest, idempotencyKey)
						sendOptions = {
							commandId: yield* createCommandId(digest, "artifact", idempotencyKey, {
								name: payload.name,
								manifest: built?.manifest_hash ?? "",
							}),
						}
					} else {
						id = ArtifactId.make(yield* randomId(random, "art"))
					}
					let reservation = 0
					if ((yield* artifacts.get(id)).status === "") {
						reservation = yield* artifacts.send(new ReserveArtifact({ artifact_id: id })).pipe(
							Effect.map((reserved) => reserved.reply.reservation),
							Effect.catchTag("ArtifactAlreadyExists", () => Effect.succeed(0)),
						)
						if (reservation !== 0 && built !== undefined) {
							yield* stage(id, built, reservation)
						}
					}
					const commandOptions = sendOptions ?? { commandId: `create-artifact:${id}` }
					const receipt = yield* (
						built === undefined
							? artifacts.send(
									new OpenArtifact({ artifact_id: id, name: payload.name, reservation }),
									commandOptions,
								)
							: artifacts.send(
									new CreateArtifact({
										artifact_id: id,
										name: payload.name,
										manifest: built.manifest_hash,
										file_count: built.file_count,
										total_bytes: built.total_bytes,
										reservation,
									}),
									commandOptions,
								)
					).pipe(
						Effect.catchTags({
							ArtifactReservationLapsed: () => interrupted,
							ArtifactAlreadyExists: () => reject(409, IDEMPOTENCY_KEY_REUSED),
						}),
					)
					const settled = yield* artifacts.get(id).pipe(orPending(id, "artifact"))
					if (isPending(settled)) {
						return settled
					}
					if (settled.status === "deleted") {
						return yield* reject(404, `Artifact ${id} was deleted after creation committed.`)
					}
					return artifactResource(
						id,
						{ ...settled, version: receipt.reply.version, updated_at: settled.created_at },
						built?.manifest ?? { files: [] },
						null,
					)
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
					const sendOptions = yield* sentWith(id, headers["idempotency-key"], {
						operation: "publish",
						pinned_version,
					})
					yield* artifacts.send(
						new PublishArtifact({
							artifact_id: id,
							token: yield* newPublicationToken(random),
							pinned_version,
						}),
						sendOptions,
					)
					return yield* readArtifact(id, yield* requireActive(id))
				}).pipe(handled),
			)
			.handle("unpublish", ({ params, headers }) =>
				Effect.gen(function* () {
					const id = params.artifact_id
					const sendOptions = yield* sentWith(id, headers["idempotency-key"], {
						operation: "unpublish",
					})
					yield* artifacts.send(new UnpublishArtifact({ artifact_id: id }), sendOptions)
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
					if (state.version !== payload.version) {
						if (state.version === payload.version + 1) {
							const replaced = yield* keptIn(id, payload.files, state.replaced_manifest)
							const resent = yield* buildArtifactVersion(digest, payload.files, replaced).pipe(
								Effect.asSome,
								Effect.catchTag("InvalidArtifactFiles", () => Effect.succeedNone),
							)
							if (Option.isSome(resent) && resent.value.manifest_hash === state.manifest) {
								const replay = yield* loadVersion(id, state.version, resent.value).pipe(
									orPending(id, "artifact_version"),
								)
								return isPending(replay)
									? { ...replay, version: state.version }
									: versionResource(id, replay.found, replay.manifest)
							}
						}
						return yield* reject(
							409,
							`Artifact ${id} is at version ${state.version}, not ${payload.version}.`,
						)
					}
					const built = yield* build(
						payload.files,
						yield* keptIn(id, payload.files, state.manifest),
					)
					yield* stage(id, built, null)
					const receipt = yield* artifacts.send(
						new AddArtifactVersion({
							artifact_id: id,
							expected_version: payload.version,
							manifest: built.manifest_hash,
							file_count: built.file_count,
							total_bytes: built.total_bytes,
						}),
						{
							commandId: yield* idempotentCommandId(digest, "add-artifact-version", [
								id,
								payload.version,
								built.manifest_hash,
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
					const url = yield* links.mint({ artifactId: id, version, expiresAt })
					return {
						type: "artifact_link" as const,
						artifact_id: id,
						version,
						url,
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
			.handle("uploadBlob", ({ params, payload }) =>
				Effect.gen(function* () {
					const id = params.artifact_id
					const { sha256 } = params
					yield* requireActive(id)
					const request = yield* HttpServerRequest.HttpServerRequest
					const size = Number(request.headers["content-length"] ?? Number.NaN)
					if (!Number.isSafeInteger(size) || size < 0) {
						return yield* reject(400, "Send the upload with a Content-Length header.")
					}
					if (size > MAX_ARTIFACT_FILE_BYTES) {
						return yield* reject(413, `An upload may be at most ${MAX_ARTIFACT_FILE_BYTES} bytes.`)
					}
					const blob = (stored_size: number) => ({
						type: "artifact_blob" as const,
						artifact_id: id,
						sha256,
						size: stored_size,
					})
					const held = yield* stored(store.blobSize(id, sha256))
					if (held !== null) {
						return blob(held)
					}
					const outcome = yield* stored(
						store.putBlob(
							id,
							sha256,
							payload.pipe(Stream.mapError((cause) => new ArtifactStoreError({ cause }))),
							size,
						),
					)
					if (outcome === "mismatch") {
						return yield* reject(400, `The uploaded bytes do not match sha256 ${sha256}.`)
					}
					if ((yield* artifacts.get(id)).status !== "active") {
						yield* stored(store.purge(id))
						return yield* reject(404, `Artifact ${id} not found.`)
					}
					return blob(size)
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
