import * as Domain from "@alchemy.run/domain"
import { ArtifactBytesKept } from "@checkfu/domain/Artifact/ArtifactBytes.external"
import { SessionOutputsUnpublished } from "@checkfu/domain/Session/SessionOutputs.external"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { makeArtifactStoreMemory } from "@checkfu/api/Artifacts/ArtifactStoreMemory"
import { ArtifactLinksTest } from "@checkfu/api/Content/ArtifactLinks"
import {
	CredentialSecretsLive,
	makeConnectionExecutorLayer,
} from "@checkfu/api/Connection/CredentialCustody"
import { vaultListingQueriesFrom } from "@checkfu/api/Http/Listing"
import { makeApiHandler } from "@checkfu/api/Http/Router"
import { CustomToolFaults } from "@checkfu/api/Http/ToolSchemas"
import { customToolFaults } from "@checkfu/api/Pi/PiToolSchema"
import { SkillReader } from "@checkfu/api/Skills/SkillReader"
import { readSkill } from "@checkfu/api/Skills/ReadSkill"
import { makeWebhooksTestSupport } from "@checkfu/api/Webhooks/WebhookTestLayer"
import { Checkfu, CheckfuHandlersLive } from "@checkfu/domain/Checkfu.model"
import { ListingStore } from "@checkfu/domain/Listing/ListingStore"
import { WebhookEventsNoop } from "@checkfu/domain/Webhook/WebhookEvents.external"
import { boundedHarness } from "@checkfu/domain/Session/Harness.external"
import { Vaults, VaultsHandlersLive } from "@checkfu/domain/Vaults.model"
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

const TEST_RUNTIME = {
	Type: "Test",
	id: "test",
	env: {},
	get: () => Effect.undefined,
	set: (id: string) => Effect.succeed(id),
}
const TestRuntimeContext = Layer.succeed(RuntimeContext, TEST_RUNTIME)

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
			storeRepositoryToken: () => Effect.void,
		}),
	)
	const listingStore = ListingStore.memory
	const webhooksTest = makeWebhooksTestSupport(listingStore)
	const VaultsLive = Vaults.layer(
		VaultsHandlersLive.pipe(Layer.provide(listingStore), Layer.provide(WebhookEventsNoop)),
	).pipe(
		Layer.provideMerge(CredentialSecretsLive),
		Layer.provide(
			makeConnectionExecutorLayer({
				put: () => Effect.succeed({ refused: null }),
				erase: () => Effect.void,
				seal: () => Effect.void,
				usable: () => Effect.succeed(true),
			}),
		),
		Layer.provide(Domain.InMemory),
	)
	const ApiLayer = Layer.mergeAll(
		Layer.succeed(SkillReader, { read: (markdown) => Effect.promise(() => readSkill(markdown)) }),
		Layer.succeed(CustomToolFaults, (tools, taken) =>
			Effect.succeed(customToolFaults(tools, taken)),
		),
		webhooksTest.layer.pipe(Layer.provide(Domain.InMemory)),
		VaultsLive,
		vaultListingQueriesFrom(VaultsLive),
		Checkfu.layer(
			CheckfuHandlersLive.pipe(
				Layer.provide(ArtifactBytesKept),
				Layer.provide(SessionOutputsUnpublished),
				Layer.provide(listingStore),
				Layer.provide(WebhookEventsNoop),
				Layer.provide(HarnessLive),
			),
		).pipe(Layer.provide(Domain.InMemory)),
		Layer.mergeAll(makeArtifactStoreMemory().layer, ArtifactLinksTest).pipe(
			Layer.provide(Domain.InMemory),
		),
		HarnessLive,
	).pipe(
		Layer.provideMerge(Digest.layerWebCrypto),
		Layer.provideMerge(SecureRandom.layerWebCrypto),
		Layer.provideMerge(
			ConfigProvider.layer(ConfigProvider.fromUnknown({ CHECKFU_API_KEY: TEST_API_KEY })),
		),
		Layer.provideMerge(TestRuntimeContext),
	)
	const apiContext = yield* Layer.build(ApiLayer)
	const api = yield* makeApiHandler.pipe(Effect.provide(apiContext))
	const runWithApi = Effect.runPromiseWith(apiContext)

	const apiRequests: Array<Request> = []
	const apiFetch: typeof globalThis.fetch = (input, init) => {
		const request = toWebRequest(input, init)
		if (new URL(request.url).pathname !== CREDENTIAL_CHECK_PATH) {
			apiRequests.push(request.clone())
		}
		return runWithApi(
			api.fetch.pipe(
				Effect.provideService(
					HttpServerRequest.HttpServerRequest,
					HttpServerRequest.fromWeb(request),
				),
				Effect.provideService(RuntimeContext, TEST_RUNTIME),
				Effect.map((response) => HttpServerResponse.toWeb(response)),
			),
		)
	}

	const mcp = makeMcpWebHandler()
	yield* Effect.addFinalizer(() => Effect.promise(() => mcp.dispose()))
	const fetchWeb: typeof globalThis.fetch = (input, init) =>
		mcp.handler(toWebRequest(input, init), Context.make(ApiBinding, { fetch: apiFetch }))

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

	return { fetch, fetchWeb, connect, apiRequests, apiFetch }
})
