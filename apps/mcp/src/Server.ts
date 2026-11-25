import { MAX_ARTIFACT_BODY_BYTES } from "@checkfu/sdk/Schemas"
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
		.annotate(Tool.Idempotent, descriptor.idempotent)

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

const API_ORIGIN = "https://api.checkfu.internal"

export const CREDENTIAL_CHECK_PATH = "/v1/auth/verify"

const isVerified = Schema.is(Schema.Struct({ type: Schema.Literal("authentication_verified") }))

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

const MCP_ENVELOPE_BYTES = 64 * 1024

export const MAX_MCP_BODY_BYTES = Math.max(
	2 * 1024 * 1024,
	MAX_ARTIFACT_BODY_BYTES + MCP_ENVELOPE_BYTES,
)

const admission = <E, R>(
	app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	E,
	R | HttpServerRequest.HttpServerRequest | ApiBinding
> =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		if (
			request.method === "GET" &&
			(request.url === HEALTH_PATH || request.url.startsWith(`${HEALTH_PATH}?`))
		) {
			return yield* app
		}
		const api = yield* ApiBinding
		if (!hasCredential(request.headers)) {
			return yield* unauthorizedResponse
		}
		const verdict = yield* Effect.tryPromise({
			try: async (): Promise<"accepted" | "rejected" | "unverified"> => {
				const response = await api.fetch(`${API_ORIGIN}${CREDENTIAL_CHECK_PATH}`, {
					headers: credentialHeaders(request.headers),
				})
				if (response.status === 200) {
					const body: unknown = await response.json()
					return isVerified(body) ? "accepted" : "unverified"
				}
				await response.body?.cancel()
				return response.status === 401 ? "rejected" : "unverified"
			},
			catch: () => "unverified" as const,
		}).pipe(Effect.orElseSucceed(() => "unverified" as const))
		if (verdict === "rejected") {
			return yield* unauthorizedResponse
		}
		if (verdict === "unverified") {
			return yield* errorResponse(
				503,
				"service_unavailable",
				"The Checkfu API could not verify this credential.",
			)
		}
		const bodyLimit = Effect.provideService(
			HttpIncomingMessage.MaxBodySize,
			ByteSize.bytes(MAX_MCP_BODY_BYTES),
		)
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
			HttpEffect.withPreResponseHandler((_, response) =>
				Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
			),
		)
	})

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
