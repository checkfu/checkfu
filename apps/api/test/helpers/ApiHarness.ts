import { readFileSync } from "node:fs"
import { ArtifactBytesLive } from "../../src/Artifacts/ArtifactBytesLive.ts"
import * as Domain from "@alchemy.run/domain"
import {
	CUSTOM_PROVIDERS_ENV,
	allProviders,
	parseCustomProvidersManifest,
} from "@checkfu/pi-providers/catalog"
import type { ProviderSpec } from "@checkfu/pi-providers/catalog"
import { buildPiProvider, withDynamicModelLookup } from "@checkfu/pi-providers/runtime"
import type { TurnFailed } from "@checkfu/domain/Session/Harness.external"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import type { Api, AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream"
import type { JsonObject, Registry } from "@earendil-works/pi-durable"
import { expect } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Sse from "effect/encoding/Sse"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Schedule from "effect/Schedule"
import { Checkfu, CheckfuHandlersLive } from "@checkfu/domain/Checkfu.model"
import { ArtifactBytesKept } from "@checkfu/domain/Artifact/ArtifactBytes.external"
import { ListingStore } from "@checkfu/domain/Listing/ListingStore"
import { makeCheckfuClientWith } from "../../src/Http/Api.ts"
import { checkCatalogProviderCredentials } from "../../src/Pi/PiCatalog.ts"
import { CustomToolFaults } from "../../src/Http/ToolSchemas.ts"
import { customToolFaults } from "../../src/Pi/PiToolSchema.ts"
import { decodeAgentTools } from "@checkfu/domain/Mcp/McpServers"
import type { CustomTool } from "@checkfu/domain/Mcp/McpServers"
import { defineExtension } from "@earendil-works/pi-durable"
import { actionsExtension, customToolsExtension } from "../../src/Pi/PiActions.ts"
import { mcpRegistry } from "../../src/Pi/PiMcp.ts"
import { createCheckfuRegistry } from "../../src/Pi/PiRefusals.ts"
import {
	AbortGrace,
	abortPiDurableTurn,
	answerPiDurableCall,
	pausePiDurableTurn,
	recoverPiDurableTurn,
	runPiDurableTurn,
} from "../../src/Pi/PiDurableEngine.ts"
import type { PiTurnRequest } from "../../src/Pi/PiTurn.ts"
import {
	HarnessCallFailed,
	HarnessLimits,
	PiDurableHarnessLive,
	harnessCall,
	makePiTurnExecutorLayer,
} from "../../src/Pi/PiDurableHarness.ts"
import { makeSessionOutputs } from "../../src/Workspace/SessionOutputs.ts"
import { makeSessionOutputsPublisher } from "../../src/Artifacts/SessionOutputsLive.ts"
import {
	SessionOutputs,
	SessionOutputsUnpublished,
} from "@checkfu/domain/Session/SessionOutputs.external"
import { makeArtifactStoreMemory } from "../../src/Artifacts/ArtifactStoreMemory.ts"
import { ArtifactLinksTest } from "../../src/Content/ArtifactLinks.ts"
import type { PiTurnExecutor } from "../../src/Pi/PiDurableHarness.ts"
import type { RepositoryMount, WorkspacePreparation } from "../../src/Workspace/WorkspaceShapes.ts"
import { createInMemoryPiDurableBackend } from "./InMemoryPiBackend.ts"
import type { InMemoryPiDurableBackend } from "./InMemoryPiBackend.ts"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import { VaultsTestLive } from "./VaultsHarness.ts"

export const TEST_API_KEY = "ck_test_secret_token"

export const TEST_RUNTIME = {
	Type: "Test",
	id: "test",
	env: {},
	get: () => Effect.undefined,
	set: (id: string) => Effect.succeed(id),
}

export const TestRuntimeContext = Layer.succeed(RuntimeContext, TEST_RUNTIME)

export const AUTH_HEADERS = {
	authorization: `Bearer ${TEST_API_KEY}`,
}

export interface RecordedModelCall {
	readonly provider: string
	readonly modelId: string
	readonly systemPrompt: string | undefined
	readonly messageCount: number
	readonly lastUserText: string
}

export const extractSystemText = (context: TranscriptContext): string =>
	context.messages
		.filter((msg) => msg.role === "system")
		.map((msg) => {
			const base = typeof msg.content === "string" ? msg.content : ""
			const sections =
				"sections" in msg && typeof msg.sections === "object" && msg.sections !== null
					? Object.values(msg.sections as Record<string, string>).join("\n")
					: ""
			return [base, sections].filter((s) => s.length > 0).join("\n")
		})
		.join("\n")

export const extractConversationMessageCount = (context: TranscriptContext): number =>
	context.messages.filter((msg) => msg.role === "user" || msg.role === "assistant").length

export const extractLastUserText = (context: TranscriptContext): string => {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const msg = context.messages[i]
		if (msg?.role === "user") {
			if (typeof msg.content === "string") {
				return msg.content
			}
			return msg.content.map((part) => (part.type === "text" ? part.text : "")).join("")
		}
	}
	return ""
}

