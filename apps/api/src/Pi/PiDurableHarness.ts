import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "@checkfu/domain/Agent/AgentVersionByNumberView.view"
import { AddArtifactVersion } from "@checkfu/domain/Artifact/AddArtifactVersion.command"
import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { CreateArtifact } from "@checkfu/domain/Artifact/CreateArtifact.command"
import { ReserveArtifact } from "@checkfu/domain/Artifact/ReserveArtifact.command"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import { SessionView } from "@checkfu/domain/Session/SessionView.view"
import * as Digest from "effect/crypto/Digest"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { sealArtifactFiles } from "../Artifacts/ArtifactFiles.ts"
import type { ArtifactBlob } from "../Artifacts/ArtifactFiles.ts"
import { ArtifactStore } from "../Artifacts/ArtifactStore.ts"
import { outputsArtifactId, outputsArtifactName } from "../OutputsIdentity.ts"
import type { OutputBytes, OutputFile, OutputsListing } from "../Workspace/SessionOutputs.ts"
import { DEFAULT_TURN_TIMEOUT_MS, boundedHarness } from "@checkfu/domain/Session/Harness.external"
import type { HarnessUnavailable, TurnFailed } from "@checkfu/domain/Session/Harness.external"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import {
	configuredApiCustomProviders,
	resolveCatalogModel,
	supportedProvidersDescription,
} from "./PiCatalog.ts"
import type { PiTurnOutcome, PiTurnRequest } from "./PiTurn.ts"

export class HarnessCallFailed extends Schema.TaggedError<
	HarnessCallFailed,
	{ readonly brand: unique symbol }
>()("HarnessCallFailed", { cause: Schema.Unknown }) {}

export const harnessCall = <A, E, R>(
	call: Effect.Effect<A, E, R>,
): Effect.Effect<A, HarnessCallFailed, R> =>
	Effect.catchCause(call, (cause): Effect.Effect<never, HarnessCallFailed> =>
		Cause.hasInterruptsOnly(cause)
			? Effect.interrupt
			: Effect.fail(new HarnessCallFailed({ cause })),
	)

export interface PiTurnExecutorService {
	readonly recoverTurn: (
		conversation: string,
		operationId: string,
	) => Effect.Effect<PiTurnOutcome | null, HarnessCallFailed>
	readonly runTurn: (
		conversation: string,
		request: PiTurnRequest,
	) => Effect.Effect<PiTurnOutcome, HarnessCallFailed>
	readonly abortTurn: (
		conversation: string,
		operationId: string,
	) => Effect.Effect<void, HarnessCallFailed>
	readonly listOutputs: (sessionId: string) => Effect.Effect<OutputsListing, HarnessCallFailed>
	readonly readOutputs: (
		sessionId: string,
		paths: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyArray<OutputBytes>, HarnessCallFailed>
	readonly discardWorkspace: (sessionId: string) => Effect.Effect<void, HarnessCallFailed>
}

export const HarnessLimits = Context.Reference<{
	readonly attempts: number
	readonly baseDelay: Duration.Input
	readonly interruptTimeout: Duration.Input
	readonly settleMargin: Duration.Input
}>("@checkfu/api/HarnessLimits", {
	defaultValue: () => ({
		attempts: 6,
		baseDelay: "500 millis",
		interruptTimeout: "30 seconds",
		settleMargin: "1 minute",
	}),
})

export const conversationName = (sessionId: string): string => sessionId

const withRetry = <A, E, R>(call: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const { attempts, baseDelay } = yield* HarnessLimits
		return yield* Effect.retry(call, {
			times: attempts - 1,
			schedule: Schedule.exponential(baseDelay).pipe(Schedule.jittered),
		})
	})

export class PiTurnExecutor extends Context.Service<PiTurnExecutor, PiTurnExecutorService>()(
	"@checkfu/api/PiTurnExecutor",
) {}

