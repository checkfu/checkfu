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
import { PublishArtifact } from "@checkfu/domain/Artifact/PublishArtifact.command"
import { UnpublishArtifact } from "@checkfu/domain/Artifact/UnpublishArtifact.command"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Option from "effect/Option"
import { PublicationAddress } from "@checkfu/sdk/Schemas"
import { buildArtifactVersion } from "../Artifacts/ArtifactFiles.ts"
import type {
	ArtifactFileInput,
	ArtifactManifest,
	BuiltArtifactVersion,
} from "../Artifacts/ArtifactFiles.ts"
import { ArtifactStore, ArtifactStoreError } from "../Artifacts/ArtifactStore.ts"
import type { ArtifactWriteCheck, StagedWrite } from "../Artifacts/ArtifactStore.ts"
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

const stored = <A, R>(effect: Effect.Effect<A, ArtifactStoreError, R>) =>
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

const versionResource = (id: ArtifactId, found: LocatedVersion, manifest: ArtifactManifest) => ({
	type: "artifact_version" as const,
	artifact_id: id,
	version: found.version,
	...filesOf(manifest),
	created_at: found.created_at,
})

const quietly = <E, R>(effect: Effect.Effect<void, E, R>) =>
	effect.pipe(
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.interrupt
				: Effect.logError("Artifact write cleanup failed", cause),
		),
	)

const interrupted = reject(503, "The write was interrupted; retry the request.")

