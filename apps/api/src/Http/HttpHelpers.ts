import {
	MAX_AGENT_DESCRIPTION_LENGTH,
	MAX_AGENT_NAME_LENGTH,
	MAX_AGENT_SYSTEM_LENGTH,
} from "@checkfu/domain/Agent/AgentTypes"
import { MAX_MEMORY_CONTENT_BYTES } from "@checkfu/domain/Memory/MemoryTypes"
import { MAX_MESSAGE_TEXT_LENGTH } from "@checkfu/domain/Session/SessionTypes"
import { MAX_FILE_BYTES, MAX_SESSION_BODY_BYTES } from "@checkfu/sdk/Limits"
import {
	MAX_AGENT_TOOLS_TEXT_LENGTH,
	MAX_MCP_SERVERS_TEXT_LENGTH,
} from "@checkfu/domain/Mcp/McpServers"
import * as ByteSize from "effect/ByteSize"
import * as Digest from "effect/crypto/Digest"
import * as Mac from "effect/crypto/Mac"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware"
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage"
import * as HttpServerError from "effect/http/HttpServerError"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as References from "effect/References"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import { optionalSecret } from "../Secrets.ts"
import { MAX_ARTIFACT_BODY_BYTES, MAX_ARTIFACT_FILE_BYTES } from "../Artifacts/ArtifactFiles.ts"
import {
	AgentBodyLimit,
	ArtifactBlobLimit,
	FileBodyLimit,
	ArtifactBodyLimit,
	Authentication,
	ERROR_CODES,
	EventBatchBodyLimit,
	MemoryBodyLimit,
	SessionBodyLimit,
	RequestId,
	RequestValidation,
	apiError,
	parseHandlerError,
	redactApiErrorEnvelope,
	statusOf,
} from "./Api.ts"
import type {
	ApiError,
	ERRORS,
	ErrorStatus,
	HandlerError,
	HandlerErrorStatus,
	PendingResourceType,
} from "./Api.ts"

export const MAX_REQUEST_BODY_BYTES = 160 * 1024
const ESCAPED_UNIT_BYTES = 6
const ESCAPED_CODE_POINT_BYTES = 2 * ESCAPED_UNIT_BYTES
export const MAX_AGENT_BODY_BYTES =
	(MAX_AGENT_NAME_LENGTH + MAX_AGENT_DESCRIPTION_LENGTH + MAX_AGENT_SYSTEM_LENGTH) *
		ESCAPED_CODE_POINT_BYTES +
	(MAX_MCP_SERVERS_TEXT_LENGTH + MAX_AGENT_TOOLS_TEXT_LENGTH) * ESCAPED_UNIT_BYTES +
	16 * 1024
export const MAX_EVENTS_BODY_BYTES = 8 * MAX_MESSAGE_TEXT_LENGTH * 6 + 16 * 1024
export const MAX_MEMORY_BODY_BYTES = MAX_MEMORY_CONTENT_BYTES * 6 + 16 * 1024

const errorStatusOfRejection = (status: number): HandlerErrorStatus | undefined => {
	switch (status) {
		case 400:
			return 400
		case 404:
			return 404
		case 409:
			return 409
		case 429:
			return 429
		case 503:
			return 503
		default:
			return undefined
	}
}

const rejectionAnnotationInfo = (err: unknown) => {
	const rejection = Predicate.isObject(err) && "constructor" in err ? err.constructor : undefined
	if (!Schema.isSchema(rejection)) {
		return undefined
	}
	const httpApiStatus = SchemaAST.resolveAt<unknown>("httpApiStatus")(rejection.ast)
	return {
		httpApiStatus: typeof httpApiStatus === "number" ? httpApiStatus : undefined,
		description: SchemaAST.resolveDescription(rejection.ast),
	}
}

export const currentRequestId: Effect.Effect<RequestId> = Effect.flatMap(
	References.CurrentLogAnnotations,
	(annotations) =>
		typeof annotations.request_id === "string" && annotations.request_id.length > 0
			? Effect.succeed(RequestId.make(annotations.request_id))
			: Effect.die(new Error("Missing request_id in log annotations.")),
)

