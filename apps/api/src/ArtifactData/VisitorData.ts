import {
	accessAt,
	both,
	declaredFor,
	decodeGrant,
	grantedFor,
	permits,
} from "@checkfu/domain/Artifact/ArtifactAccess"
import type { CollectionAccess } from "@checkfu/domain/Artifact/ArtifactAccess"
import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import { decodeCapabilities } from "@checkfu/domain/Artifact/ArtifactCapabilities"
import {
	ArtifactDocumentBody,
	ArtifactDocumentDeleted,
	ArtifactDocumentResource,
} from "@checkfu/sdk/Api"
import { isClientEventId } from "@checkfu/sdk/IdempotencyKey"
import { ArtifactCollectionName, ArtifactDocumentId } from "@checkfu/sdk/Schemas"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { ArtifactVersionNotReady, DataAddress, DataCall, DataReply } from "../Api.ts"
import { ArtifactVersionAt } from "../Artifacts/ResolveArtifactVersion.ts"
import { PublishedAt } from "../Artifacts/ResolvePublication.ts"
import { ArtifactLinks } from "../Content/ArtifactLinks.ts"
import { DataThrottle } from "./DataThrottle.ts"
import { DEFAULT_DOCUMENT_PAGE_SIZE, DocumentCalls, isDocumentRefused } from "./DocumentCalls.ts"

const MAX_PAGE_SIZE = 100

const isArtifactId = Schema.is(ArtifactId)
const isCollection = Schema.is(ArtifactCollectionName)
const isDocumentId = Schema.is(ArtifactDocumentId)
const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(ArtifactDocumentBody), {
	onExcessProperty: "error",
})
const encodeDocument = Schema.encodeSync(ArtifactDocumentResource)
const encodeList = Schema.encodeSync(
	Schema.Struct({
		data: Schema.Array(ArtifactDocumentResource),
		next_page: Schema.NullOr(Schema.String),
	}),
)
const encodeDeleted = Schema.encodeSync(ArtifactDocumentDeleted)

const reply = (status: number, value: unknown): DataReply => ({
	status,
	body: JSON.stringify(value),
})

const refused = (status: number, message: string, code?: string): DataReply =>
	reply(status, { error: code === undefined ? { message } : { message, code } })

const NOT_FOUND = refused(404, "Not found.")

const wholeNumber = (text: string, maximum: number): number | undefined => {
	const value = Number(text)
	return text !== "" &&
		String(value) === text &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= maximum
		? value
		: undefined
}

export const VisitorData = Effect.gen(function* () {
	const artifacts = yield* Artifact
	const versionAt = yield* ArtifactVersionAt
	const publishedAt = yield* PublishedAt
	const documents = yield* DocumentCalls
	const links = yield* ArtifactLinks
	const throttle = yield* DataThrottle

	const resolve = (
		address: DataAddress,
	): Effect.Effect<
		{ readonly id: ArtifactId; readonly allowed: (collection: string) => CollectionAccess } | null,
		ArtifactVersionNotReady
	> =>
		Effect.gen(function* () {
			if (address.kind === "link") {
				const claims = yield* links.verify(address.token)
				if (claims === null || !isArtifactId(claims.artifactId)) {
					return null
				}
				const id = claims.artifactId
				const found = yield* versionAt(id, yield* Effect.orDie(artifacts.get(id)), claims.version)
				if (found === null) {
					return null
				}
				const declared = decodeCapabilities(found.capabilities)
				return {
					id,
					allowed: (collection) => accessAt(claims.access, declaredFor(declared, collection)),
				}
			}
			const published = yield* publishedAt(address.address)
			if (published === null || published.state.public_access === "") {
				return null
			}
			const found = yield* versionAt(published.id, published.state, published.version)
			if (found === null) {
				return null
			}
			const level = published.state.public_access
			const saved = decodeGrant(published.state.public_grant)
			const declared = decodeCapabilities(found.capabilities)
			return {
				id: published.id,
				allowed: (collection) =>
					both(grantedFor(saved, collection), accessAt(level, declaredFor(declared, collection))),
			}
		})

	return (
		address: DataAddress,
		call: DataCall,
	): Effect.Effect<DataReply, ArtifactVersionNotReady> =>
		Effect.gen(function* () {
			const target = yield* resolve(address)
			if (target === null) {
				return NOT_FOUND
			}
			const { collection, operation } = call
			const access = target.allowed(collection)
			if (!isCollection(collection) || !permits(access, operation)) {
				return refused(403, `This address does not allow ${operation} on ${collection}.`)
			}
			if (!(yield* throttle.admit(target.id, call.caller))) {
				return refused(429, "Too many requests. Try again in a minute.")
			}
			if (operation === "list") {
				const after = call.page === "" ? 0 : wholeNumber(call.page, Number.MAX_SAFE_INTEGER)
				const limit =
					call.limit === "" ? DEFAULT_DOCUMENT_PAGE_SIZE : wholeNumber(call.limit, MAX_PAGE_SIZE)
				if (after === undefined || limit === undefined || limit < 1) {
					return refused(400, `page must come from next_page, and limit be 1 to ${MAX_PAGE_SIZE}.`)
				}
				return reply(200, encodeList(yield* documents.list(target.id, collection, after, limit)))
			}
			if (operation === "add") {
				const body = decodeBody(call.body)
				if (Option.isNone(body)) {
					return refused(400, 'Send JSON of the form {"data": …}.')
				}
				if (call.idempotency_key !== "" && !isClientEventId(call.idempotency_key)) {
					return refused(400, "Idempotency-Key is not valid.")
				}
				const document = yield* documents.add(
					target.id,
					collection,
					body.value.data,
					call.idempotency_key === "" ? undefined : call.idempotency_key,
					"visitor",
				)
				return reply(
					201,
					permits(access, "get")
						? encodeDocument(document)
						: { id: document.id, type: "artifact_document_added" },
				)
			}
			if (!isDocumentId(call.id)) {
				return NOT_FOUND
			}
			if (operation === "get") {
				return reply(200, encodeDocument(yield* documents.get(target.id, collection, call.id)))
			}
			if (operation === "delete") {
				return reply(200, encodeDeleted(yield* documents.remove(target.id, collection, call.id)))
			}
			const body = decodeBody(call.body)
			if (Option.isNone(body)) {
				return refused(400, 'Send JSON of the form {"data": …}.')
			}
			return reply(
				200,
				encodeDocument(yield* documents.put(target.id, collection, call.id, body.value.data)),
			)
		}).pipe(
			Effect.catchIf(isDocumentRefused, ({ status, message, code }) =>
				Effect.succeed(refused(status, message, code)),
			),
		)
})
