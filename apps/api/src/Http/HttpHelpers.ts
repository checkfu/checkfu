import type { AgentModel } from "@checkfu/agents/AgentTypes"
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
import type * as SecureRandom from "effect/crypto/SecureRandom"
import { optionalSecret } from "../Secrets.ts"
import {
	type ApiError,
	Authentication,
	type ERRORS,
	type ErrorStatus,
	EventBatchBodyLimit,
	type HandlerError,
	type HandlerErrorStatus,
	RequestValidation,
	apiError,
	statusOf,
} from "./Api.ts"

export const MAX_REQUEST_BODY_BYTES = 160 * 1024
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

const isApiError = (err: unknown): err is HandlerError =>
	typeof err === "object" && err !== null && "type" in err && err.type === "error" && "error" in err

const rejectionAnnotations = (
	err: unknown,
): { readonly httpApiStatus?: unknown; readonly description?: unknown } | undefined =>
	typeof err === "object" && err !== null && "annotations" in err.constructor
		? (err.constructor.annotations as {
				readonly httpApiStatus?: unknown
				readonly description?: unknown
			})
		: undefined

export const toApiError = (err: unknown): HandlerError => {
	if (isApiError(err)) return err
	const annotations = rejectionAnnotations(err)
	const status =
		typeof annotations?.httpApiStatus === "number"
			? ERROR_STATUS_OF_REJECTION[annotations.httpApiStatus]
			: undefined
	if (status !== undefined) {
		return apiError(
			status,
			typeof annotations?.description === "string" ? annotations.description : "Request rejected.",
		)
	}
	if (hasTag(err, "ConsistencyTimeout") || hasTag(err, "WaitTimeout")) {
		return apiError(503, "Timed out waiting for view consistency.")
	}
	return apiError(500, "Internal server error.")
}

export const reject = <S extends ErrorStatus>(status: S, message: string) =>
	Effect.fail(apiError(status, message))

export const present = <A, S extends HandlerErrorStatus>(
	result: Option.Option<A | null>,
	status: S,
	message: string,
) => {
	const value = Option.getOrNull(result)
	return value === null ? reject(status, message) : Effect.succeed(value)
}

const loggableFailure = (err: unknown): unknown => {
	if (!isApiError(err)) return err
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
		Effect.catch((err) => {
			const mapped = toApiError(err)
			return statusOf(mapped) === 500
				? Effect.andThen(
						Effect.logError("Unhandled API failure", loggableFailure(err)),
						Effect.fail(mapped),
					)
				: Effect.fail(mapped)
		}),
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
					Effect.fail<SettledFailure<E>>({
						confirmed: false,
						error: apiError(500, "Internal server error."),
					}),
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
