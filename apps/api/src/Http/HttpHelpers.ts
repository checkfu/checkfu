import {
	type AgentModel,
	MAX_AGENT_DESCRIPTION_LENGTH,
	MAX_AGENT_NAME_LENGTH,
	MAX_AGENT_SYSTEM_LENGTH,
} from "@checkfu/agents/AgentTypes"
import type { EnvironmentConfig } from "@checkfu/environments/EnvironmentTypes"
import { MAX_MESSAGE_TEXT_LENGTH } from "@checkfu/sessions/Session/SessionTypes"
import { createHash, timingSafeEqual } from "node:crypto"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware"
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as References from "effect/References"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import { ClaimEventBatch, type EventBatch, EventBatchId } from "../Checkfu.model.ts"
import { optionalSecret } from "../Secrets.ts"
import {
	AgentBodyLimit,
	type ApiError,
	Authentication,
	type ERRORS,
	type ErrorStatus,
	EventBatchBodyLimit,
	type HandlerError,
	type HandlerErrorStatus,
	RequestId,
	RequestValidation,
	apiError,
	statusOf,
} from "./Api.ts"

export const MAX_REQUEST_BODY_BYTES = 160 * 1024
export const MAX_AGENT_BODY_BYTES =
	(MAX_AGENT_NAME_LENGTH + MAX_AGENT_DESCRIPTION_LENGTH + MAX_AGENT_SYSTEM_LENGTH) * 12 + 16 * 1024
export const MAX_EVENTS_BODY_BYTES = 8 * MAX_MESSAGE_TEXT_LENGTH * 6 + 16 * 1024

export const DEFAULT_ENVIRONMENT_CONFIG: EnvironmentConfig = {
	type: "cloud",
	networking: { type: "unrestricted" },
}

const ERROR_STATUS_OF_REJECTION: Readonly<Record<number, HandlerErrorStatus>> = {
	404: 404,
	409: 409,
	429: 429,
}

export const hasTag = (err: unknown, tag: string): boolean =>
	typeof err === "object" && err !== null && "_tag" in err && err._tag === tag

type ApiErrorLike = Omit<HandlerError, "request_id"> & { readonly request_id?: unknown }

const isApiErrorLike = (err: unknown): err is ApiErrorLike =>
	typeof err === "object" &&
	err !== null &&
	"type" in err &&
	err.type === "error" &&
	"error" in err &&
	typeof err.error === "object" &&
	err.error !== null &&
	"type" in err.error &&
	"message" in err.error

const rejectionAnnotations = (
	err: unknown,
): { readonly httpApiStatus?: unknown; readonly description?: unknown } | undefined =>
	typeof err === "object" && err !== null && "annotations" in err.constructor
		? (err.constructor.annotations as {
				readonly httpApiStatus?: unknown
				readonly description?: unknown
			})
		: undefined

export const currentRequestId: Effect.Effect<RequestId> = Effect.flatMap(
	References.CurrentLogAnnotations,
	(annotations) =>
		typeof annotations.request_id === "string" && annotations.request_id.length > 0
			? Effect.succeed(RequestId.make(annotations.request_id))
			: Effect.die(new Error("Missing request_id in log annotations.")),
)

