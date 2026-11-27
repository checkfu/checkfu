import type { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import { ERROR_CODES } from "@checkfu/sdk/ErrorCodes"
import type { ErrorCode } from "@checkfu/sdk/ErrorCodes"
import {
	MAX_ARTIFACT_COLLECTION_DOCUMENTS,
	MAX_ARTIFACT_DATABASE_BYTES,
	MAX_ARTIFACT_DOCUMENT_BYTES,
} from "@checkfu/sdk/Limits"
import { MAX_ARTIFACT_COLLECTIONS } from "@checkfu/sdk/Schemas"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { ArtifactDatabase } from "./ArtifactDatabase.ts"
import type { ArtifactDatabaseError } from "./ArtifactDatabase.ts"
import type { StoredDocument, WriteRefusal } from "./ArtifactDocuments.ts"

export const DEFAULT_DOCUMENT_PAGE_SIZE = 50

export type DocumentAuthor = "owner" | "visitor"

export class DocumentRefused extends Data.TaggedError("DocumentRefused")<{
	readonly status: 400 | 404 | 409 | 503
	readonly message: string
	readonly code?: ErrorCode
}> {}

export const isDocumentRefused = (error: unknown): error is DocumentRefused =>
	Predicate.isTagged(error, "DocumentRefused")

const utf8Encoder = new TextEncoder()
const decodeData = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const refuse = (status: DocumentRefused["status"], message: string) =>
	Effect.fail(new DocumentRefused({ status, message }))

const held = <A>(effect: Effect.Effect<A, ArtifactDatabaseError>) =>
	Effect.catchTag(effect, "ArtifactDatabaseError", (error) =>
		Effect.andThen(
			Effect.logError("Artifact database failed", error),
			refuse(503, "The artifact's database is unavailable. Retry the request."),
		),
	)

const gone = (artifactId: string) => refuse(404, `Artifact ${artifactId} not found.`)

const missing = (collection: string, id: string) =>
	refuse(404, `Document ${id} not found in ${collection}.`)

const refusal = (artifactId: string, collection: string, refused: WriteRefusal) => {
	switch (refused) {
		case "erased": {
			return gone(artifactId)
		}
		case "exists": {
			return refuse(409, "A document with this id already exists.")
		}
		case "idempotency_key_reused": {
			return Effect.fail(
				new DocumentRefused({
					status: 409,
					message: "Idempotency-Key was already used for a different request.",
					code: ERROR_CODES.idempotencyKeyReused,
				}),
			)
		}
		case "too_large": {
			return refuse(400, `A document may be at most ${MAX_ARTIFACT_DOCUMENT_BYTES} bytes of JSON.`)
		}
		case "collections": {
			return refuse(
				409,
				`The database already holds ${MAX_ARTIFACT_COLLECTIONS} collections. Empty one to use another.`,
			)
		}
		case "documents": {
			return refuse(
				409,
				`${collection} already holds ${MAX_ARTIFACT_COLLECTION_DOCUMENTS} documents. Delete some to add more.`,
			)
		}
		case "bytes": {
			return refuse(
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
				refuse(503, "The document could not be read. Retry the request."),
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

export const DocumentCalls = Effect.gen(function* () {
	const database = yield* ArtifactDatabase
	const digest = yield* Digest.Digest
	const random = yield* SecureRandom.SecureRandom

	const keyedId = (artifactId: string, collection: string, by: DocumentAuthor, key: string) =>
		Effect.map(
			digest.digestHex(
				Digest.sha256,
				utf8Encoder.encode(
					JSON.stringify(["artifact", "document", "id", artifactId, collection, by, key]),
				),
			),
			(hash) => `doc_${hash.slice(0, 32)}`,
		)

	return {
		describe: (artifactId: ArtifactId) =>
			Effect.map(held(database.usage(artifactId)), (usage) => ({
				type: "artifact_database" as const,
				artifact_id: artifactId,
				bytes: usage.bytes,
				collections: usage.collections.map(({ collection, documents, bytes }) => ({
					name: collection,
					documents,
					bytes,
				})),
			})),

		list: (artifactId: ArtifactId, collection: string, after: number, limit: number) =>
			Effect.gen(function* () {
				const page = yield* held(database.list(artifactId, collection, after, limit))
				return {
					data: yield* Effect.forEach(page.documents, (document) =>
						resource(artifactId, collection, document),
					),
					next_page: page.next === null ? null : String(page.next),
				}
			}),

		get: (artifactId: ArtifactId, collection: string, id: string) =>
			Effect.flatMap(held(database.get(artifactId, collection, id)), (document) =>
				document === null ? missing(collection, id) : resource(artifactId, collection, document),
			),

		add: (
			artifactId: ArtifactId,
			collection: string,
			data: Schema.Json,
			key: string | undefined,
			by: DocumentAuthor,
			beforeMutation: Effect.Effect<void, DocumentRefused> = Effect.void,
		) =>
			Effect.gen(function* () {
				const id =
					key === undefined
						? `doc_${Hex.encode(yield* random.randomBytes(12))}`
						: yield* keyedId(artifactId, collection, by, key)
				const body = JSON.stringify(data)
				const createHash =
					key === undefined
						? undefined
						: yield* digest.digestHex(Digest.sha256, utf8Encoder.encode(body))
				yield* beforeMutation
				const outcome = yield* held(
					database.write(artifactId, collection, id, body, "create", createHash),
				)
				return yield* outcome.refused === null
					? resource(artifactId, collection, outcome.document)
					: refusal(artifactId, collection, outcome.refused)
			}),

		put: (
			artifactId: ArtifactId,
			collection: string,
			id: string,
			data: Schema.Json,
			beforeMutation: Effect.Effect<void, DocumentRefused> = Effect.void,
		) =>
			Effect.flatMap(
				Effect.andThen(
					beforeMutation,
					held(database.write(artifactId, collection, id, JSON.stringify(data), "replace")),
				),
				(outcome) =>
					outcome.refused === null
						? resource(artifactId, collection, outcome.document)
						: refusal(artifactId, collection, outcome.refused),
			),

		remove: (
			artifactId: ArtifactId,
			collection: string,
			id: string,
			beforeMutation: Effect.Effect<void, DocumentRefused> = Effect.void,
		) =>
			Effect.flatMap(
				Effect.andThen(beforeMutation, held(database.remove(artifactId, collection, id))),
				(removed) =>
					removed
						? Effect.succeed({ id, type: "artifact_document_deleted" as const })
						: missing(collection, id),
			),
	}
})
