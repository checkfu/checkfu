import * as Domain from "@alchemy.run/domain"
import { makeApiHandler } from "@checkfu/api/Http/Router"
import { Checkfu, CheckfuHandlersLive } from "@checkfu/domain/Checkfu.model"
import { ListingStore } from "@checkfu/domain/Listing/ListingStore"
import { boundedHarness } from "@checkfu/domain/Session/Harness.external"
import * as McpClient from "effect/ai/McpClient"
import * as McpProtocol from "effect/ai/McpProtocol"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import { ApiBinding } from "../../src/GeneratedRuntime.ts"
import { CREDENTIAL_CHECK_PATH, MCP_PATH, makeMcpWebHandler } from "../../src/Server.ts"

export const TEST_API_KEY = "ck_mcp_test_secret"
export const MCP_ORIGIN = "http://mcp.test"
export const MCP_URL = `${MCP_ORIGIN}${MCP_PATH}`

const toWebRequest = (input: RequestInfo | URL, init?: RequestInit): Request =>
	typeof input === "string" || "href" in input ? new Request(input, init) : input

export const makeTestServer = Effect.gen(function* () {
	const HarnessLive = boundedHarness(
		Effect.succeed({
			runTurn: (args: { readonly input: ReadonlyArray<string> }) =>
				Effect.succeed({
					thinking: null,
					text: `Echo: ${args.input.join(" | ")}`,
					input_tokens: 10,
					output_tokens: 5,
					stop_reason: { type: "end_turn" as const },
				}),
			interrupt: () => Effect.void,
			discardWorkspace: () => Effect.void,
		}),
	)
	const ApiLayer = Checkfu.layer(
		CheckfuHandlersLive.pipe(Layer.provide(ListingStore.memory), Layer.provide(HarnessLive)),
	).pipe(
		Layer.provide(Domain.InMemory),
		Layer.provideMerge(Digest.layerWebCrypto),
		Layer.provideMerge(SecureRandom.layerWebCrypto),
		Layer.provideMerge(
			ConfigProvider.layer(ConfigProvider.fromUnknown({ CHECKFU_API_KEY: TEST_API_KEY })),
		),
	)
	const apiContext = yield* Layer.build(ApiLayer)
	const api = yield* makeApiHandler.pipe(Effect.provide(apiContext))
	const runWithApi = Effect.runPromiseWith(apiContext)

	const apiRequests: Array<Request> = []
	const apiFetch: typeof globalThis.fetch = (input, init) => {
		const request = toWebRequest(input, init)
		// Operation requests only: the credential check that precedes every MCP request is not one.
		if (new URL(request.url).pathname !== CREDENTIAL_CHECK_PATH) {
			apiRequests.push(request.clone())
		}
		return runWithApi(
			api.fetch.pipe(
				Effect.provideService(
					HttpServerRequest.HttpServerRequest,
					HttpServerRequest.fromWeb(request),
				),
				Effect.map((response) => HttpServerResponse.toWeb(response)),
			),
		)
	}

	const mcp = makeMcpWebHandler()
	yield* Effect.addFinalizer(() => Effect.promise(() => mcp.dispose()))

	const fetch = (request: Request, api: ApiBinding["Service"] = { fetch: apiFetch }) =>
		Effect.promise(() => mcp.handler(request, Context.make(ApiBinding, api)))

	const connect = (options?: {
		readonly apiKey?: string
		readonly protocol?: McpProtocol.ProtocolAdapter<McpClient.ProtocolVersion>
	}) =>
		McpClient.make({ name: "checkfu-mcp-test", version: "0.0.0" }).pipe(
			Effect.provideServiceEffect(
				McpClient.Transport,
				McpClient.http({
					url: MCP_URL,
					protocol: options?.protocol ?? McpProtocol.v2026_07_28,
					headers: { authorization: `Bearer ${options?.apiKey ?? TEST_API_KEY}` },
				}),
			),
			Effect.provide(
				FetchHttpClient.layer.pipe(
					Layer.provide(
						Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
							mcp.handler(toWebRequest(input, init), Context.make(ApiBinding, { fetch: apiFetch })),
						),
					),
				),
			),
		)

	return { fetch, connect, apiRequests, apiFetch }
})