export const makeScriptedPiModels = (
	handler: (
		model: Model<Api>,
		context: TranscriptContext,
		signal?: AbortSignal,
	) => Promise<AssistantMessage>,
	customProviders?: ReadonlyArray<ProviderSpec>,
) => {
	const models = createModels({
		authContext: {
			env: () => Promise.resolve("sk-scripted-test"),
			fileExists: () => Promise.resolve(false),
		},
	})

	const streamImpl = (
		model: Model<Api>,
		context: TranscriptContext,
		options?: { readonly signal?: AbortSignal },
	) => {
		const stream = createAssistantMessageEventStream()
		void handler(model, context, options?.signal)
			.then((message) => {
				stream.push({ type: "start", partial: message })
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					stream.push({ type: "error", reason: message.stopReason, error: message })
				} else {
					stream.push({
						type: "done",
						reason: message.stopReason === "length" ? "length" : "stop",
						message,
					})
				}
			})
			.catch((error: unknown) => {
				const errorMsg: AssistantMessage = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: 0,
				}
				stream.push({ type: "error", reason: "error", error: errorMsg })
			})
		return stream
	}

	const testAuth = {
		apiKey: {
			name: "Test API key",
			login: () => Promise.reject(new Error("unused")),
			resolve: () => Promise.resolve({ auth: { apiKey: "sk-test" }, source: "test" }),
		},
	}

	const scriptedStreams = { stream: streamImpl, streamSimple: streamImpl }
	for (const spec of allProviders(customProviders)) {
		models.setProvider(
			buildPiProvider(spec, { env: {} }, { streams: scriptedStreams, auth: testAuth }),
		)
	}
	return withDynamicModelLookup(models, {
		env: {},
		...(customProviders === undefined ? {} : { customProviders }),
	})
}

export interface PauseHook {
	before?: (conversation: string) => Effect.Effect<void>
}

export interface TestMcpTool {
	readonly server: string
	readonly name: string
	readonly readOnly?: boolean
	readonly parameters?: JsonObject
	readonly run: (args: unknown) => string | Promise<string>
}

export const checkfuWithHarness = <E, R>(
	executor: Layer.Layer<PiTurnExecutor, E, R>,
	harness = PiDurableHarnessLive,
) => {
	const hosted = Checkfu.layer(
		CheckfuHandlersLive.pipe(
			Layer.provide(ArtifactBytesKept),
			Layer.provide(SessionOutputsUnpublished),
			Layer.provide(ListingStore.memory),
			Layer.provide(harness),
		),
	).pipe(Layer.provide(executor))
	return Layer.mergeAll(
		hosted,
		PiDurableHarnessLive.pipe(Layer.provide(executor), Layer.provide(hosted)),
	)
}

