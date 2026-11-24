import * as Domain from "@alchemy.run/domain"
import {
	CredentialSecretsLive,
	makeConnectionExecutorLayer,
} from "@checkfu/api/Connection/CredentialCustody"
import { makeApiHandler } from "@checkfu/api/Http/Router"
import { makeApiCatalogExecutorLayer } from "@checkfu/api/OpenApi/ApiCatalogExecutor"
import { ApiCatalogsLive } from "@checkfu/api/OpenApi/ApiCatalogKeeper"
import { Checkfu, CheckfuHandlersLive } from "@checkfu/domain/Checkfu.model"
import { boundedHarness } from "@checkfu/domain/Session/Harness.external"
import type {
	HarnessReply,
	HarnessUnavailable,
	TurnFailed,
	TurnInterrupted,
	TurnPaused,
} from "@checkfu/domain/Session/Harness.external"
import { PauseTurn } from "@checkfu/domain/Session/PauseTurn.command"
import { clampToolCalls, recordToolCalls } from "@checkfu/domain/Session/RecordToolCalls"
import { turnKey } from "@checkfu/domain/Session/RunTurn.saga"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import type { SessionId } from "@checkfu/domain/Session/Session.id"
import { ToolUseIds } from "@checkfu/domain/Session/SessionTypes"
import type { ToolEvent } from "@checkfu/domain/Session/SessionTypes"
import { Vaults, VaultsHandlersLive } from "@checkfu/domain/Vaults.model"
import * as Clock from "effect/Clock"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Sink from "effect/Sink"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import * as Terminal from "effect/Terminal"
import { runCli } from "../../src/Cli.ts"
import { Checkout } from "../../src/Commands/Deploy.ts"
import { SigintCoordinator, makeSigintController } from "../../src/Signals.ts"
import type { SigintController } from "../../src/Signals.ts"

export const TEST_API_KEY = "ck_cli_test_secret"

const notFoundError = (method: string, filePath: string) =>
	PlatformError.systemError({
		_tag: "NotFound",
		module: "FileSystem",
		method,
		pathOrDescriptor: filePath,
	})

const permissionDenied = (method: string, filePath: string) =>
	PlatformError.systemError({
		_tag: "PermissionDenied",
		module: "FileSystem",
		method,
		pathOrDescriptor: filePath,
	})

const toWebRequest = (input: RequestInfo | URL, init?: RequestInit): Request =>
	typeof input === "string" || "href" in input ? new Request(input, init) : input

export interface ModelTurnInput {
	readonly session_id: SessionId
	readonly agent_id: string
	readonly agent_version: number
	readonly environment_id: string
	readonly turn: number
	readonly input: ReadonlyArray<string>
}

export interface ModelHandler {
	readonly generate?: (
		args: ModelTurnInput,
	) => Effect.Effect<HarnessReply, TurnFailed | TurnInterrupted | HarnessUnavailable>
	readonly interrupt?: (args: {
		readonly session_id: SessionId
		readonly turn: number
	}) => Effect.Effect<void, HarnessUnavailable>
	readonly toolEvents?: (args: ModelTurnInput) => ReadonlyArray<ToolEvent>
	/** The tool calls a turn pauses on, by id; none for a turn that runs to its reply. */
	readonly waiting?: (args: ModelTurnInput) => ReadonlyArray<string>
}

export interface CliRunOptions {
	readonly env?: Record<string, string>
	readonly stdin?: string | Stream.Stream<Uint8Array, PlatformError.PlatformError>
	readonly stdinIsTerminal?: boolean
	readonly stdoutIsTerminal?: boolean
	readonly stderrIsTerminal?: boolean
	readonly files?: Record<string, string | Stream.Stream<Uint8Array, PlatformError.PlatformError>>
	readonly onChmod?: (filePath: string, mode: number) => void
	readonly readyWithin?: Duration.Input
	readonly spawn?: (args: ReadonlyArray<string>) => {
		readonly exitCode: number
		readonly stdout?: string
	}
	readonly terminalReads?: ReadonlyArray<Effect.Effect<string, Terminal.QuitError>>
	readonly sigintController?: SigintController
	readonly clock?: Clock.Clock
	readonly onStdoutChunk?: (chunk: string) => Effect.Effect<void>
	readonly interceptFetch?: (
		next: (request: Request) => Promise<Response>,
		request: Request,
	) => Promise<Response>
}

export interface CliRunResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
	readonly errorMessage: string | undefined
}

const defaultModelHandler: Required<ModelHandler> = {
	generate: (args) =>
		Effect.succeed({
			thinking: `Thinking about turn ${args.turn}`,
			text: `Echo: ${args.input.join(" | ")}`,
			input_tokens: 10,
			output_tokens: 5,
			stop_reason: { type: "end_turn" as const },
		}),
	interrupt: () => Effect.void,
	toolEvents: () => [],
	waiting: () => [],
}

