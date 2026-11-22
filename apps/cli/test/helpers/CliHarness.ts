import * as Domain from "@alchemy.run/domain"
import { Checkfu } from "@checkfu/api/Checkfu.model"
import { makeApiHandler } from "@checkfu/api/Http/Router"
import {
	type ModelProviderError,
	type ModelProviderReply,
	type ModelRequestInterrupted,
	type HarnessUnavailable,
	boundedModelProvider,
} from "@checkfu/sessions/Session/ModelProvider.external"
import type { SessionId } from "@checkfu/sessions/Session/Session.id"
import { SessionsHandlersLive } from "@checkfu/sessions/Sessions.model"
import * as ConfigProvider from "effect/ConfigProvider"
import * as SecureRandom from "effect/crypto/SecureRandom"
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
import {
	type SigintController,
	SigintCoordinator,
	makeSigintController,
} from "../../src/Signals.ts"

export const TEST_API_KEY = "ck_cli_test_secret"

export interface ModelTurnInput {
	readonly session_id: SessionId
	readonly agent_id: string
	readonly agent_version: number
	readonly environment_id: string
	readonly turn: number
	readonly generation: number
	readonly input: ReadonlyArray<string>
}

export interface ModelHandler {
	readonly generate?: (
		args: ModelTurnInput,
	) => Effect.Effect<
		ModelProviderReply,
		ModelProviderError | ModelRequestInterrupted | HarnessUnavailable
	>
	readonly interrupt?: (args: {
		readonly session_id: SessionId
		readonly turn: number
		readonly generation: number
	}) => Effect.Effect<void, HarnessUnavailable>
}

export interface CliRunOptions {
	readonly env?: Record<string, string>
	readonly stdin?: string | Stream.Stream<Uint8Array, PlatformError.PlatformError>
	readonly stdinIsTerminal?: boolean
	readonly stdoutIsTerminal?: boolean
	readonly stderrIsTerminal?: boolean
	readonly files?: Record<string, string>
	readonly terminalReads?: ReadonlyArray<Effect.Effect<string, Terminal.QuitError>>
	readonly sigintController?: SigintController
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
}

export const makeTestServer = (handler?: ModelHandler) =>
	Effect.gen(function* () {
		const effective: Required<ModelHandler> = {
			generate: handler?.generate ?? defaultModelHandler.generate,
			interrupt: handler?.interrupt ?? defaultModelHandler.interrupt,
		}
		const ModelProviderLive = boundedModelProvider(Effect.succeed(effective))
		const CheckfuLive = Checkfu.layer(SessionsHandlersLive.pipe(Layer.provide(ModelProviderLive)))
		const ServerLayer = CheckfuLive.pipe(
			Layer.provide(Domain.InMemory),
			Layer.provideMerge(SecureRandom.layerWebCrypto),
			Layer.provideMerge(
				ConfigProvider.layer(ConfigProvider.fromUnknown({ CHECKFU_API_KEY: TEST_API_KEY })),
			),
		)

		const apiContext = yield* Layer.build(ServerLayer)
		const api = yield* makeApiHandler.pipe(Effect.provide(apiContext))

		const dispatchWeb = (request: Request): Promise<Response> =>
			Effect.runPromise(
				api.fetch.pipe(
					Effect.provideService(
						HttpServerRequest.HttpServerRequest,
						HttpServerRequest.fromWeb(request),
					),
					Effect.map((response) => HttpServerResponse.toWeb(response)),
					Effect.provide(apiContext),
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
				): Sink.Sink<void, string | Uint8Array, never, PlatformError.PlatformError> =>
					Sink.forEach((chunk: string | Uint8Array) =>
						Effect.sync(() => {
							target.push(typeof chunk === "string" ? chunk : decoder.decode(chunk))
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
					readFileString: (filePath) =>
						filePath in files
							? Effect.succeed(files[filePath]!)
							: Effect.fail(
									PlatformError.systemError({
										_tag: "NotFound",
										module: "FileSystem",
										method: "readFileString",
										pathOrDescriptor: filePath,
									}),
								),
				})

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
					const request = input instanceof Request ? input : new Request(input, init)
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
						stdout: () => collectSink(stdoutChunks),
						stderr: () => collectSink(stderrChunks),
					}),
					terminalLayer,
					Layer.succeed(
						ChildProcessSpawner.ChildProcessSpawner,
						ChildProcessSpawner.make(() => Effect.die("unused")),
					),
					FetchHttpClient.layer.pipe(
						Layer.provide(Layer.succeed(FetchHttpClient.Fetch, customFetch)),
					),
					SecureRandom.layerWebCrypto,
					Layer.succeed(SigintCoordinator, options?.sigintController ?? makeSigintController()),
					ConfigProvider.layer(ConfigProvider.fromUnknown(envMap)),
				)

				const outcome = yield* Effect.result(runCli(args).pipe(Effect.provide(cliLayer)))
				return {
					exitCode: outcome._tag === "Success" ? 0 : outcome.failure.exitCode,
					stdout: stdoutChunks.join(""),
					stderr: stderrChunks.join(""),
					errorMessage: outcome._tag === "Failure" ? outcome.failure.message : undefined,
				}
			})

		return { run }
	})