export const toApiError = (err: unknown, request_id: RequestId): HandlerError => {
	const handlerError = parseHandlerError(err, request_id)
	if (handlerError !== undefined) {
		return handlerError
	}
	const rejection = rejectionAnnotationInfo(err)
	if (rejection !== undefined) {
		const status =
			rejection.httpApiStatus === undefined
				? undefined
				: errorStatusOfRejection(rejection.httpApiStatus)
		if (status !== undefined) {
			return apiError(
				status,
				rejection.description ?? "Request rejected.",
				request_id,
				Predicate.isTagged(err, "SessionAwaitingAction")
					? { code: ERROR_CODES.sessionAwaitingAction }
					: undefined,
			)
		}
	}
	if (Predicate.isTagged(err, "ConsistencyTimeout") || Predicate.isTagged(err, "WaitTimeout")) {
		return apiError(503, "Timed out waiting for view consistency.", request_id)
	}
	return apiError(500, "Internal server error.", request_id)
}

export const reject = <S extends ErrorStatus>(
	status: S,
	message: string,
	extra?: Parameters<typeof apiError>[3],
) =>
	Effect.flatMap(currentRequestId, (request_id) =>
		Effect.fail(apiError(status, message, request_id, extra)),
	)

export const present = <A, S extends HandlerErrorStatus>(
	result: Option.Option<A | null>,
	status: S,
	message: string,
) => {
	const value = Option.getOrNull(result)
	return value === null ? reject(status, message) : Effect.succeed(value)
}

export const handled = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, HandlerError, R> =>
	effect.pipe(
		Effect.catch((error) =>
			Effect.flatMap(currentRequestId, (request_id) => {
				const mapped = toApiError(error, request_id)
				return statusOf(mapped) === 500
					? Effect.andThen(
							Effect.logError("Unhandled API failure", redactApiErrorEnvelope(error) ?? error),
							Effect.fail(mapped),
						)
					: Effect.fail(mapped)
			}),
		),
	)

export interface Pending<T extends PendingResourceType = PendingResourceType> {
	readonly id: string
	readonly type: T
	readonly pending: true
}

export const isPending = (value: unknown): value is Pending =>
	typeof value === "object" && value !== null && "pending" in value

export const orPending =
	<const T extends PendingResourceType>(id: string, type: T) =>
	<A, E, R>(read: Effect.Effect<A, E, R>): Effect.Effect<A | Pending<T>, E, R> =>
		read.pipe(
			Effect.catchDefect((defect) =>
				Effect.as(Effect.logError("Read after commit failed", defect), {
					id,
					type,
					pending: true as const,
				}),
			),
			Effect.catchIf(
				(err) =>
					Predicate.isTagged(err, "ConsistencyTimeout") || Predicate.isTagged(err, "WaitTimeout"),
				() => Effect.succeed({ id, type, pending: true as const }),
			),
		)

export const orPendingWithin =
	<const T extends PendingResourceType, const P extends Readonly<Record<string, string>>>(
		id: string,
		type: T,
		parent: P,
	) =>
	<A, E, R>(read: Effect.Effect<A, E, R>) =>
		read.pipe(
			orPending(id, type),
			Effect.map((result) => (isPending(result) ? { ...result, ...parent } : result)),
		)

export const bestEffortAfterCommit = <A, E, R>(
	read: Effect.Effect<A, E, R>,
): Effect.Effect<void, E, R> =>
	read.pipe(
		Effect.asVoid,
		Effect.catchDefect((defect) => Effect.logError("Read after commit failed", defect)),
		Effect.catchIf(Predicate.isTagged("ConsistencyTimeout"), () => Effect.void),
	)

type SettledFailure<E> =
	| { readonly confirmed: true; readonly error: E }
	| { readonly confirmed: false; readonly error: HandlerError }

export const settled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.result(
		effect.pipe(
			Effect.mapError((error): SettledFailure<E> => ({ confirmed: true, error })),
			Effect.catchDefect((defect) =>
				Effect.andThen(
					Effect.logError("Command failed unexpectedly", defect),
					Effect.flatMap(currentRequestId, (request_id) =>
						Effect.fail<SettledFailure<E>>({
							confirmed: false,
							error: apiError(500, "Internal server error.", request_id),
						}),
					),
				),
			),
		),
	)

export const commitForStream = (
	commits: ReadonlyArray<{ readonly stream: string; readonly version: number }>,
	stream: string,
) => commits.find((commit) => commit.stream === stream)

const utf8Encoder = new TextEncoder()

export const randomId = (random: SecureRandom.SecureRandom["Service"], prefix: string) =>
	Effect.map(random.randomBytes(12), (bytes) => `${prefix}_${Hex.encode(bytes)}`)

const stringifyCanonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => (entry === undefined ? "null" : stringifyCanonicalJson(entry))).join(",")}]`
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stringifyCanonicalJson(entry)}`).join(",")}}`
	}
	return JSON.stringify(value)
}

export const sha256Json = (
	digest: Digest.Digest["Service"],
	value: unknown,
): Effect.Effect<string> =>
	digest.digestHex(Digest.sha256, utf8Encoder.encode(JSON.stringify(value)))

export const idempotentId = (
	digest: Digest.Digest["Service"],
	prefix: string,
	scope: ReadonlyArray<unknown>,
): Effect.Effect<string> => Effect.map(sha256Json(digest, scope), (hash) => `${prefix}_${hash}`)

export const idempotentCommandId = (
	digest: Digest.Digest["Service"],
	prefix: string,
	scope: ReadonlyArray<unknown>,
): Effect.Effect<string> => Effect.map(sha256Json(digest, scope), (hash) => `${prefix}:${hash}`)

export const reusedKey = reject(409, "Idempotency-Key was already used for a different request.", {
	code: ERROR_CODES.idempotencyKeyReused,
})

export const createCommandId = (
	digest: Digest.Digest["Service"],
	resource: PendingResourceType,
	idempotencyKey: string,
	payload: unknown,
) =>
	idempotentCommandId(digest, `create-${resource}`, [
		"create",
		resource,
		idempotencyKey,
		stringifyCanonicalJson(
			payload !== null && typeof payload === "object" && !Array.isArray(payload)
				? Object.fromEntries(
						Object.entries(payload).filter(
							([, value]) => !(Array.isArray(value) && value.length === 0),
						),
					)
				: payload,
		),
	])

export const createIdentity = (
	digest: Digest.Digest["Service"],
	random: SecureRandom.SecureRandom["Service"],
	create: {
		readonly resource: PendingResourceType
		readonly prefix: string
		readonly key: string | undefined
		readonly body: unknown
		readonly scope?: ReadonlyArray<string>
	},
): Effect.Effect<{
	readonly id: string
	readonly options: { readonly commandId: string } | undefined
}> =>
	Effect.gen(function* () {
		if (create.key === undefined) {
			return { id: yield* randomId(random, create.prefix), options: undefined }
		}
		const id = yield* idempotentId(digest, create.prefix, [
			"create",
			create.resource,
			"id",
			...(create.scope ?? []),
			create.key,
		])
		return {
			id,
			options: {
				commandId: yield* createCommandId(digest, create.resource, create.key, create.body),
			},
		}
	})

export const readExisting = <S, E1, R1, E2, R2, E3, R3>(options: {
	readonly current: Effect.Effect<Option.Option<S | null>, E1, R1>
	readonly missing: Effect.Effect<void, E2, R2>
	readonly projected: Effect.Effect<S | null, E3, R3>
	readonly missingFirst?: boolean
}) =>
	Effect.gen(function* () {
		if (options.missingFirst === true) {
			yield* options.missing
		}
		const found = Option.getOrNull(yield* options.current)
		if (found !== null) {
			return found
		}
		yield* options.missing
		const projected = yield* options.projected.pipe(Effect.tapError(() => options.missing))
		return projected ?? (yield* Effect.die(new Error("A view wait matched no row.")))
	})

export const archiveAndRead = <const T extends PendingResourceType, Receipt, S, E1, R1, E2, R2>(
	id: string,
	type: T,
	label: string,
	archive: Effect.Effect<Receipt, E1, R1>,
	read: (receipt: Receipt) => Effect.Effect<Option.Option<S | null>, E2, R2>,
) =>
	Effect.gen(function* () {
		const result = yield* read(yield* archive).pipe(orPending(id, type))
		if (isPending(result)) {
			return result
		}
		return yield* present(result, 404, `${label} ${id} not found.`)
	})

const prepareConfiguredCredential = (mac: Mac.Mac["Service"], secret: Redacted.Redacted<string>) =>
	Effect.gen(function* () {
		const key = yield* mac.generateKey(Mac.hmacSha256)
		const tag = yield* mac.sign(key, utf8Encoder.encode(Redacted.value(secret)))
		return { key, tag }
	}).pipe(Effect.orDie)

export const AuthenticationLive = Layer.effect(
	Authentication,
	Effect.gen(function* () {
		const mac = yield* Mac.Mac
		const secret = yield* optionalSecret("CHECKFU_API_KEY").pipe(Effect.orDie)
		const configured = secret === null ? null : yield* prepareConfiguredCredential(mac, secret)
		const guard = <A, E, R>(
			handler: Effect.Effect<A, E, R>,
			credential: Redacted.Redacted<string>,
		): Effect.Effect<A, E | (typeof ERRORS)[401 | 503]["Type"], R> =>
			Effect.gen(function* () {
				if (configured === null) {
					return yield* reject(503, "API authentication is not configured. Set CHECKFU_API_KEY.")
				}
				const valid = yield* mac
					.verify(configured.key, configured.tag, utf8Encoder.encode(Redacted.value(credential)))
					.pipe(Effect.orDie)
				if (!valid) {
					return yield* reject(401, "Invalid or missing API key.")
				}
				return yield* handler
			})
		return {
			bearer: (handler, { credential }) => guard(handler, credential),
			apiKey: (handler, { credential }) => guard(handler, credential),
		}
	}),
)

export const AgentBodyLimitLive = Layer.succeed(AgentBodyLimit, (httpEffect) =>
	Effect.provideService(
		httpEffect,
		HttpIncomingMessage.MaxBodySize,
		ByteSize.bytes(MAX_AGENT_BODY_BYTES),
	),
)

export const MemoryBodyLimitLive = Layer.succeed(MemoryBodyLimit, (httpEffect) =>
	Effect.provideService(
		httpEffect,
		HttpIncomingMessage.MaxBodySize,
		ByteSize.bytes(MAX_MEMORY_BODY_BYTES),
	),
)

export const SessionBodyLimitLive = Layer.succeed(SessionBodyLimit, (httpEffect) =>
	Effect.provideService(
		httpEffect,
		HttpIncomingMessage.MaxBodySize,
		ByteSize.bytes(MAX_SESSION_BODY_BYTES),
	),
)

export const EventBatchBodyLimitLive = Layer.succeed(EventBatchBodyLimit, (httpEffect) =>
	Effect.provideService(
		httpEffect,
		HttpIncomingMessage.MaxBodySize,
		ByteSize.bytes(MAX_EVENTS_BODY_BYTES),
	),
)
export const ARTIFACT_BODY_TOO_LARGE_MESSAGE =
	'Request body is too large. Send large or heavily escaped file content with "encoding": "base64".'

const isBodyTooLarge = (defect: unknown): boolean =>
	HttpServerError.isHttpServerError(defect) &&
	defect.reason._tag === "RequestParseError" &&
	defect.reason.reason === "BodyTooLarge"

export const ArtifactBodyLimitLive = Layer.succeed(ArtifactBodyLimit, (httpEffect) =>
	httpEffect.pipe(
		Effect.catchDefect((defect) =>
			isBodyTooLarge(defect) ? reject(413, ARTIFACT_BODY_TOO_LARGE_MESSAGE) : Effect.die(defect),
		),
		Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_ARTIFACT_BODY_BYTES)),
	),
)

export const ArtifactBlobLimitLive = Layer.succeed(ArtifactBlobLimit, (httpEffect) =>
	httpEffect.pipe(
		Effect.catchDefect((defect) =>
			isBodyTooLarge(defect)
				? reject(413, `An upload may be at most ${MAX_ARTIFACT_FILE_BYTES} bytes.`)
				: Effect.die(defect),
		),
		Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_ARTIFACT_FILE_BYTES)),
	),
)

export const FileBodyLimitLive = Layer.succeed(FileBodyLimit, (httpEffect) =>
	httpEffect.pipe(
		Effect.catchDefect((defect) =>
			isBodyTooLarge(defect)
				? reject(413, `A file may be at most ${MAX_FILE_BYTES} bytes.`)
				: Effect.die(defect),
		),
		Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_FILE_BYTES)),
	),
)

export const RequestValidationLive = HttpApiMiddleware.layerSchemaErrorTransform(
	RequestValidation,
	(error) => {
		if (error.kind === "Body" || error.kind === "ResponseHeaders") {
			return Effect.andThen(
				Effect.logError("Response encoding failed", error.cause),
				reject(500, "Internal server error."),
			)
		}
		return reject(400, error.cause.message)
	},
)

export const errorResponse = (error: ApiError) =>
	HttpServerResponse.json(error, { status: statusOf(error) }).pipe(Effect.orDie)

export const requestPath = (request: HttpServerRequest.HttpServerRequest): string => {
	const raw = request.url
	if (!raw.startsWith("/")) {
		const parsed = HttpServerRequest.toURL(request)
		if (Option.isSome(parsed)) {
			return parsed.value.pathname
		}
	}
	const queryIndex = raw.indexOf("?")
	const hashIndex = raw.indexOf("#")
	const end =
		queryIndex === -1 ? hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex)
	const target = end === -1 ? raw : raw.slice(0, end)
	return target.length > 0 ? target : "/"
}