export const makePiDurableTestLayer = (
	handler: (
		model: Model<Api>,
		context: TranscriptContext,
		signal?: AbortSignal,
	) => Promise<AssistantMessage>,
	{
		env: envOverrides = {
			CHECKFU_API_KEY: TEST_API_KEY,
			OPENAI_API_KEY: "sk-openai-test",
			ANTHROPIC_API_KEY: "sk-anthropic-test",
		},
		platform = Domain.InMemory,
		registry,
		executionEnv,
		vaults = VaultsTestLive,
		harnessSessions = (sessions) => sessions,
		mcpTools,
	}: {
		readonly env?: Record<string, string>
		readonly platform?: typeof Domain.InMemory
		readonly registry?: () => Registry
		readonly executionEnv?: ExecutionEnv
		readonly vaults?: typeof VaultsTestLive
		readonly harnessSessions?: (sessions: Session["Service"]) => Session["Service"]
		readonly mcpTools?: ReadonlyArray<TestMcpTool>
	} = {},
) => {
	const agentToolsBySession = new Map<string, string>()
	const sessionTools = (sessionId: string) => {
		if (mcpTools === undefined) {
			return {}
		}
		const declared = () => decodeAgentTools(agentToolsBySession.get(sessionId))
		const servers = [...new Set(mcpTools.map((tool) => tool.server))].map((server) => ({
			binding: {
				name: server,
				url: `https://${server}.mcp.example/mcp`,
				credential_id: null,
				vault_id: null,
			},
			tools: {
				status: "listed" as const,
				tools: mcpTools
					.filter((tool) => tool.server === server)
					.map((tool) => ({
						name: tool.name,
						description: `${tool.name} on ${tool.server}`,
						inputSchema: tool.parameters ?? { type: "object" },
						...(tool.readOnly === undefined
							? {}
							: { annotations: { readOnlyHint: tool.readOnly } }),
					})),
			},
		}))
		let tools = mcpRegistry(servers, declared())
		const toolOf = (name: string) => tools.toolOf(name)
		const custom = () => declared().filter((tool): tool is CustomTool => tool.type === "custom")
		const built = createCheckfuRegistry()
		const install = () => {
			tools = mcpRegistry(servers, declared())
			built.install(
				defineExtension({
					name: "test.mcp",
					tools: [...tools.byName].map(([name, { binding, tool }]) => ({
						name,
						description: tool.description,
						parameters: tool.inputSchema,
						execute: async (args: unknown) => ({
							output: [
								{
									type: "text" as const,
									text: await (mcpTools
										.find((given) => given.server === binding.name && given.name === tool.name)
										?.run(args) ?? ""),
								},
							],
						}),
					})),
				}),
			)
			built.install(customToolsExtension(custom()))
			built.install(actionsExtension(toolOf))
		}
		install()
		return {
			registry: built,
			mcpToolOf: toolOf,
			publishMcp: async (request: PiTurnRequest) => {
				if (request.tools !== undefined && !agentToolsBySession.has(sessionId)) {
					agentToolsBySession.set(sessionId, request.tools)
					install()
				}
				return false
			},
		}
	}
	interface SessionObject {
		readonly backend: InMemoryPiDurableBackend
		readonly gone: Deferred.Deferred<never, HarnessCallFailed>
	}
	const objects = new Map<string, Promise<SessionObject>>()
	const resets: Array<string> = []
	const customProviders =
		envOverrides[CUSTOM_PROVIDERS_ENV] === undefined
			? []
			: parseCustomProvidersManifest(envOverrides[CUSTOM_PROVIDERS_ENV], {
					allowLoopbackHttp: envOverrides.CHECKFU_LOCAL_DEV === "local-dev",
				})
	const open = async (
		sessionId: string,
		storage?: InMemoryPiDurableBackend["storage"],
	): Promise<SessionObject> => {
		const gone = Deferred.makeUnsafe<never, HarnessCallFailed>()
		const tools = sessionTools(sessionId)
		const backend = await createInMemoryPiDurableBackend(
			makeScriptedPiModels(handler, customProviders),
			undefined,
			tools.registry ?? registry?.(),
			(provider) =>
				checkCatalogProviderCredentials(provider, { env: envOverrides }, customProviders).ok,
			{
				...(storage === undefined ? {} : { storage }),
				...(executionEnv === undefined ? {} : { env: executionEnv }),
				...(tools.publishMcp === undefined ? {} : { publishMcp: tools.publishMcp }),
				...(tools.mcpToolOf === undefined ? {} : { mcpToolOf: tools.mcpToolOf }),
				reset: Effect.andThen(
					Effect.promise(async () => {
						const serving = await objects.get(sessionId)
						if (serving?.gone === gone) {
							resets.push(sessionId)
							serving.backend.retire()
							objects.set(sessionId, open(sessionId, serving.backend.storage))
						}
					}),
					Effect.andThen(
						Deferred.fail(gone, new HarnessCallFailed({ cause: "object reset in test" })),
						Effect.never,
					),
				),
			},
		)
		return { backend, gone }
	}
	const getObject = (sessionId: string) => {
		let existing = objects.get(sessionId)
		if (existing === undefined) {
			existing = open(sessionId)
			objects.set(sessionId, existing)
		}
		return existing
	}
	const onObject = <A>(
		sessionId: string,
		call: (backend: InMemoryPiDurableBackend) => Effect.Effect<A>,
	): Effect.Effect<A, HarnessCallFailed> =>
		Effect.gen(function* () {
			const { backend, gone } = yield* Effect.promise(() => getObject(sessionId))
			const running = yield* Effect.forkDetach(harnessCall(call(backend)))
			return yield* Effect.raceFirst(Fiber.join(running), Deferred.await(gone))
		}).pipe(Effect.provideService(AbortGrace, "30 millis"))

	const requests: Array<PiTurnRequest> = []
	const forgetPiState = async (sessionId: string) => {
		const existing = objects.get(sessionId)
		objects.delete(sessionId)
		await (await existing)?.backend.close()
	}

	const unreachable = new Set<string>()
	const pausing: PauseHook = {}
	const conversations: Array<string> = []
	const discardedWorkspaces: Array<string> = []
	const workspaces = new Map<string, Map<string, string>>()
	const workspaceFiles = (sessionId: string) => {
		const existing = workspaces.get(sessionId)
		if (existing !== undefined) {
			return existing
		}
		const files = new Map<string, string>()
		workspaces.set(sessionId, files)
		return files
	}
	const encoder = new TextEncoder()
	const outputWalks: Array<{ readonly limit: number; readonly found: number }> = []
	const failingOutputReads = new Set<string>()
	const sessionOutputs = (sessionId: string, onRead?: (file: string) => void) => {
		const files = workspaceFiles(sessionId)
		const bytesOf = (file: string) => {
			const content = files.get(file)
			return content === undefined
				? Promise.reject(Object.assign(new Error(`no such file: ${file}`), { code: "ENOENT" }))
				: Promise.resolve(encoder.encode(content))
		}
		return makeSessionOutputs({
			list: (directory, limit) => {
				if (files.has(directory)) {
					outputWalks.push({ limit, found: 0 })
					return Promise.reject(
						Object.assign(new Error(`not a directory: ${directory}`), { code: "ENOTDIR" }),
					)
				}
				const found = new Map<string, "file" | "dir">()
				for (const file of files.keys()) {
					if (file.startsWith(`${directory}/`)) {
						found.set(file, "file")
						for (
							let parent = file.slice(0, file.lastIndexOf("/"));
							parent !== directory;
							parent = parent.slice(0, parent.lastIndexOf("/"))
						) {
							if (!found.has(parent)) {
								found.set(parent, "dir")
							}
						}
					}
				}
				const entries = [...found]
					.toSorted(([a], [b]) => (a < b ? -1 : 1))
					.slice(0, limit)
					.map(([path, type]) => ({ path, type }))
				outputWalks.push({ limit, found: entries.length })
				return Promise.resolve(entries)
			},
			size: (file) => bytesOf(file).then((bytes) => bytes.byteLength),
			read: (file) => {
				onRead?.(file)
				return failingOutputReads.has(file)
					? Promise.reject(Object.assign(new Error(`cannot read ${file}`), { code: "EIO" }))
					: bytesOf(file)
			},
		})
	}
	const outputListReads: Array<string> = []
	const outputReads: Array<{
		readonly sessionId: string
		readonly paths: ReadonlyArray<string>
	}> = []
	let beforeOutputsRead: ((sessionId: string) => void | Promise<void>) | undefined
	const enteredTurns = new Map<string, number>()
	const superseded = (sessionId: string, turn: number) => (enteredTurns.get(sessionId) ?? 0) > turn
	const publishedTurns: Array<string> = []
	type PublishArgs = Parameters<SessionOutputs["Service"]["publish"]>[0]
	let publish: ((args: PublishArgs) => Effect.Effect<void>) | undefined
	const publishOutputs = (args: PublishArgs) =>
		Effect.suspend(() => publish?.(args) ?? Effect.die(new Error("no publisher yet")))
	const SessionOutputsRecorded = SessionOutputs.toLayer(
		Effect.map(makeSessionOutputsPublisher, (publisher) => {
			publish = (args) =>
				publisher
					.publish(args)
					.pipe(
						Effect.ensuring(
							Effect.sync(() => publishedTurns.push(`${args.session_id}:${args.turn}`)),
						),
					)
			return { publish: (args: PublishArgs) => publishOutputs(args) }
		}),
	)
	const preparedWorkspaces: Array<{
		readonly sessionId: string
		readonly repositories: ReadonlyArray<RepositoryMount>
		readonly allowedHosts: ReadonlyArray<string> | null
	}> = []
	const workspaceCalls: Array<string> = []
	const refusedWorkspaces = new Set<string>()
	const repositoryTokens = new Map<string, string>()
	const preparations: Array<WorkspacePreparation> = []
	const beforeTokenStored: Array<() => Promise<Response>> = []
	const tokenDeliveries: Array<string> = []
	const executorLayer = makePiTurnExecutorLayer(
		{
			recoverTurn: (conversation, operationId) =>
				Effect.suspend(() =>
					unreachable.has(conversation)
						? Effect.fail(new HarnessCallFailed({ cause: "unreachable in test" }))
						: !objects.has(conversation)
							? Effect.succeed(null)
							: onObject(conversation, (backend) => recoverPiDurableTurn(backend, operationId)),
				),
			runTurn: (conversation, request) =>
				Effect.suspend(() => {
					if (unreachable.has(conversation)) {
						return Effect.fail(new HarnessCallFailed({ cause: "unreachable in test" }))
					}
					requests.push(request)
					conversations.push(conversation)
					enteredTurns.set(
						conversation,
						Math.max(enteredTurns.get(conversation) ?? 0, request.turn),
					)
					return onObject(conversation, (backend) => runPiDurableTurn(backend, request))
				}),
			pauseUsage: (conversation, operationId, pause) =>
				onObject(conversation, (backend) => pausePiDurableTurn(backend, operationId, pause)).pipe(
					Effect.tap(() => pausing.before?.(conversation) ?? Effect.void),
				),
			answerCall: (conversation, toolUseId, answer) =>
				Effect.suspend(() =>
					unreachable.has(conversation)
						? Effect.fail(new HarnessCallFailed({ cause: "unreachable in test" }))
						: onObject(conversation, (backend) => answerPiDurableCall(backend, toolUseId, answer)),
				),
			abortTurn: (conversation, operationId) =>
				Effect.suspend(() =>
					unreachable.has(conversation)
						? Effect.never
						: onObject(conversation, (backend) =>
								Effect.asVoid(abortPiDurableTurn(backend, operationId)),
							),
				),
		},
		{
			prepareWorkspace: (sessionId, token, repositories, allowedHosts) =>
				Effect.sync((): WorkspacePreparation => {
					workspaceCalls.push(`prepare ${sessionId} ${token.turn}`)
					if (refusedWorkspaces.has(sessionId)) {
						return { ok: false, interrupted: true }
					}
					preparedWorkspaces.push({ sessionId, repositories, allowedHosts })
					return preparations.shift() ?? { ok: true }
				}),
			interruptWorkspace: (sessionId, token) =>
				Effect.sync(() => {
					workspaceCalls.push(`interrupt ${sessionId} ${token.turn}`)
				}),
			storeRepositoryToken: (sessionId, resourceId, token, replace) =>
				Effect.suspend(() => {
					tokenDeliveries.push(token)
					return unreachable.has(sessionId) || unreachable.has("*")
						? Effect.fail(new HarnessCallFailed({ cause: "unreachable in test" }))
						: Effect.void
				}).pipe(
					Effect.andThen(
						Effect.promise(async () => {
							await beforeTokenStored.shift()?.()
							const key = `${sessionId}/${resourceId}`
							if (replace || !repositoryTokens.has(key)) {
								repositoryTokens.set(key, token)
							}
						}),
					),
				),
			discardWorkspace: (sessionId) =>
				Effect.sync(() => {
					discardedWorkspaces.push(sessionId)
					workspaces.get(sessionId)?.clear()
				}),
			listOutputs: (sessionId, turn) =>
				Effect.tryPromise({
					try: async () =>
						superseded(sessionId, turn)
							? null
							: sessionOutputs(sessionId, (file) => outputListReads.push(file)).list(),
					catch: (cause) => new HarnessCallFailed({ cause }),
				}),
			readOutputs: (sessionId, turn, paths) =>
				Effect.tryPromise({
					try: async () => {
						outputReads.push({ sessionId, paths })
						await beforeOutputsRead?.(sessionId)
						return superseded(sessionId, turn) ? null : sessionOutputs(sessionId).read(paths)
					},
					catch: (cause) => new HarnessCallFailed({ cause }),
				}),
		},
	)

	const artifactStore = makeArtifactStoreMemory()
	const HarnessLive = PiDurableHarnessLive.pipe(
		Layer.provide(
			Layer.effect(
				Session,
				Effect.gen(function* () {
					return harnessSessions(yield* Session)
				}),
			),
		),
	)
	const CheckfuLive = Checkfu.layer(
		CheckfuHandlersLive.pipe(
			Layer.provide(ListingStore.memory),
			Layer.provide(HarnessLive),
			Layer.provide(ArtifactBytesLive.pipe(Layer.provide(artifactStore.layer))),
			Layer.provide(SessionOutputsRecorded.pipe(Layer.provide(artifactStore.layer))),
		),
	).pipe(Layer.provide(executorLayer))
	const PiProviderLive = PiDurableHarnessLive.pipe(
		Layer.provide(executorLayer),
		Layer.provide(CheckfuLive),
	)

	const closeAll = async () => {
		const pending = [...objects.values()]
		objects.clear()
		const results = await Promise.allSettled(
			pending.map(async (object) => {
				await (await object).backend.close()
			}),
		)
		const firstFailure = results.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		)
		if (firstFailure !== undefined) {
			throw firstFailure.reason
		}
	}

	const CustomToolFaultsLive = Layer.succeed(CustomToolFaults, (tools, taken) =>
		Effect.succeed(customToolFaults(tools, taken)),
	)
	const layer = Layer.mergeAll(
		CheckfuLive,
		PiProviderLive,
		CustomToolFaultsLive,
		ArtifactLinksTest,
	).pipe(
		Layer.provideMerge(artifactStore.layer),
		Layer.provideMerge(
			Layer.succeed(HarnessLimits, {
				attempts: 2,
				baseDelay: "1 millis",
				interruptTimeout: "50 millis",
				settleMargin: "50 millis",
			}),
		),
		Layer.provide(platform),
		Layer.provide(Layer.effectDiscard(Effect.addFinalizer(() => Effect.promise(closeAll)))),
		Layer.provideMerge(vaults),
		Layer.provideMerge(Digest.layerWebCrypto),
		Layer.provideMerge(SecureRandom.layerWebCrypto),
		Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(envOverrides))),
		Layer.provideMerge(TestRuntimeContext),
	)

	const restartPi = async (sessionId: string) => {
		const serving = await objects.get(sessionId)
		if (serving === undefined) {
			return
		}
		serving.backend.retire()
		const reopened = open(sessionId, serving.backend.storage)
		objects.set(sessionId, reopened)
		await reopened
	}

	return {
		layer,
		closeAll,
		restartPi,
		requests,
		forgetPiState,
		unreachable,
		pausing,
		conversations,
		resets,
		artifactStore,
		discardedWorkspaces,
		workspaceFiles,
		outputReads,
		outputListReads,
		outputWalks,
		failingOutputReads,
		publishedTurns,
		publishOutputs,
		setBeforeOutputsRead: (run: (sessionId: string) => void | Promise<void>) => {
			beforeOutputsRead = run
		},
		preparedWorkspaces,
		workspaceCalls,
		refusedWorkspaces,
		repositoryTokens,
		preparations,
		beforeTokenStored,
		tokenDeliveries,
	}
}

