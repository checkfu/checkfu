import * as ByteSize from "effect/ByteSize"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Etag from "effect/http/Etag"
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage"
import * as HttpPlatform from "effect/http/HttpPlatform"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerError from "effect/http/HttpServerError"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { AgentsLive } from "./AgentsHandlers.ts"
import { CheckfuApi, apiError } from "./Api.ts"
import { EnvironmentsLive } from "./EnvironmentsHandlers.ts"
import {
	AuthenticationLive,
	EventBatchBodyLimitLive,
	MAX_REQUEST_BODY_BYTES,
	RequestValidationLive,
	errorResponse,
	requestPath,
} from "./HttpHelpers.ts"
import { SessionsLive } from "./SessionsHandlers.ts"

export { AgentVersionWaitTimeout } from "./AgentsHandlers.ts"
export { EnvironmentPartialUpdateWaitTimeout } from "./EnvironmentsHandlers.ts"
export {
	DEFAULT_SSE_KEEPALIVE_MS,
	DEFAULT_SSE_MAX_CONNECTION_MS,
	SSE_CATCHUP_PAGE_SIZE,
	SessionReadWaitTimeout,
	SseKeepaliveMs,
	SseMaxConnectionMs,
} from "./SessionsHandlers.ts"

const HealthLive = HttpApiBuilder.group(CheckfuApi, "health", (handlers) =>
	handlers.handle("health", () => Effect.succeed({ status: "ok" as const })),
)

const isPublicPath = (path: string): boolean => path === "/health" || path === "/openapi.json"

const withCachePolicy = (path: string, response: HttpServerResponse.HttpServerResponse) => {
	if (isPublicPath(path)) return response
	const existing = response.headers["cache-control"]
	if (existing !== undefined && /\bno-store\b/i.test(existing)) return response
	return HttpServerResponse.setHeader(
		response,
		"cache-control",
		existing === undefined || existing.length === 0 ? "no-store" : `${existing}, no-store`,
	)
}

const ApiLive = HttpApiBuilder.layer(CheckfuApi, { openapiPath: "/openapi.json" }).pipe(
	Layer.provide([HealthLive, AgentsLive, EnvironmentsLive, SessionsLive]),
	Layer.provide([AuthenticationLive, RequestValidationLive, EventBatchBodyLimitLive]),
	Layer.provide(HttpPlatform.layer),
	Layer.provide([Etag.layerWeak, FileSystem.layerNoop({}), Path.layer]),
)

export const makeApiHandler = Effect.gen(function* () {
	// Acquire the router layer in the caller's Scope (the owning Worker build scope
	// in production, or Effect.scoped in tests) so router finalizers run on disposal.
	// Enforce per-resource ID limits in each route's parameter schema rather than
	// rejecting long stored AgentId/EnvironmentId values with a route-level 404.
	const app = yield* HttpRouter.toHttpEffect(ApiLive).pipe(
		Effect.provideService(HttpRouter.RouterConfig, { maxParamLength: Number.MAX_SAFE_INTEGER }),
	)

	const fetch = Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		const path = requestPath(request)
		return yield* app.pipe(
			Effect.flatMap((response) => {
				if (response.status === 401 && response.headers["www-authenticate"] === undefined) {
					return Effect.succeed(
						withCachePolicy(
							path,
							HttpServerResponse.setHeader(response, "www-authenticate", "Bearer"),
						),
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
						),
					).pipe(Effect.map((res) => withCachePolicy(path, res)))
				}
				return Effect.succeed(withCachePolicy(path, response))
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
					return errorResponse(apiError(404, `Route ${request.method} ${path} not found.`)).pipe(
						Effect.map((res) => withCachePolicy(path, res)),
					)
				}
				if (reason?._tag === "RequestParseError") {
					return errorResponse(
						reason.reason === "BodyTooLarge"
							? apiError(413, "Request body is too large.")
							: apiError(400, "Request body must be valid JSON."),
					).pipe(Effect.map((res) => withCachePolicy(path, res)))
				}
				return Effect.andThen(
					Effect.logError("Unhandled API failure", cause),
					errorResponse(apiError(500, "Internal server error.")).pipe(
						Effect.map((res) => withCachePolicy(path, res)),
					),
				)
			}),
		)
	})

	return { fetch }
})