export const toApiError = (err: unknown, request_id: RequestId): HandlerError => {
	if (isApiErrorLike(err)) {
		return { ...err, request_id: RequestId.make(request_id) } as HandlerError
	}
	const annotations = rejectionAnnotations(err)
	const status =
		typeof annotations?.httpApiStatus === "number"
			? ERROR_STATUS_OF_REJECTION[annotations.httpApiStatus]
			: undefined
	if (status !== undefined) {
		return apiError(
			status,
			typeof annotations?.description === "string" ? annotations.description : "Request rejected.",
			request_id,
		)
	}
	if (hasTag(err, "ConsistencyTimeout") || hasTag(err, "WaitTimeout")) {
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

const loggableFailure = (err: unknown): unknown => {
	if (!isApiErrorLike(err)) return err
	return {
		error_type: err.error.type,
		...(err.accepted === undefined ? {} : { accepted_count: err.accepted.length }),
		...(err.failed_index === undefined ? {} : { failed_index: err.failed_index }),
		...(err.unconfirmed_index === undefined ? {} : { unconfirmed_index: err.unconfirmed_index }),
	}
}

export const handled = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, HandlerError, R> =>
	effect.pipe(
		Effect.catch((err) =>
			Effect.flatMap(currentRequestId, (request_id) => {
				const mapped = toApiError(err, request_id)
				return statusOf(mapped) === 500
					? Effect.andThen(
							Effect.logError("Unhandled API failure", loggableFailure(err)),
							Effect.fail(mapped),
						)
					: Effect.fail(mapped)
			}),
		),
	)

export interface Pending {
	readonly id: string
	readonly type: string
	readonly pending: true
}

export const isPending = (value: unknown): value is Pending =>
	typeof value === "object" && value !== null && "pending" in value

export const orPending =
	(id: string, type: string) =>
	<A, E, R>(read: Effect.Effect<A, E, R>): Effect.Effect<A | Pending, E, R> =>
		read.pipe(
			Effect.catchDefect((defect) =>
				Effect.as(Effect.logError("Read after commit failed", defect), {
					id,
					type,
					pending: true as const,
				}),
			),
			Effect.catch((err): Effect.Effect<Pending, E> =>
				hasTag(err, "ConsistencyTimeout") || hasTag(err, "WaitTimeout")
					? Effect.succeed({ id, type, pending: true })
					: Effect.fail(err),
			),
		)

export const bestEffortAfterCommit = <A, E, R>(
	read: Effect.Effect<A, E, R>,
): Effect.Effect<void, E, R> =>
	read.pipe(
		Effect.asVoid,
		Effect.catchDefect((defect) => Effect.logError("Read after commit failed", defect)),
		Effect.catch((err) => (hasTag(err, "ConsistencyTimeout") ? Effect.void : Effect.fail(err))),
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

export const randomId = (random: SecureRandom.SecureRandom["Service"], prefix: string) =>
	Effect.map(
		random.randomBytes(12),
		(bytes) => `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`,
	)

const canonicalize = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalize)
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalize(entry)]))
	}
	return value
}

export const sha256Json = (value: unknown): string =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex")

export const idempotencyClaimId = (prefix: string, scope: ReadonlyArray<unknown>): EventBatchId =>
	EventBatchId.make(`${prefix}_${sha256Json(scope)}`)

export const idempotentId = (prefix: string, scope: ReadonlyArray<unknown>): string =>
	`${prefix}_${sha256Json(scope)}`

export const idempotentCommandId = (prefix: string, scope: ReadonlyArray<unknown>): string =>
	`${prefix}:${sha256Json(scope)}`

export const createClaimId = (
	resource: "agent" | "environment" | "session",
	idempotencyKey: string,
) => idempotencyClaimId("cr", ["create", resource, idempotencyKey])

export const createFingerprint = (payload: unknown) => sha256Json(canonicalize(payload))

export const createCommandId = (
	resource: "agent" | "environment" | "session",
	idempotencyKey: string,
) => idempotentCommandId(`create-${resource}`, ["create", resource, idempotencyKey])

export const claimIdempotency = (
	eventBatches: Effect.Success<typeof EventBatch>,
	batchId: EventBatchId,
	fingerprint: string,
) =>
	eventBatches.send(new ClaimEventBatch({ batch_id: batchId, fingerprint }), {
		commandId: `claim:${batchId}:${fingerprint}`,
	})

export const claimCreate = (
	eventBatches: Effect.Success<typeof EventBatch>,
	resource: "agent" | "environment" | "session",
	idempotencyKey: string,
	payload: unknown,
) =>
	Effect.as(
		claimIdempotency(
			eventBatches,
			createClaimId(resource, idempotencyKey),
			createFingerprint(payload),
		),
		createCommandId(resource, idempotencyKey),
	)

const tokenDigest = (token: string) => createHash("sha256").update(token).digest()

export const AuthenticationLive = Layer.effect(
	Authentication,
	Effect.gen(function* () {
		const configured = yield* optionalSecret("CHECKFU_API_KEY").pipe(
			Effect.map((secret) => (secret === null ? null : tokenDigest(Redacted.value(secret)))),
		)
		const guard = <A, E, R>(
			handler: Effect.Effect<A, E, R>,
			credential: Redacted.Redacted<string>,
		): Effect.Effect<A, E | (typeof ERRORS)[401 | 503]["Type"], R> => {
			if (configured === null) {
				return reject(503, "API authentication is not configured. Set CHECKFU_API_KEY.")
			}
			return timingSafeEqual(tokenDigest(Redacted.value(credential)), configured)
				? handler
				: reject(401, "Invalid or missing API key.")
		}
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
		if (Option.isSome(parsed)) return parsed.value.pathname
	}
	const queryIndex = raw.indexOf("?")
	const hashIndex = raw.indexOf("#")
	const end =
		queryIndex === -1 ? hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex)
	const target = end === -1 ? raw : raw.slice(0, end)
	return target.length > 0 ? target : "/"
}