export const openApiDocument = <Document>(): Document =>
	JSON.parse(
		readFileSync(new URL("../../public/openapi.json", import.meta.url), "utf8"),
	) as Document

export const sendRequest = (
	fetchEffect: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		never,
		HttpServerRequest.HttpServerRequest | RuntimeContext
	>,
	input: {
		readonly method: string
		readonly path: string
		readonly body?: unknown
		readonly rawBody?: string
		readonly headers?: Record<string, string>
	},
) =>
	Effect.gen(function* () {
		const body =
			input.rawBody ?? (input.body === undefined ? undefined : JSON.stringify(input.body))
		const init: RequestInit = {
			method: input.method,
			headers: {
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...input.headers,
			},
			...(body === undefined ? {} : { body }),
		}
		const webRequest = new Request(`http://localhost${input.path}`, init)
		const response = yield* fetchEffect.pipe(
			Effect.provideService(
				HttpServerRequest.HttpServerRequest,
				HttpServerRequest.fromWeb(webRequest),
			),
			Effect.provideService(RuntimeContext, TEST_RUNTIME),
		)
		return HttpServerResponse.toWeb(response)
	})

export const makeApiTestClient = (
	fetchEffect: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		never,
		HttpServerRequest.HttpServerRequest | RuntimeContext
	>,
) =>
	makeCheckfuClientWith({
		baseUrl: "http://localhost",
		httpClient: makeApiTestHttpClient(fetchEffect),
	})