export const makeTestServer = (handler?: ModelHandler) =>
	Effect.gen(function* () {
		const effective: Required<ModelHandler> = {
			generate: handler?.generate ?? defaultModelHandler.generate,
			interrupt: handler?.interrupt ?? defaultModelHandler.interrupt,
			toolEvents: handler?.toolEvents ?? defaultModelHandler.toolEvents,
			waiting: handler?.waiting ?? defaultModelHandler.waiting,
		}
		const HarnessLive = boundedHarness(
			Effect.map(Session, (sessions) => ({
				runTurn: (args: ModelTurnInput) => {
					const waiting = effective.waiting(args)
					const settle: Effect.Effect<
						HarnessReply,
						TurnFailed | TurnInterrupted | TurnPaused | HarnessUnavailable
					> =
						waiting.length === 0
							? effective.generate(args)
							: Effect.andThen(
									Effect.orDie(
										sessions.send(
											new PauseTurn({
												session_id: args.session_id,
												turn: args.turn,
												request_seq: 1,
												model_request_start_id: `${turnKey(args.session_id, args.turn)}:req:1`,
												event_ids: ToolUseIds.encode(waiting),
											}),
										),
									),
									Effect.fail<TurnPaused>({ _tag: "TurnPaused" }),
								)
					return Effect.andThen(
						recordToolCalls({
							session_id: args.session_id,
							turn: args.turn,
							calls: clampToolCalls(effective.toolEvents(args)),
						}).pipe(Effect.provideService(Session, sessions)),
						settle,
					)
				},
				interrupt: effective.interrupt,
				discardWorkspace: () => Effect.void,
			})),
		)
		const CheckfuLive = Checkfu.layer(CheckfuHandlersLive.pipe(Layer.provide(HarnessLive)))
		// These tests keep no secrets: the connection objects accept and forget.
		const catalogExecutor = makeApiCatalogExecutorLayer({
			store: () => Effect.succeed(true),
			keep: () => Effect.void,
		})
		const VaultsLive = Vaults.layer(VaultsHandlersLive).pipe(
			Layer.provideMerge(CredentialSecretsLive),
			Layer.provideMerge(Layer.provide(ApiCatalogsLive, catalogExecutor)),
			Layer.provideMerge(
				makeConnectionExecutorLayer({
					storeSecret: () => Effect.succeed(true),
					replaceSecret: () => Effect.succeed(2),
					keepSecret: () => Effect.void,
					erase: () => Effect.void,
					refreshReport: () => Effect.succeed(null),
					acknowledgeRefresh: () => Effect.void,
				}),
			),
		)
		const ServerLayer = Layer.mergeAll(CheckfuLive, VaultsLive, catalogExecutor).pipe(
			Layer.provide(Domain.InMemory),
			Layer.provideMerge(Digest.layerWebCrypto),
			Layer.provideMerge(SecureRandom.layerWebCrypto),
			Layer.provideMerge(
				ConfigProvider.layer(ConfigProvider.fromUnknown({ CHECKFU_API_KEY: TEST_API_KEY })),
			),
		)

		const apiContext = yield* Layer.build(ServerLayer)
		const api = yield* makeApiHandler.pipe(Effect.provide(apiContext))
		const runWithApi = Effect.runPromiseWith(apiContext)

		const dispatchWeb = (request: Request): Promise<Response> =>
			runWithApi(
				api.fetch.pipe(
					Effect.provideService(
						HttpServerRequest.HttpServerRequest,
						HttpServerRequest.fromWeb(request),
					),
					Effect.map((response) => HttpServerResponse.toWeb(response)),
				),
			)

		const run = (
			args: ReadonlyArray<string>,
			options?: CliRunOptions,
		): Effect.Effect<CliRunResult> =>
			Effect.gen(function* () {
				const stdoutChunks: Array<string> = []
				const stderrChunks: Array<string> = []
				const decoder = new TextDecoder()

				const collectSink = (
					target: Array<string>,
					onChunk?: (chunk: string) => Effect.Effect<void>,
				): Sink.Sink<void, string | Uint8Array, never, PlatformError.PlatformError> =>
					Sink.forEach((chunk: string | Uint8Array) =>
						Effect.gen(function* () {
							const text = typeof chunk === "string" ? chunk : decoder.decode(chunk)
							target.push(text)
							if (onChunk !== undefined) {
								yield* onChunk(text)
							}
						}),
					)

				const stdinStream: Stream.Stream<Uint8Array, PlatformError.PlatformError> =
					options?.stdin === undefined
						? Stream.empty
						: typeof options.stdin === "string"
							? Stream.make(new TextEncoder().encode(options.stdin))
							: options.stdin

				const files = options?.files ?? {}
				const fileSystemLayer = FileSystem.layerNoop({
					readFileString: (filePath) => {
						const entry = files[filePath]
						return typeof entry === "string"
							? Effect.succeed(entry)
							: Effect.fail(
									entry === undefined
										? notFoundError("readFileString", filePath)
										: permissionDenied("readFileString", filePath),
								)
					},
					stream: (filePath) => {
						const entry = files[filePath]
						if (entry === undefined) {
							return Stream.fail(notFoundError("stream", filePath))
						}
						return typeof entry === "string" ? Stream.make(new TextEncoder().encode(entry)) : entry
					},
					exists: (filePath) => Effect.succeed(files[filePath] !== undefined),
					writeFileString: (filePath, data) =>
						Effect.sync(() => {
							files[filePath] = data
						}),
					rename: (from, to) =>
						Effect.sync(() => {
							const entry = files[from]
							if (entry !== undefined) {
								files[to] = entry
								delete files[from]
							}
						}),
					makeDirectory: () => Effect.void,
					chmod: (filePath, mode) => Effect.sync(() => options?.onChmod?.(filePath, mode)),
					remove: (filePath) => {
						const entry = files[filePath]
						if (typeof entry !== "string") {
							return Effect.fail(
								entry === undefined
									? notFoundError("remove", filePath)
									: permissionDenied("remove", filePath),
							)
						}
						return Effect.sync(() => {
							delete files[filePath]
						})
					},
				})

				const spawnerLayer = Layer.succeed(
					ChildProcessSpawner.ChildProcessSpawner,
					ChildProcessSpawner.make((command) => {
						if (command._tag !== "StandardCommand") {
							return Effect.die("unused")
						}
						if (options?.spawn === undefined) {
							return Effect.die("unused")
						}
						// Calls to the Alchemy query script reach `spawn` as `query <question> ...`.
						const [program = "", ...rest] = command.args.map(String)
						const result = options.spawn(
							program.endsWith("alchemy-query.ts")
								? [program, "query", ...rest]
								: [program, ...rest],
						)
						const stdout = Stream.make(new TextEncoder().encode(result.stdout ?? ""))
						return Effect.succeed(
							ChildProcessSpawner.makeHandle({
								pid: ChildProcessSpawner.ProcessId(1),
								exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
								isRunning: Effect.succeed(false),
								kill: () => Effect.void,
								stdin: Sink.drain,
								stdout,
								stderr: Stream.empty,
								all: stdout,
								getInputFd: () => Sink.drain,
								getOutputFd: () => Stream.empty,
								unref: Effect.succeed(Effect.void),
							}),
						)
					}),
				)

				const reads = [...(options?.terminalReads ?? [])]
				let readIndex = 0
				const terminalLayer = Layer.succeed(
					Terminal.Terminal,
					Terminal.make({
						columns: Effect.succeed(80),
						rows: Effect.succeed(24),
						size: Effect.die("unused"),
						readInput: Effect.die("unused"),
						readLine: Effect.suspend(() => {
							const next = reads[readIndex++]
							return next ?? Effect.fail(new Terminal.QuitError())
						}),
						display: (text) =>
							Effect.sync(() => {
								stdoutChunks.push(text)
							}),
					}),
				)

				const customFetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
					const request = toWebRequest(input, init)
					return options?.interceptFetch
						? options.interceptFetch(dispatchWeb, request)
						: dispatchWeb(request)
				}) as typeof globalThis.fetch

				const envMap =
					options?.env !== undefined
						? options.env
						: {
								CHECKFU_API_KEY: TEST_API_KEY,
								CHECKFU_API_URL: "http://localhost:1337",
							}

				const cliLayer = Layer.mergeAll(
					fileSystemLayer,
					Path.layer,
					Stdio.layerTest({
						args: Effect.succeed(args),
						stdin: stdinStream,
						stdinIsTerminal: Effect.succeed(options?.stdinIsTerminal ?? false),
						stdoutIsTerminal: Effect.succeed(options?.stdoutIsTerminal ?? false),
						stderrIsTerminal: Effect.succeed(options?.stderrIsTerminal ?? false),
						stdout: () => collectSink(stdoutChunks, options?.onStdoutChunk),
						stderr: () => collectSink(stderrChunks),
					}),
					terminalLayer,
					spawnerLayer,
					Layer.succeed(Checkout, {
						root: "/checkout",
						runtime: "bun",
						runtimeEnv: {},
						readyWithin: options?.readyWithin ?? "300 millis",
					}),
					FetchHttpClient.layer.pipe(
						Layer.provide(Layer.succeed(FetchHttpClient.Fetch, customFetch)),
					),
					SecureRandom.layerWebCrypto,
					Layer.succeed(SigintCoordinator, options?.sigintController ?? makeSigintController()),
					ConfigProvider.layer(ConfigProvider.fromUnknown(envMap)),
				)

				const runEffect =
					options?.clock !== undefined
						? runCli(args).pipe(
								Effect.provide(cliLayer),
								Effect.provideService(Clock.Clock, options.clock),
							)
						: runCli(args).pipe(Effect.provide(cliLayer))
				const outcome = yield* Effect.result(runEffect)
				return {
					exitCode: outcome._tag === "Success" ? 0 : outcome.failure.exitCode,
					stdout: stdoutChunks.join(""),
					stderr: stderrChunks.join(""),
					errorMessage: outcome._tag === "Failure" ? outcome.failure.message : undefined,
				}
			})

		return { run }
	})