export const AgentVersionLookupTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/AgentVersionLookupTimeout",
	{ defaultValue: () => "5 seconds" },
)

export const HarnessTurnTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/HarnessTurnTimeout",
	{ defaultValue: () => Duration.millis(DEFAULT_TURN_TIMEOUT_MS) },
)

const settleTimeout = Effect.gen(function* () {
	const { settleMargin } = yield* HarnessLimits
	return Duration.sum(
		Duration.fromInputUnsafe(yield* HarnessTurnTimeout),
		Duration.fromInputUnsafe(settleMargin),
	)
})

export const OutputsPublishTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/OutputsPublishTimeout",
	{ defaultValue: () => "30 seconds" },
)

const OUTPUTS_READ_BATCH_BYTES = 2_000_000

class OutputChanged extends Schema.TaggedError<OutputChanged, { readonly brand: unique symbol }>()(
	"OutputChanged",
	{ path: Schema.String },
) {}

const notPublished = (sessionId: string, reason: string) =>
	Effect.logWarning("Outputs not published", reason).pipe(Effect.annotateLogs({ sessionId }))

const turnOperationId = (turn: number) => `turn:${turn}`

const unpublishedTurns = (lastReplyTurn: number, turn: number): ReadonlyArray<string> =>
	Array.from({ length: Math.max(0, turn - lastReplyTurn - 1) }, (_, i) =>
		turnOperationId(lastReplyTurn + 1 + i),
	)