export const makeApiTestHttpClient = (
	fetchEffect: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		never,
		HttpServerRequest.HttpServerRequest | RuntimeContext
	>,
) =>
	HttpClient.make((request, url) =>
		Effect.gen(function* () {
			const headers = new Headers(request.headers)
			if (!headers.has("authorization") && !headers.has("x-api-key")) {
				headers.set("authorization", `Bearer ${TEST_API_KEY}`)
			}
			const body =
				request.body._tag === "Uint8Array" ? new Uint8Array(request.body.body) : undefined
			const webRequest = new Request(url.toString(), {
				method: request.method,
				headers,
				...(body === undefined ? {} : { body }),
			})
			const response = yield* fetchEffect.pipe(
				Effect.provideService(
					HttpServerRequest.HttpServerRequest,
					HttpServerRequest.fromWeb(webRequest),
				),
				Effect.provideService(RuntimeContext, TEST_RUNTIME),
			)
			return HttpClientResponse.fromWeb(request, HttpServerResponse.toWeb(response))
		}),
	)

export type SseEventData = JsonObject & { readonly type: string }

export interface SseFrame {
	readonly id: string
	readonly event: string
	readonly data: SseEventData
}

export const readSseUntil = async (
	response: Response,
	predicate: (event: SseEventData) => boolean,
): Promise<Array<SseFrame>> => {
	const reader = response.body?.getReader()
	if (!reader) {
		throw new Error("Expected SSE response body stream")
	}
	const decoder = new TextDecoder()
	const collected: Array<SseFrame> = []
	let done = false
	const parser = Sse.makeParser((parsed) => {
		if (done || parsed._tag !== "Event") {
			return
		}
		const data = JSON.parse(parsed.data) as SseEventData
		collected.push({ id: parsed.id ?? "", event: parsed.event, data })
		if (predicate(data)) {
			done = true
			parser.reset()
		}
	})

	try {
		while (!done) {
			const chunk = await reader.read()
			if (chunk.done) {
				break
			}
			const error = parser.feed(decoder.decode(chunk.value, { stream: true }))
			if (error !== undefined) {
				throw error
			}
		}
		if (done) {
			await reader.cancel()
		} else {
			const tailError = parser.feed(decoder.decode())
			if (tailError !== undefined) {
				throw tailError
			}
		}
	} finally {
		reader.releaseLock()
	}
	return collected
}

