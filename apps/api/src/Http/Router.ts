import * as ByteSize from "effect/ByteSize"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Etag from "effect/http/Etag"
import * as HttpBody from "effect/http/HttpBody"
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage"
import * as HttpMiddleware from "effect/http/HttpMiddleware"
import * as HttpPlatform from "effect/http/HttpPlatform"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerError from "effect/http/HttpServerError"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as References from "effect/References"
import * as Stream from "effect/Stream"
import { AgentsLive } from "./AgentsHandlers.ts"
import { AutomationsLive } from "./AutomationsHandlers.ts"
import { CheckfuApi, REQUEST_ID_HEADER, RequestId, apiError } from "./Api.ts"
import { ArtifactsLive } from "./ArtifactsHandlers.ts"
import { FilesLive } from "./FilesHandlers.ts"
import { EnvironmentsLive } from "./EnvironmentsHandlers.ts"
import {
	AgentBodyLimitLive,
	FileBodyLimitLive,
	ArtifactBodyLimitLive,
	AuthenticationLive,
	EventBatchBodyLimitLive,
	MemoryBodyLimitLive,
	SessionBodyLimitLive,
	MAX_REQUEST_BODY_BYTES,
	RequestValidationLive,
	errorResponse,
	randomId,
	requestPath,
} from "./HttpHelpers.ts"
import { MemoryStoresLive } from "./MemoryStoresHandlers.ts"
import { SessionsLive } from "./SessionsHandlers.ts"
import { VaultsLive } from "./VaultsHandlers.ts"
import { WebhooksLive } from "./WebhooksHandlers.ts"

export { AgentVersionWaitTimeout, IsSupportedAgentModel } from "./AgentsHandlers.ts"
export { ArtifactReadWaitTimeout } from "./ArtifactsHandlers.ts"
export { EnvironmentReadWaitTimeout } from "./EnvironmentsHandlers.ts"
export {
	DEFAULT_SSE_KEEPALIVE_INTERVAL,
	DEFAULT_SSE_MAX_CONNECTION_DURATION,
	SSE_CATCHUP_PAGE_SIZE,
	SessionReadWaitTimeout,
	SseKeepaliveInterval,
	SseMaxConnectionDuration,
} from "./SessionsHandlers.ts"
export { VaultReadWaitTimeout } from "./VaultsHandlers.ts"

const HealthLive = HttpApiBuilder.group(CheckfuApi, "health", (handlers) =>
	handlers.handle("health", () => Effect.succeed({ status: "ok" as const })),
)

const AuthLive = HttpApiBuilder.group(CheckfuApi, "auth", (handlers) =>
	handlers.handle("verify", () => Effect.succeed({ type: "authentication_verified" as const })),
)

export const HealthTracerDisabledWhen: Layer.Layer<never> = Layer.succeed(
	HttpMiddleware.TracerDisabledWhen,
	(request) => requestPath(request) === "/health",
)

const isPublicPath = (path: string): boolean => path === "/health" || path === "/openapi.json"

const withCachePolicy = (path: string, response: HttpServerResponse.HttpServerResponse) => {
	if (isPublicPath(path)) {
		return response
	}
	const existing = response.headers["cache-control"]
	if (existing !== undefined && /\bno-store\b/i.test(existing)) {
		return response
	}
	return HttpServerResponse.setHeader(
		response,
		"cache-control",
		existing === undefined || existing.length === 0 ? "no-store" : `${existing}, no-store`,
	)
}

