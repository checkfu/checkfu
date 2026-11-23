import * as McpProtocol from "effect/ai/McpProtocol"
import * as McpServer from "effect/ai/McpServer"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpEffect from "effect/http/HttpEffect"
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { GENERATED_API_VERSION, GENERATED_TOOLS } from "./generated/Tools.ts"
import {
	ApiBinding,
	CheckfuApiClient,
	credentialHeaders,
	hasCredential,
	makeToolHandler,
} from "./GeneratedRuntime.ts"
import type { GeneratedToolDescriptor } from "./GeneratedRuntime.ts"

export const MCP_PATH = "/mcp"

const INSTRUCTIONS = [
	"Checkfu runs managed agents. Each tool is one Checkfu API operation and returns its JSON response.",
	"Create an agent and an environment, start a session that pairs them, then send user events to the session and list its events to read the agent's replies.",
].join(" ")

const toTool = (descriptor: GeneratedToolDescriptor) =>
	Tool.dynamic(descriptor.name, {
		description: descriptor.description,
		parameters: descriptor.inputSchema,
		failure: Schema.Json,
	})
		.annotate(Tool.Title, descriptor.title)
		.annotate(Tool.Readonly, descriptor.readOnly)
		.annotate(Tool.Destructive, descriptor.destructive)
		.annotate(Tool.Idempotent, descriptor.readOnly)

const CheckfuToolkit = Toolkit.make(...GENERATED_TOOLS.map(toTool))

const HandlersLive = CheckfuToolkit.toLayer(
	Effect.map(CheckfuApiClient, (client) =>
		Object.fromEntries(
			GENERATED_TOOLS.map((descriptor) => [descriptor.name, makeToolHandler(client, descriptor)]),
		),
	),
)

const HEALTH_PATH = "/health"

const HealthLive = HttpRouter.add("GET", HEALTH_PATH, HttpServerResponse.json({ status: "ok" }))

const McpLive = Layer.mergeAll(
	McpServer.layerHttpRequestScoped({
		name: "checkfu",
		version: GENERATED_API_VERSION,
		instructions: INSTRUCTIONS,
		path: MCP_PATH,
		protocols: [McpProtocol.v2026_07_28],
		registrations: McpServer.toolkit(CheckfuToolkit).pipe(Layer.provide(HandlersLive)),
	}),
	HealthLive,
)

// The API is addressed by path only; a service binding ignores the origin.
const API_ORIGIN = "https://api.checkfu.internal"

// A protected route for a resource that does not exist, as the CLI uses to check a key: the
// API answers 401 to a credential it rejects and 404 to one it accepts.
export const CREDENTIAL_PROBE_PATH = "/v1/agents/agent_unknown"

const errorResponse = (
	status: number,
	type: string,
	message: string,
	headers?: Record<string, string>,
) =>
	Effect.orDie(
		HttpServerResponse.json(
			{ type: "error", error: { type, message } },
			{ status, headers: { "cache-control": "no-store", ...headers } },
		),
	)

const unauthorizedResponse = errorResponse(
	401,
	"authentication_error",
	"Invalid or missing API key.",
	{ "www-authenticate": "Bearer" },
)

// Largest API request body (an agent with a full system prompt) plus the JSON-RPC envelope.
export const MAX_MCP_BODY_BYTES = 2 * 1024 * 1024

// Everything but the health check needs a credential, so no spelling of a route that the
// router accepts can reach a handler without one.
const admission = <E, R>(
	app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	E,
	R | HttpServerRequest.HttpServerRequest | ApiBinding
> =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		// Compared as written: the health check is exempt only under its exact spelling.
		const isHealthCheck = request.url === HEALTH_PATH || request.url.startsWith(`${HEALTH_PATH}?`)
		const api = yield* ApiBinding
		if (!isHealthCheck) {
			// The API is the authenticator: nothing is read or answered until it has accepted
			// this request's credential. A missing credential is refused without asking it.
			if (!hasCredential(request.headers)) {
				return yield* unauthorizedResponse
			}
			const probe = yield* Effect.tryPromise({
				try: async () => {
					const response = await api.fetch(`${API_ORIGIN}${CREDENTIAL_PROBE_PATH}`, {
						headers: credentialHeaders(request.headers),
					})
					await response.body?.cancel()
					return response.status
				},
				catch: () => "unreachable" as const,
			}).pipe(Effect.orElseSucceed(() => undefined))
			if (probe === 401) {
				return yield* unauthorizedResponse
			}
			if (probe === undefined) {
				return yield* errorResponse(503, "service_unavailable", "The Checkfu API is unreachable.")
			}
		}
		const bodyLimit = Effect.provideService(
			HttpIncomingMessage.MaxBodySize,
			ByteSize.bytes(MAX_MCP_BODY_BYTES),
		)
		// The body is read here, once and within the limit, so an oversized request is refused as
		// one however it is framed. The transport's own read reuses this result.
		const oversized = yield* request.text.pipe(
			Effect.as(false),
			Effect.catch((error) =>
				Effect.succeed(
					error.reason._tag === "RequestParseError" && error.reason.reason === "BodyTooLarge",
				),
			),
			bodyLimit,
		)
		if (oversized) {
			return yield* errorResponse(413, "payload_too_large", "Request body is too large.")
		}
		return yield* app.pipe(
			Effect.provideService(FetchHttpClient.Fetch, (input, init) => api.fetch(input, init)),
			bodyLimit,
			// Same storage rule as the API these responses come from. The response is written
			// before this middleware resumes, so the header is set through the response hook.
			isHealthCheck
				? (self) => self
				: HttpEffect.withPreResponseHandler((_, response) =>
						Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
					),
		)
	})

// Built once per isolate. Each request supplies its own ApiBinding, so a call always goes to
// the API the current request is bound to; without one there is nowhere to send it.
export const makeMcpWebHandler = () =>
	HttpRouter.toWebHandler(
		McpLive.pipe(
			Layer.provide(
				Layer.effect(
					CheckfuApiClient,
					Effect.map(
						HttpClient.HttpClient,
						HttpClient.mapRequest(HttpClientRequest.prependUrl(API_ORIGIN)),
					),
				),
			),
			Layer.provide(FetchHttpClient.layer),
			Layer.provide(
				Layer.succeed(FetchHttpClient.Fetch, () =>
					Promise.reject(new Error("No API binding was supplied for this request.")),
				),
			),
		),
		{ middleware: admission, disableLogger: true },
	)