export const ArtifactsLive = HttpApiBuilder.group(CheckfuApi, "artifacts", (handlers) =>
	Effect.gen(function* () {
		const artifacts = yield* Artifact
		const versionViews = yield* ArtifactVersionView
		const store = yield* ArtifactStore
		const links = yield* ArtifactLinks
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom
		const list = yield* makeLister

		const build = (files: ReadonlyArray<ArtifactFileInput>) =>
			buildArtifactVersion(digest, files).pipe(
				Effect.catchTag("InvalidArtifactFiles", (error) => reject(400, error.message)),
			)

		const requireActive = (id: ArtifactId) =>
			artifacts.get(id).pipe(
				Effect.filterOrElse(
					(state) => state.status === "active",
					() => reject(404, `Artifact ${id} not found.`),
				),
			)

		const purgeIfDeleted = (id: ArtifactId) =>
			quietly(
				Effect.gen(function* () {
					const state = yield* artifacts.get(id)
					if (state.status === "deleted") {
						yield* store.purge(id)
					}
				}),
			)

		const commitWrite = (id: ArtifactId, write: StagedWrite, check: ArtifactWriteCheck) =>
			Effect.gen(function* () {
				const deleted = yield* write.markCommitted(check).pipe(
					Effect.tapError(() => quietly(write.abandon)),
					Effect.as(false),
					Effect.catchTag("ArtifactWriteRefused", (refusal) =>
						Effect.flatMap(artifacts.get(id), (state) =>
							state.status === "deleted"
								? Effect.succeed(true)
								: Effect.fail(new ArtifactStoreError({ cause: refusal })),
						),
					),
					stored,
				)
				if (deleted) {
					return yield* reject(404, `Artifact ${id} not found.`)
				}
			})

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

		const manifestOf = (id: ArtifactId, hash: string, built?: BuiltArtifactVersion) =>
			built !== undefined && built.manifest_hash === hash
				? Effect.succeed(built.manifest)
				: loadManifest(id, hash)

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
				const manifest = yield* loadManifest(id, state.manifest)
				return artifactResource(id, state, manifest, yield* publicationOf(id, state))
			})

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

		const retrieve = (id: ArtifactId) =>
			Effect.flatMap(requireActive(id), (state) => readArtifact(id, state))

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
					const built = yield* build(payload.files)
					let id: ArtifactId
					let sendOptions: { readonly commandId: string } | undefined
					if (idempotencyKey !== undefined) {
						id = yield* keyedArtifactId(digest, idempotencyKey)
						sendOptions = {
							commandId: yield* createCommandId(digest, "artifact", idempotencyKey, {
								name: payload.name,
								manifest: built.manifest_hash,
							}),
						}
					} else {
						id = ArtifactId.make(yield* randomId(random, "art"))
					}
					let write: StagedWrite | undefined
					const before = yield* artifacts.get(id)
					if (before.status === "") {
						write = yield* stored(store.stage(id, built))
						yield* commitWrite(id, write, { kind: "create", manifest: built.manifest_hash })
						sendOptions ??= { commandId: `create-artifact:${write.id}` }
					}
					const receipt = yield* artifacts
						.send(
							new CreateArtifact({
								artifact_id: id,
								name: payload.name,
								manifest: built.manifest_hash,
								file_count: built.file_count,
								total_bytes: built.total_bytes,
								fence: before.fence,
							}),
							sendOptions,
						)
						.pipe(
							Effect.tapError(() => (write === undefined ? Effect.void : quietly(write.abandon))),
							Effect.onError(() => purgeIfDeleted(id)),
							Effect.catchTags({
								ArtifactWriteFenced: () => interrupted,
								ArtifactAlreadyExists: () => reject(409, IDEMPOTENCY_KEY_REUSED),
							}),
						)
					if (write !== undefined) {
						yield* quietly(write.confirm)
					}
					const settled = yield* artifacts.get(id).pipe(orPending(id, "artifact"))
					if (isPending(settled)) {
						return settled
					}
					if (settled.status === "deleted") {
						yield* purgeIfDeleted(id)
						return yield* reject(404, `Artifact ${id} was deleted after creation committed.`)
					}
					return artifactResource(
						id,
						{ ...settled, version: receipt.reply.version, updated_at: settled.created_at },
						built.manifest,
						null,
					)
				}).pipe(handled),
			)
			.handle("list", ({ query }) =>
				list("artifact", query, (id) => retrieve(ArtifactId.make(id))).pipe(handled),
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
					yield* stored(store.markDeleting(id))
					if (state.status !== "deleted") {
						yield* artifacts.send(new DeleteArtifact({ artifact_id: id, fence: state.fence })).pipe(
							Effect.catchTags({
								ArtifactNotFound: (refused) =>
									Effect.flatMap(artifacts.get(id), (now) =>
										now.status === "deleted" ? Effect.void : Effect.fail(refused),
									),
								ArtifactWriteFenced: () => interrupted,
							}),
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
						return yield* reject(
							409,
							`Artifact ${id} is at version ${state.version}, not ${payload.version}.`,
						)
					}
					const built = yield* build(payload.files)
					const receipt = yield* Effect.gen(function* () {
						const write = yield* stored(store.stage(id, built))
						yield* commitWrite(id, write, {
							kind: "version",
							manifest: built.manifest_hash,
							expected_version: payload.version,
						})
						return yield* artifacts
							.send(
								new AddArtifactVersion({
									artifact_id: id,
									expected_version: payload.version,
									manifest: built.manifest_hash,
									file_count: built.file_count,
									total_bytes: built.total_bytes,
									fence: state.fence,
								}),
							)
							.pipe(
								Effect.tapError(() => quietly(write.abandon)),
								Effect.tap(() => quietly(write.confirm)),
							)
					}).pipe(
						Effect.onError(() => purgeIfDeleted(id)),
						Effect.catchTag("ArtifactWriteFenced", () => interrupted),
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
			.handle("getFile", ({ params, query }) =>
				Effect.gen(function* () {
					const id = params.artifact_id
					const { manifest } = yield* loadVersion(id, params.version)
					const file = manifest.files.find((entry) => entry.path === query.path)
					if (file === undefined) {
						return yield* reject(
							404,
							`Artifact ${id} version ${params.version} has no file "${query.path}".`,
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
