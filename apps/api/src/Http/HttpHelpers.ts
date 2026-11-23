import {
	MAX_AGENT_DESCRIPTION_LENGTH,
	MAX_AGENT_NAME_LENGTH,
	MAX_AGENT_SYSTEM_LENGTH,
} from "@checkfu/domain/Agent/AgentTypes"
import type { AgentModel } from "@checkfu/domain/Agent/AgentTypes"
import type { EnvironmentConfig } from "@checkfu/domain/Environment/EnvironmentTypes"
import { MAX_MESSAGE_TEXT_LENGTH } from "@checkfu/domain/Session/SessionTypes"
import * as ByteSize from "effect/ByteSize"
import * as Digest from "effect/crypto/Digest"
import * as Mac from "effect/crypto/Mac"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware"
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as References from "effect/References"
import { ClaimIdempotencyKey } from "@checkfu/domain/IdempotencyClaim/ClaimIdempotencyKey.command"
import { IdempotencyClaimId } from "@checkfu/domain/IdempotencyClaim/IdempotencyClaim.id"
import type { IdempotencyClaim } from "@checkfu/domain/IdempotencyClaim/IdempotencyClaim.aggregate"
import { optionalSecret } from "../Secrets.ts"
import {
	AgentBodyLimit,
	Authentication,
	EventBatchBodyLimit,
	RequestId,
	RequestValidation,
	apiError,
	parseHandlerError,
	redactApiErrorEnvelope,
	statusOf,
} from "./Api.ts"
import type { ApiError, ERRORS, ErrorStatus, HandlerError, HandlerErrorStatus } from "./Api.ts"

export const MAX_REQUEST_BODY_BYTES = 160 * 1024
export const MAX_AGENT_BODY_BYTES =
	(MAX_AGENT_NAME_LENGTH + MAX_AGENT_DESCRIPTION_LENGTH + MAX_AGENT_SYSTEM_LENGTH) * 12 + 16 * 1024
export const MAX_EVENTS_BODY_BYTES = 8 * MAX_MESSAGE_TEXT_LENGTH * 6 + 16 * 1024

export const DEFAULT_ENVIRONMENT_CONFIG: EnvironmentConfig = {
	type: "cloud",
	networking: { type: "unrestricted" },
}

const errorStatusOfRejection = (status: number): HandlerErrorStatus | undefined => {
	switch (status) {
		case 404:
			return 404
		case 409:
			return 409
		case 429:
			return 429
		default:
			return undefined
	}
}

interface RejectionAnnotationInfo {
	readonly httpApiStatus?: number
	readonly description?: string
}

const rejectionAnnotationInfo = (err: unknown): RejectionAnnotationInfo | undefined => {
	if (typeof err !== "object" || err === null) {
		return undefined
	}
	const ctor: unknown = "constructor" in err ? err.constructor : undefined
	if ((typeof ctor !== "function" && typeof ctor !== "object") || ctor === null) {
		return undefined
	}
	if (!("annotations" in ctor)) {
		return undefined
	}
	const annotations = ctor.annotations
	if (typeof annotations !== "object" || annotations === null) {
		return undefined
	}
	const httpApiStatus =
		"httpApiStatus" in annotations && typeof annotations.httpApiStatus === "number"
			? annotations.httpApiStatus
			: undefined
	const description =
		"description" in annotations && typeof annotations.description === "string"
			? annotations.description
			: undefined
	return {
		...(httpApiStatus === undefined ? {} : { httpApiStatus }),
		...(description === undefined ? {} : { description }),
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
			return apiError(status, rejection.description ?? "Request rejected.", request_id)
		}
	}
	if (Predicate.isTagged(err, "ConsistencyTimeout") || Predicate.isTagged(err, "WaitTimeout")) {
		return apiError(503, "Timed out waiting for view consistency.", request_id)
	}
	return apiError(500, "Internal server error.", request_id)
}

export const reject = <S extends ErrorStatus>(status: S, message: string) =>
	Effect.flatMap(currentRequestId, (request_id) =>
		Effect.fail(apiError(status, message, request_id)),
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

export interface Pending<
	T extends "agent" | "environment" | "session" = "agent" | "environment" | "session",
> {
	readonly id: string
	readonly type: T
	readonly pending: true
}

export const isPending = (value: unknown): value is Pending =>
	typeof value === "object" && value !== null && "pending" in value

export const orPending =
	<const T extends "agent" | "environment" | "session">(id: string, type: T) =>
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

export const normalizeModel = (input: string | AgentModel): AgentModel =>
	typeof input === "string" ? { id: input } : input

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

export const idempotencyClaimId = (
	digest: Digest.Digest["Service"],
	prefix: string,
	scope: ReadonlyArray<unknown>,
): Effect.Effect<IdempotencyClaimId> =>
	Effect.map(sha256Json(digest, scope), (hash) => IdempotencyClaimId.make(`${prefix}_${hash}`))

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

export const createClaimId = (
	digest: Digest.Digest["Service"],
	resource: "agent" | "environment" | "session",
	idempotencyKey: string,
) => idempotencyClaimId(digest, "cr", ["create", resource, idempotencyKey])

export const createFingerprint = (digest: Digest.Digest["Service"], payload: unknown) =>
	digest.digestHex(Digest.sha256, utf8Encoder.encode(stringifyCanonicalJson(payload)))

export const createCommandId = (
	digest: Digest.Digest["Service"],
	resource: "agent" | "environment" | "session",
	idempotencyKey: string,
) => idempotentCommandId(digest, `create-${resource}`, ["create", resource, idempotencyKey])

export const claimIdempotency = (
	idempotencyClaims: Effect.Success<typeof IdempotencyClaim>,
	batchId: IdempotencyClaimId,
	fingerprint: string,
) =>
	idempotencyClaims.send(new ClaimIdempotencyKey({ claim_id: batchId, fingerprint }), {
		commandId: `claim:${batchId}:${fingerprint}`,
	})

export const claimCreate = (
	idempotencyClaims: Effect.Success<typeof IdempotencyClaim>,
	digest: Digest.Digest["Service"],
	resource: "agent" | "environment" | "session",
	idempotencyKey: string,
	payload: unknown,
) =>
	Effect.gen(function* () {
		const claimId = yield* createClaimId(digest, resource, idempotencyKey)
		const fingerprint = yield* createFingerprint(digest, payload)
		yield* claimIdempotency(idempotencyClaims, claimId, fingerprint)
		return yield* createCommandId(digest, resource, idempotencyKey)
	})

// Ephemeral-keyed HMAC-SHA-256 verification via `Mac.Mac` (`Mac.layerWebCrypto`)
// delegates tag comparison to native `crypto.subtle.verify("HMAC", ...)` instead
// of a JavaScript byte loop (`Mac.timingSafeEqual`), keeping arbitrary-length
// credential checks constant-time without depending on `node:crypto`.
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

export const EventBatchBodyLimitLive = Layer.succeed(EventBatchBodyLimit, (httpEffect) =>
	Effect.provideService(
		httpEffect,
		HttpIncomingMessage.MaxBodySize,
		ByteSize.bytes(MAX_EVENTS_BODY_BYTES),
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
