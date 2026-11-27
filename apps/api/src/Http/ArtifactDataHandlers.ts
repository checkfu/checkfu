import { CheckfuApi } from "@checkfu/sdk/Api"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import {
	DEFAULT_DOCUMENT_PAGE_SIZE,
	DocumentCalls,
	isDocumentRefused,
} from "../ArtifactData/DocumentCalls.ts"
import type { DocumentRefused } from "../ArtifactData/DocumentCalls.ts"
import { artifactReads } from "./ArtifactsHandlers.ts"
import { handled, reject } from "./HttpHelpers.ts"

const answered = <A, E, R>(effect: Effect.Effect<A, E | DocumentRefused, R>) =>
	effect.pipe(
		Effect.catchIf(isDocumentRefused, ({ status, message, code }) =>
			reject(status, message, code === undefined ? undefined : { code }),
		),
		handled,
	)

export const ArtifactDataLive = HttpApiBuilder.group(CheckfuApi, "artifact_data", (handlers) =>
	Effect.gen(function* () {
		const documents = yield* DocumentCalls
		const { requireActive } = yield* artifactReads

		return handlers
			.handle("getDatabase", ({ params }) =>
				Effect.andThen(
					requireActive(params.artifact_id),
					documents.describe(params.artifact_id),
				).pipe(answered),
			)
			.handle("listDocuments", ({ params, query }) =>
				Effect.andThen(
					requireActive(params.artifact_id),
					documents.list(
						params.artifact_id,
						params.collection,
						query.page === undefined ? 0 : Number(query.page),
						query.limit ?? DEFAULT_DOCUMENT_PAGE_SIZE,
					),
				).pipe(answered),
			)
			.handle("addDocument", ({ params, payload, headers }) =>
				Effect.andThen(
					requireActive(params.artifact_id),
					documents.add(
						params.artifact_id,
						params.collection,
						payload.data,
						headers["idempotency-key"],
					),
				).pipe(answered),
			)
			.handle("getDocument", ({ params }) =>
				Effect.andThen(
					requireActive(params.artifact_id),
					documents.get(params.artifact_id, params.collection, params.document_id),
				).pipe(answered),
			)
			.handle("putDocument", ({ params, payload }) =>
				Effect.andThen(
					requireActive(params.artifact_id),
					documents.put(params.artifact_id, params.collection, params.document_id, payload.data),
				).pipe(answered),
			)
			.handle("deleteDocument", ({ params }) =>
				Effect.andThen(
					requireActive(params.artifact_id),
					documents.remove(params.artifact_id, params.collection, params.document_id),
				).pipe(answered),
			)
	}),
)
