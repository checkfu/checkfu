import type { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import { CheckfuApi } from "@checkfu/sdk/Api"
import {
	MAX_ARTIFACT_COLLECTION_DOCUMENTS,
	MAX_ARTIFACT_DATABASE_BYTES,
	MAX_ARTIFACT_DOCUMENT_BYTES,
} from "@checkfu/sdk/Limits"
import { MAX_ARTIFACT_COLLECTIONS } from "@checkfu/sdk/Schemas"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { ArtifactDatabase } from "../ArtifactData/ArtifactDatabase.ts"
import type { ArtifactDatabaseError } from "../ArtifactData/ArtifactDatabase.ts"
import type { StoredDocument, WriteRefusal } from "../ArtifactData/ArtifactDocuments.ts"
import { artifactReads } from "./ArtifactsHandlers.ts"
import { handled, idempotentId, randomId, reject, reusedKey } from "./HttpHelpers.ts"

const DEFAULT_PAGE_SIZE = 50
const DOCUMENT_ID_LENGTH = "doc_".length + 32

const decodeData = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const held = <A, E extends { readonly _tag: string }, R>(
	effect: Effect.Effect<A, E | ArtifactDatabaseError, R>,
) =>
	effect.pipe(
		Effect.catchTag("ArtifactDatabaseError", (error) =>
			Effect.andThen(
				Effect.logError("Artifact database failed", error),
				reject(503, "The artifact's database is unavailable. Retry the request."),
			),
		),
	)

const refusal = (artifactId: ArtifactId, collection: string, refused: WriteRefusal) => {
	switch (refused) {
		case "erased": {
			return reject(404, `Artifact ${artifactId} not found.`)
		}
		case "exists": {
			return reject(409, "A document with this id already exists.")
		}
		case "too_large": {
			return reject(400, `A document may be at most ${MAX_ARTIFACT_DOCUMENT_BYTES} bytes of JSON.`)
		}
		case "collections": {
			return reject(
				409,
				`The database already holds ${MAX_ARTIFACT_COLLECTIONS} collections. Empty one to use another.`,
			)
		}
		case "documents": {
			return reject(
				409,
				`${collection} already holds ${MAX_ARTIFACT_COLLECTION_DOCUMENTS} documents. Delete some to add more.`,
			)
		}
		case "bytes": {
			return reject(
				409,
				`The database may hold at most ${MAX_ARTIFACT_DATABASE_BYTES} bytes of documents. Delete some to add more.`,
			)
		}
	}
}

const resource = (artifactId: ArtifactId, collection: string, document: StoredDocument) =>
	Option.match(decodeData(document.body), {
		onNone: () =>
			Effect.andThen(
				Effect.logError("Artifact document is not JSON", {
					artifact_id: artifactId,
					collection,
					document_id: document.id,
				}),
				reject(500, "Failed to load the document."),
			),
		onSome: (data) =>
			Effect.succeed({
				id: document.id,
				type: "artifact_document" as const,
				artifact_id: artifactId,
				collection,
				data,
				created_at: DateTime.makeUnsafe(document.created_at),
				updated_at: DateTime.makeUnsafe(document.updated_at),
			}),
	})

const missing = (collection: string, id: string) =>
	reject(404, `Document ${id} not found in ${collection}.`)

export const ArtifactDataLive = HttpApiBuilder.group(CheckfuApi, "artifact_data", (handlers) =>
	Effect.gen(function* () {
		const database = yield* ArtifactDatabase
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom
		const { requireActive } = yield* artifactReads

		return handlers
			.handle("getDatabase", ({ params }) =>
				Effect.gen(function* () {
					const id = params.artifact_id
					yield* requireActive(id)
					const usage = yield* held(database.usage(id))
					return {
						type: "artifact_database" as const,
						artifact_id: id,
						bytes: usage.bytes,
						collections: usage.collections.map(({ collection, documents, bytes }) => ({
							name: collection,
							documents,
							bytes,
						})),
					}
				}).pipe(handled),
			)
			.handle("listDocuments", ({ params, query }) =>
				Effect.gen(function* () {
					const id = params.artifact_id
					yield* requireActive(id)
					const page = yield* held(
						database.list(
							id,
							params.collection,
							query.page === undefined ? 0 : Number(query.page),
							query.limit ?? DEFAULT_PAGE_SIZE,
						),
					)
					return {
						data: yield* Effect.forEach(page.documents, (document) =>
							resource(id, params.collection, document),
						),
						next_page: page.next === null ? null : String(page.next),
					}
				}).pipe(handled),
			)
			.handle("addDocument", ({ params, payload, headers }) =>
				Effect.gen(function* () {
					const id = params.artifact_id
					const { collection } = params
					yield* requireActive(id)
					const key = headers["idempotency-key"]
					const documentId =
						key === undefined
							? yield* randomId(random, "doc")
							: (yield* idempotentId(digest, "doc", [
									"artifact",
									"document",
									"id",
									id,
									collection,
									key,
								])).slice(0, DOCUMENT_ID_LENGTH)
					const body = JSON.stringify(payload.data)
					const outcome = yield* held(database.write(id, collection, documentId, body, "create"))
					if (outcome.refused === null) {
						return yield* resource(id, collection, outcome.document)
					}
					if (outcome.refused !== "exists" || key === undefined) {
						return yield* refusal(id, collection, outcome.refused)
					}
					const first = yield* held(database.get(id, collection, documentId))
					return first !== null && first.body === body
						? yield* resource(id, collection, first)
						: yield* reusedKey
				}).pipe(handled),
			)
			.handle("getDocument", ({ params }) =>
				Effect.gen(function* () {
					const id = params.artifact_id
					yield* requireActive(id)
					const document = yield* held(database.get(id, params.collection, params.document_id))
					return document === null
						? yield* missing(params.collection, params.document_id)
						: yield* resource(id, params.collection, document)
				}).pipe(handled),
			)
			.handle("putDocument", ({ params, payload }) =>
				Effect.gen(function* () {
					const id = params.artifact_id
					yield* requireActive(id)
					const outcome = yield* held(
						database.write(
							id,
							params.collection,
							params.document_id,
							JSON.stringify(payload.data),
							"replace",
						),
					)
					return outcome.refused === null
						? yield* resource(id, params.collection, outcome.document)
						: yield* refusal(id, params.collection, outcome.refused)
				}).pipe(handled),
			)
			.handle("deleteDocument", ({ params }) =>
				Effect.gen(function* () {
					const id = params.artifact_id
					yield* requireActive(id)
					const removed = yield* held(database.remove(id, params.collection, params.document_id))
					return removed
						? { id: params.document_id, type: "artifact_document_deleted" as const }
						: yield* missing(params.collection, params.document_id)
				}).pipe(handled),
			)
	}),
)