export const makeAssistantReply = (
	model: Model<Api>,
	thinking: string | null,
	text: string,
	inputTokens: number,
	outputTokens: number,
): AssistantMessage => ({
	role: "assistant",
	content: [
		...(thinking === null ? [] : [{ type: "thinking" as const, thinking }]),
		{ type: "text" as const, text },
	],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: {
		input: inputTokens,
		output: outputTokens,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: inputTokens + outputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
})

export const createIdleSession = (
	apiFetch: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		never,
		HttpServerRequest.HttpServerRequest | RuntimeContext
	>,
) =>
	Effect.gen(function* () {
		const agentRes = yield* sendRequest(apiFetch, {
			method: "POST",
			path: "/v1/agents",
			headers: AUTH_HEADERS,
			body: { name: "Agent", model: "gpt-4o-mini" },
		})
		const agent = (yield* Effect.promise(() => agentRes.json())) as { id: string }
		const envRes = yield* sendRequest(apiFetch, {
			method: "POST",
			path: "/v1/environments",
			headers: AUTH_HEADERS,
			body: { name: "Env" },
		})
		const env = (yield* Effect.promise(() => envRes.json())) as { id: string }
		const sessionRes = yield* sendRequest(apiFetch, {
			method: "POST",
			path: "/v1/sessions",
			headers: AUTH_HEADERS,
			body: { agent: agent.id, environment_id: env.id },
		})
		return (yield* Effect.promise(() => sessionRes.json())) as {
			id: string
			environment_id: string
		}
	})

export const providerError = (error: { readonly _tag: string }): TurnFailed => {
	if (error._tag !== "TurnFailed") {
		throw new Error(`expected a provider error, got ${error._tag}`)
	}
	return error as TurnFailed
}

export const waitForSession = (
	apiFetch: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		never,
		HttpServerRequest.HttpServerRequest | RuntimeContext
	>,
	sessionId: string,
	predicate: (session: { readonly status: string; readonly turn: number }) => boolean,
	description = "session did not reach expected state",
) =>
	Effect.gen(function* () {
		const poll = Effect.gen(function* () {
			const res = yield* sendRequest(apiFetch, {
				method: "GET",
				path: `/v1/sessions/${sessionId}`,
				headers: AUTH_HEADERS,
			})
			return (yield* Effect.promise(() => res.json())) as {
				readonly status: string
				readonly turn: number
			}
		})
		const current = yield* poll.pipe(
			Effect.repeat({
				schedule: Schedule.spaced("5 millis"),
				times: 400,
				until: predicate,
			}),
		)
		if (!predicate(current)) {
			return yield* Effect.die(new Error(description))
		}
		return current
	})

export const sendAndSettle = (
	apiFetch: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		never,
		HttpServerRequest.HttpServerRequest | RuntimeContext
	>,
	sessionId: string,
	texts: ReadonlyArray<string>,
	turn: number,
) =>
	Effect.gen(function* () {
		const sent = yield* sendRequest(apiFetch, {
			method: "POST",
			path: `/v1/sessions/${sessionId}/events`,
			headers: AUTH_HEADERS,
			body: {
				events: texts.map((text) => ({
					type: "user.message",
					content: [{ type: "text", text }],
				})),
			},
		})
		expect(sent.status).toBe(200)
		yield* waitForSession(
			apiFetch,
			sessionId,
			(current) => current.status === "idle" && current.turn === turn,
			`turn ${turn} did not settle`,
		)
	})