export const PiDurableHarnessLive = boundedHarness(
	Effect.gen(function* () {
		const agentVersionsByNumber = yield* AgentVersionByNumberView
		const executor = yield* PiTurnExecutor
		const customProviders = yield* configuredApiCustomProviders

		const artifacts = yield* Artifact
		const artifactStore = yield* ArtifactStore
		const sessionViews = yield* SessionView
		const digest = yield* Digest.Digest

		const readMissing = (sessionId: string, wanted: ReadonlyArray<OutputFile>) =>
			Effect.gen(function* () {
				const blobs: Array<ArtifactBlob> = []
				let batch: Array<OutputFile> = []
				let batchBytes = 0
				const flush = Effect.gen(function* () {
					const asked = batch
					batch = []
					batchBytes = 0
					if (asked.length === 0) {
						return
					}
					const read = new Map(
						(yield* executor.readOutputs(
							sessionId,
							asked.map((file) => file.path),
						)).map((file) => [file.path, file.bytes]),
					)
					for (const file of asked) {
						const bytes = read.get(file.path)
						if (
							bytes === undefined ||
							(yield* digest.digestHex(Digest.sha256, bytes)) !== file.sha256
						) {
							return yield* new OutputChanged({ path: file.path })
						}
						blobs.push({ sha256: file.sha256, bytes })
					}
				})
				for (const file of wanted) {
					batch.push(file)
					batchBytes += file.size
					if (batchBytes >= OUTPUTS_READ_BATCH_BYTES) {
						yield* flush
					}
				}
				yield* flush
				return blobs
			})

		const publishOutputsOnce = Effect.fn("PiDurableHarness.publishOutputs")(function* (
			sessionId: string,
			turn: number,
		) {
			const listing = yield* executor.listOutputs(sessionId)
			if (!listing.ok) {
				return yield* notPublished(sessionId, listing.reason)
			}
			if (listing.files.length === 0) {
				return
			}
			const sealed = yield* Effect.result(sealArtifactFiles(digest, listing.files))
			if (Result.isFailure(sealed)) {
				return yield* notPublished(sessionId, sealed.failure.message)
			}
			const { manifest_hash } = sealed.success
			const artifactId = yield* outputsArtifactId(digest, sessionId)
			const current = yield* artifacts.get(artifactId)
			if (current.status === "deleted" || current.manifest === manifest_hash) {
				return
			}
			const held = new Set(
				current.status === "active"
					? ((yield* artifactStore.getManifest(artifactId, current.manifest))?.files.map(
							(file) => file.sha256,
						) ?? [])
					: [],
			)
			const missing = new Map<string, OutputFile>()
			for (const file of listing.files) {
				if (!held.has(file.sha256) && !missing.has(file.sha256)) {
					missing.set(file.sha256, file)
				}
			}
			const blobs = yield* readMissing(sessionId, [...missing.values()])
			const built = { ...sealed.success, blobs }
			const version = {
				artifact_id: artifactId,
				manifest: manifest_hash,
				file_count: sealed.success.file_count,
				total_bytes: sealed.success.total_bytes,
			}
			const sendOptions = {
				commandId: `outputs:${sessionId}:${turn}:${current.version}:${manifest_hash}`,
			}
			if (current.status === "active") {
				yield* artifactStore.stage(artifactId, built, null)
				yield* artifacts.send(
					new AddArtifactVersion({ ...version, expected_version: current.version }),
					sendOptions,
				)
				return
			}
			const reservation = yield* artifacts
				.send(new ReserveArtifact({ artifact_id: artifactId }))
				.pipe(
					Effect.map((reserved) => reserved.reply.reservation),
					Effect.catchTag("ArtifactAlreadyExists", () => Effect.succeed(0)),
				)
			if (reservation === 0) {
				return
			}
			yield* artifactStore.stage(artifactId, built, reservation)
			const session = Option.getOrNull(yield* sessionViews.get(Session.ref(sessionId)))
			yield* artifacts.send(
				new CreateArtifact({
					...version,
					reservation,
					name: outputsArtifactName(sessionId, session?.title ?? null),
				}),
				sendOptions,
			)
		})

		const publishOutputs = (
			sessionId: string,
			turn: number,
			outcome: PiTurnOutcome,
			untilSettled: Duration.Duration,
		) =>
			outcome.ok
				? Effect.flatMap(OutputsPublishTimeout, (limit) =>
						withRetry(publishOutputsOnce(sessionId, turn)).pipe(
							Effect.timeoutOrElse({
								duration: Duration.min(Duration.fromInputUnsafe(limit), untilSettled),
								orElse: () =>
									Effect.logWarning("Outputs not published in time").pipe(
										Effect.annotateLogs({ sessionId }),
									),
							}),
							Effect.catchCause((cause) =>
								Cause.hasInterruptsOnly(cause)
									? Effect.interrupt
									: Effect.logError("Outputs not published", sessionId, cause),
							),
						),
					)
				: Effect.void

		return {
			runTurn: (args) => {
				const conversation = conversationName(args.session_id)
				const settle = Effect.gen(function* () {
					const operationId = turnOperationId(args.turn)

					const recovered = yield* withRetry(executor.recoverTurn(conversation, operationId)).pipe(
						Effect.tapError((error) =>
							Effect.logError("Harness unreachable", conversation, error.cause),
						),
						Effect.mapError((): HarnessUnavailable => ({ _tag: "HarnessUnavailable" })),
					)
					if (recovered !== null) {
						return recovered
					}

					const lookupTimeout = yield* AgentVersionLookupTimeout
					const lookupKey = agentVersionLookupKey(args.agent_id, args.agent_version)
					const missingVersion: TurnFailed = {
						_tag: "TurnFailed",
						error_type: "agent_version_not_found",
						message: `Agent version ${args.agent_id}@${args.agent_version} was not found.`,
						terminal: false,
					}
					const version = yield* agentVersionsByNumber
						.waitFor(lookupKey, { version: args.agent_version }, { timeout: lookupTimeout })
						.pipe(Effect.mapError(() => missingVersion))
					if (version === null) {
						return yield* Effect.fail(missingVersion)
					}

					const resolved = resolveCatalogModel(version.model.id, customProviders)
					if (resolved === null) {
						return yield* Effect.fail<TurnFailed>({
							_tag: "TurnFailed",
							error_type: "unknown_model_error",
							message: `Unsupported model "${version.model.id}". Supported providers: ${supportedProvidersDescription(customProviders)}.`,
							terminal: true,
						})
					}

					const userText = args.input.join("\n")
					if (userText.length === 0) {
						return yield* Effect.fail<TurnFailed>({
							_tag: "TurnFailed",
							error_type: "invalid_turn_input",
							message: "Turn contained no user message to send to Pi.",
							terminal: false,
						})
					}

					const request: PiTurnRequest = {
						operationId,
						turn: args.turn,
						provider: resolved.provider,
						modelId: resolved.modelId,
						system: version.system,
						text: userText,
						...(args.last_reply_turn === undefined
							? {}
							: { unpublishedOperationIds: unpublishedTurns(args.last_reply_turn, args.turn) }),
					}
					const { attempts, baseDelay } = yield* HarnessLimits
					const submitted =
						attempts > 0
							? withRetry(executor.runTurn(conversation, request))
							: Effect.fail(new HarnessCallFailed({ cause: "No submission attempts are allowed" }))
					const outcome = yield* submitted.pipe(
						Effect.catchTag("HarnessCallFailed", (failed) =>
							executor.recoverTurn(conversation, operationId).pipe(
								Effect.delay(baseDelay),
								Effect.filterOrFail(
									(recovered): recovered is PiTurnOutcome => recovered !== null,
									() => failed,
								),
							),
						),
						Effect.tapError((error) =>
							Effect.logError("Harness unreachable", conversation, error.cause),
						),
						Effect.mapError((): HarnessUnavailable => ({ _tag: "HarnessUnavailable" })),
					)

					return outcome
				})
				return Effect.gen(function* () {
					const duration = yield* settleTimeout
					const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(duration)
					const outcome = yield* Effect.timeoutOrElse(settle, {
						duration,
						orElse: () =>
							Effect.andThen(
								Effect.logError("Harness did not settle the turn in time", conversation),
								Effect.fail<HarnessUnavailable>({ _tag: "HarnessUnavailable" }),
							),
					})
					const left = Duration.millis(Math.max(0, deadline - (yield* Clock.currentTimeMillis)))
					yield* publishOutputs(args.session_id, args.turn, outcome, left)
					if (!outcome.ok) {
						return yield* Effect.fail(outcome.error)
					}
					return outcome.reply
				})
			},
			interrupt: (args) =>
				Effect.gen(function* () {
					const { interruptTimeout } = yield* HarnessLimits
					yield* withRetry(
						executor.abortTurn(conversationName(args.session_id), turnOperationId(args.turn)),
					).pipe(Effect.timeout(interruptTimeout))
				}).pipe(
					Effect.tapError((error) =>
						Effect.logError("Interrupt not delivered to the harness", error),
					),
					Effect.mapError((): HarnessUnavailable => ({ _tag: "HarnessUnavailable" })),
				),
			discardWorkspace: (args) =>
				withRetry(executor.discardWorkspace(args.session_id)).pipe(
					Effect.tap(() => Effect.logInfo("Workspace discarded", args.session_id)),
					Effect.tapError((error) =>
						Effect.logError("Workspace not discarded", args.session_id, error.cause),
					),
					Effect.orDie,
				),
		}
	}),
)

export const makePiTurnExecutorLayer = (
	turns: Omit<PiTurnExecutorService, "discardWorkspace" | "listOutputs" | "readOutputs">,
	workspaces: Pick<PiTurnExecutorService, "discardWorkspace" | "listOutputs" | "readOutputs"> = {
		discardWorkspace: () => Effect.void,
		listOutputs: () => Effect.succeed({ ok: true, files: [] }),
		readOutputs: () => Effect.succeed([]),
	},
) => Layer.succeed(PiTurnExecutor, { ...turns, ...workspaces })