const ApiLive = Layer.mergeAll(HttpApiBuilder.layer(CheckfuApi)).pipe(
	Layer.provide([
		HealthLive,
		AuthLive,
		AgentsLive,
		EnvironmentsLive,
		SessionsLive,
		AutomationsLive,
		ArtifactsLive,
		FilesLive,
		VaultsLive,
		WebhooksLive,
		MemoryStoresLive,
	]),
	Layer.provide([
		AuthenticationLive.pipe(Layer.provide(Mac.layerWebCrypto)),
		RequestValidationLive,
		AgentBodyLimitLive,
		FileBodyLimitLive,
		ArtifactBodyLimitLive,
		EventBatchBodyLimitLive,
		MemoryBodyLimitLive,
		SessionBodyLimitLive,
	]),
	Layer.provide(HttpPlatform.layer),
	Layer.provide([Etag.layerWeak, FileSystem.layerNoop({}), Path.layer]),
)

export const makeApiHandler = Effect.gen(function* () {
	const random = yield* SecureRandom.SecureRandom
	const buildLogAnnotations = yield* References.CurrentLogAnnotations
	const buildApp = HttpRouter.toHttpEffect(ApiLive).pipe(
		Effect.provideService(HttpRouter.RouterConfig, { maxParamLength: Number.MAX_SAFE_INTEGER }),
	)
	const app = yield* Effect.updateContext(
		buildApp,
		(context: Context.Context<Effect.Services<typeof buildApp>>) =>
			Context.omit(References.CurrentLogAnnotations)(context),
	)

	const fetch = Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		const path = requestPath(request)
		const requestId = RequestId.make(yield* randomId(random, "req"))
		const callerLogAnnotations = yield* References.CurrentLogAnnotations
		const requestLogAnnotations = {
			...buildLogAnnotations,
			...callerLogAnnotations,
			request_id: requestId,
		}
		yield* Effect.annotateCurrentSpan({ "request.id": requestId })
		return yield* app.pipe(
			Effect.flatMap((response) => {
				if (response.status === 401 && response.headers["www-authenticate"] === undefined) {
					return Effect.succeed(
						HttpServerResponse.setHeader(response, "www-authenticate", "Bearer"),
					)
				}
				if (
					response.status === 415 &&
					!(response.headers["content-type"] ?? "").includes("application/json")
				) {
					return errorResponse(
						apiError(
							415,
							`Unsupported Content-Type "${request.headers["content-type"] ?? ""}". Expected application/json.`,
							requestId,
						),
					)
				}
				return Effect.succeed(response)
			}),
			Effect.provideService(
				HttpIncomingMessage.MaxBodySize,
				ByteSize.bytes(MAX_REQUEST_BODY_BYTES),
			),
			Effect.scoped,
			Effect.catchCause((cause) => {
				const error = Cause.squash(cause)
				const reason = HttpServerError.isHttpServerError(error) ? error.reason : undefined
				if (reason?._tag === "RouteNotFound") {
					return errorResponse(
						apiError(404, `Route ${request.method} ${path} not found.`, requestId),
					)
				}
				if (reason?._tag === "RequestParseError") {
					return errorResponse(
						reason.reason === "BodyTooLarge"
							? apiError(413, "Request body is too large.", requestId)
							: apiError(400, "Request body must be valid JSON.", requestId),
					)
				}
				return Effect.andThen(
					Effect.logError("Unhandled API failure", cause),
					errorResponse(apiError(500, "Internal server error.", requestId)),
				)
			}),
			Effect.map((response) => {
				const withHeaders = HttpServerResponse.setHeader(
					withCachePolicy(path, response),
					REQUEST_ID_HEADER,
					requestId,
				)
				return withHeaders.body._tag === "Stream"
					? HttpServerResponse.setBody(
							withHeaders,
							HttpBody.stream(
								Stream.updateService(
									withHeaders.body.stream,
									References.CurrentLogAnnotations,
									(annotations) => ({
										...buildLogAnnotations,
										...callerLogAnnotations,
										...annotations,
										request_id: requestId,
									}),
								),
								withHeaders.body.contentType,
								withHeaders.body.contentLength,
							),
						)
					: withHeaders
			}),
			Effect.annotateLogs(requestLogAnnotations),
		)
	})

	return { fetch }
})
