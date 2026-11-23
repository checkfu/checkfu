import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "@checkfu/domain/Agent/AgentVersionByNumberView.view"
import { DEFAULT_TURN_TIMEOUT_MS, boundedHarness } from "@checkfu/domain/Session/Harness.external"
import type { HarnessUnavailable, TurnFailed } from "@checkfu/domain/Session/Harness.external"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import { SessionView } from "@checkfu/domain/Session/SessionView.view"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import {
	PI_SEED_MAX_CHARS,
	PI_SEED_MAX_MESSAGES,
	PI_SEED_MAX_SCAN_PAGES,
	SEED_MESSAGE_OVERHEAD_TOKENS,
	estimateSeedTokens,
	seedTokenBudget,
	trailingCodePointCost,
	trimTailToBudget,
} from "./PiContextBudget.ts"
import { resolveCatalogModel } from "./PiCatalog.ts"
import type { PiSeed, PiSeedMessage, PiTurnOutcome, PiTurnRequest, PiTurnResult } from "./PiTurn.ts"

export class HarnessCallFailed extends Schema.TaggedError<
	HarnessCallFailed,
	{ readonly brand: unique symbol }
>()("HarnessCallFailed", { cause: Schema.Unknown }) {}

export interface PiTurnExecutorService {
	readonly recoverTurn: (
		conversation: string,
		operationId: string,
	) => Effect.Effect<PiTurnOutcome | null, HarnessCallFailed>
	readonly runTurn: (
		conversation: string,
		request: PiTurnRequest,
	) => Effect.Effect<PiTurnResult, HarnessCallFailed>
	readonly abortTurn: (
		conversation: string,
		operationId: string,
	) => Effect.Effect<void, HarnessCallFailed>
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

export const conversationName = (sessionId: string, generation: number): string =>
	`${generation}:${sessionId}`

const withRetry = <A>(call: Effect.Effect<A, HarnessCallFailed>) =>
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

export const SeedMaxScanPages = Context.Reference<number>("@checkfu/api/SeedMaxScanPages", {
	defaultValue: () => PI_SEED_MAX_SCAN_PAGES,
})

const SEED_PAGE_SIZE = 100

const turnOperationId = (turn: number) => `turn:${turn}`

const allocatePairBudget = (
	total: number,
	minA: number,
	needA: number,
	minB: number,
	needB: number,
): readonly [number, number] | null => {
	if (minA + minB > total) {
		return null
	}
	const extra = total - minA - minB
	const extraNeedA = Math.max(0, needA - minA)
	const extraNeedB = Math.max(0, needB - minB)
	const halfExtra = Math.floor(extra / 2)
	const extraA =
		extraNeedB < extra - halfExtra
			? Math.min(extraNeedA, extra - extraNeedB)
			: Math.min(extraNeedA, halfExtra)
	const extraB = Math.min(extraNeedB, extra - extraA)
	return [minA + extraA, minB + extraB] as const
}

const HISTORY_UNAVAILABLE: TurnFailed = {
	_tag: "TurnFailed",
	error_type: "session_history_unavailable",
	message: "Could not rebuild the conversation from the session's events.",
	terminal: false,
}

export const PiDurableHarnessLive = boundedHarness(
	Effect.gen(function* () {
		const agentVersionsByNumber = yield* AgentVersionByNumberView
		const sessionViews = yield* SessionView
		const executor = yield* PiTurnExecutor

		const messagesBeforeTurn = Effect.fn("PiDurableHarness.messagesBeforeTurn")(function* (
			sessionId: string,
			turn: number,
			budget: {
				readonly contextWindow: number
				readonly system: string | null
				readonly currentInput: string
			},
		) {
			const minPairTokens = 2 * SEED_MESSAGE_OVERHEAD_TOKENS + 2
			let remainingTokens = seedTokenBudget(budget)

			const ref = Session.ref(sessionId)
			yield* sessionViews.waitFor(ref, { turn }, { timeout: yield* AgentVersionLookupTimeout })

			if (remainingTokens < minPairTokens) {
				const current = Option.getOrNull(yield* sessionViews.get(ref))
				if (current?.turn !== turn) {
					return yield* Effect.fail(HISTORY_UNAVAILABLE)
				}
				return { messages: [] as ReadonlyArray<PiSeedMessage>, trimmed: true }
			}

			const maxScanPages = Math.max(1, yield* SeedMaxScanPages)

			const newestFirst: Array<PiSeedMessage> = []
			let roomChars = PI_SEED_MAX_CHARS
			let budgetExhausted = false

			const keepExchange = (userText: string, assistantText: string) => {
				if (userText.length === 0 || assistantText.length === 0) {
					return
				}
				if (
					newestFirst.length + 2 > PI_SEED_MAX_MESSAGES ||
					roomChars < 2 ||
					remainingTokens < minPairTokens
				) {
					budgetExhausted = true
					return
				}

				const pairAvailableTokens = remainingTokens - 2 * SEED_MESSAGE_OVERHEAD_TOKENS
				const pairAvailableChars = roomChars
				const userTokens = estimateSeedTokens(userText)
				const assistantTokens = estimateSeedTokens(assistantText)

				if (
					userTokens + assistantTokens <= pairAvailableTokens &&
					userText.length + assistantText.length <= pairAvailableChars
				) {
					newestFirst.push(
						{ role: "assistant", text: assistantText },
						{ role: "user", text: userText },
					)
					roomChars -= userText.length + assistantText.length
					remainingTokens -= userTokens + assistantTokens + 2 * SEED_MESSAGE_OVERHEAD_TOKENS
					if (
						newestFirst.length + 2 > PI_SEED_MAX_MESSAGES ||
						roomChars < 2 ||
						remainingTokens < minPairTokens
					) {
						budgetExhausted = true
					}
					return
				}

				// Reserve one complete trailing code point on each side before splitting the
				// remainder, then pass any unspent boundary slack to the other side so a
				// multi-byte code point never causes a fitting exchange to be dropped.
				const userMin = trailingCodePointCost(userText)
				const assistantMin = trailingCodePointCost(assistantText)
				const tokenSplit = allocatePairBudget(
					pairAvailableTokens,
					userMin.bytes,
					userTokens,
					assistantMin.bytes,
					assistantTokens,
				)
				const charSplit = allocatePairBudget(
					pairAvailableChars,
					userMin.chars,
					userText.length,
					assistantMin.chars,
					assistantText.length,
				)
				if (tokenSplit !== null && charSplit !== null) {
					const [userTargetTokens] = tokenSplit
					const [userTargetChars] = charSplit
					const initialUser = trimTailToBudget(userText, userTargetChars, userTargetTokens)
					const assistantFinalChars = Math.min(
						assistantText.length,
						pairAvailableChars - initialUser.length,
					)
					const assistantFinalTokens = Math.min(
						assistantTokens,
						pairAvailableTokens - estimateSeedTokens(initialUser),
					)
					const keptAssistant = trimTailToBudget(
						assistantText,
						assistantFinalChars,
						assistantFinalTokens,
					)
					const userFinalChars = Math.min(
						userText.length,
						pairAvailableChars - keptAssistant.length,
					)
					const userFinalTokens = Math.min(
						userTokens,
						pairAvailableTokens - estimateSeedTokens(keptAssistant),
					)
					const keptUser =
						userFinalChars > userTargetChars || userFinalTokens > userTargetTokens
							? trimTailToBudget(userText, userFinalChars, userFinalTokens)
							: initialUser
					if (keptUser.length > 0 && keptAssistant.length > 0) {
						newestFirst.push(
							{ role: "assistant", text: keptAssistant },
							{ role: "user", text: keptUser },
						)
						roomChars -= keptUser.length + keptAssistant.length
						remainingTokens = Math.max(
							0,
							remainingTokens -
								(estimateSeedTokens(keptUser) +
									estimateSeedTokens(keptAssistant) +
									2 * SEED_MESSAGE_OVERHEAD_TOKENS),
						)
					}
				}
				budgetExhausted = true
			}

			let boundaries = 0
			// Holds the assistant reply of the turn whose `session.status_running` we just
			// crossed. We emit `(user, assistant)` atomically once we collect its user input
			// at the next boundary, skipping interrupted/failed turns that produced no reply.
			let pendingReply: string | null = null
			let input: Array<string> = []
			let reply: Array<string> = []
			let pagesScanned = 0
			let after: number | undefined
			let reachedBeginning = false

			while (!budgetExhausted && pagesScanned < maxScanPages) {
				const page = yield* sessionViews.list(ref, {
					...(after === undefined ? {} : { after }),
					take: SEED_PAGE_SIZE,
					order: "desc",
				})
				pagesScanned += 1
				for (const { event } of page.entries) {
					if (event._tag === "session.status_running") {
						if (boundaries > 0) {
							if (pendingReply !== null) {
								keepExchange(input.join("\n"), pendingReply)
							}
							const nextReply = reply.join("")
							pendingReply = nextReply.length > 0 ? nextReply : null
							input = []
							reply = []
							if (budgetExhausted) {
								break
							}
						}
						boundaries += 1
					} else if (event._tag === "agent.message" && boundaries > 0) {
						reply.unshift(event.content.map((block) => block.text).join(""))
					} else if (event._tag === "user.message" && pendingReply !== null) {
						input.unshift(
							...event.content.map((block) => block.text).filter((text) => text.length > 0),
						)
					}
				}
				if (budgetExhausted) {
					break
				}
				if (page.cursor === null) {
					if (boundaries === 0) {
						return yield* Effect.fail(HISTORY_UNAVAILABLE)
					}
					if (pendingReply !== null) {
						keepExchange(input.join("\n"), pendingReply)
					}
					reachedBeginning = true
					break
				}
				after = page.cursor
			}

			if (boundaries === 0) {
				return yield* Effect.fail(HISTORY_UNAVAILABLE)
			}

			const current = Option.getOrNull(yield* sessionViews.get(ref))
			if (current?.turn !== turn) {
				return yield* Effect.fail(HISTORY_UNAVAILABLE)
			}

			return {
				messages: newestFirst.toReversed(),
				trimmed: budgetExhausted || !reachedBeginning,
			}
		})

		return {
			runTurn: (args) =>
				Effect.gen(function* () {
					const { settleMargin } = yield* HarnessLimits
					const settleTimeout = Duration.sum(
						Duration.fromInputUnsafe(yield* HarnessTurnTimeout),
						Duration.fromInputUnsafe(settleMargin),
					)
					const conversation = conversationName(args.session_id, args.generation)
					const operationId = turnOperationId(args.turn)

					// Recover any already-admitted or settled Pi operation before checking
					// mutable prerequisites (views, API keys) so a replay after a RunTurn
					// restart always records Pi's actual outcome instead of diverging from
					// Pi's live conversation history.
					const recovered = yield* withRetry(executor.recoverTurn(conversation, operationId)).pipe(
						Effect.tapError((error) =>
							Effect.logError("Harness unreachable", conversation, error.cause),
						),
						Effect.mapError((): HarnessUnavailable => ({ _tag: "HarnessUnavailable" })),
						Effect.timeoutOrElse({
							duration: settleTimeout,
							orElse: () =>
								Effect.andThen(
									Effect.logError("Harness did not settle the turn in time", conversation),
									Effect.fail<HarnessUnavailable>({ _tag: "HarnessUnavailable" }),
								),
						}),
					)
					if (recovered !== null) {
						if (!recovered.ok) {
							return yield* Effect.fail(recovered.error)
						}
						return recovered.reply
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

					const resolved = resolveCatalogModel(version.model.id)
					if (resolved === null) {
						return yield* Effect.fail<TurnFailed>({
							_tag: "TurnFailed",
							error_type: "unknown_model_error",
							message: `Unsupported model "${version.model.id}". Only OpenAI and Anthropic models are supported.`,
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

					const run = (seed?: PiSeed) =>
						Effect.gen(function* () {
							const { attempts, baseDelay } = yield* HarnessLimits
							const request: PiTurnRequest = {
								operationId,
								turn: args.turn,
								provider: resolved.provider,
								modelId: resolved.model.id,
								system: version.system,
								text: userText,
								...(seed === undefined ? {} : { seed }),
							}
							const attemptCall = Effect.gen(function* () {
								const { attempt } = yield* Schedule.CurrentMetadata
								if (attempt > 0) {
									// After an ambiguous RPC failure, check whether Pi already admitted
									// or settled this operation before submitting it again.
									const recoveredAttempt = yield* executor.recoverTurn(conversation, operationId)
									if (recoveredAttempt !== null) {
										return recoveredAttempt
									}
								}
								return yield* executor.runTurn(conversation, request)
							})
							const finalRecoveryProbe = (initialLastError?: HarnessCallFailed) =>
								Effect.gen(function* () {
									// Perform one bounded read-only recovery probe after the final failed
									// submission so a saved reply whose RPC receipt was lost is still
									// recovered instead of abandoning the turn and advancing generation.
									yield* Effect.sleep(baseDelay)
									const finalProbe = yield* Effect.result(
										executor.recoverTurn(conversation, operationId),
									)
									if (Result.isSuccess(finalProbe) && finalProbe.success !== null) {
										return finalProbe.success
									}
									const finalError = Result.isFailure(finalProbe)
										? finalProbe.failure
										: initialLastError
									yield* Effect.logError("Harness unreachable", conversation, finalError?.cause)
									return yield* Effect.fail<HarnessUnavailable>({ _tag: "HarnessUnavailable" })
								})
							if (attempts <= 0) {
								return yield* finalRecoveryProbe()
							}
							return yield* attemptCall.pipe(
								Effect.retry({
									times: attempts - 1,
									while: Schema.is(HarnessCallFailed),
									schedule: Schedule.exponential(baseDelay).pipe(Schedule.jittered),
								}),
								Effect.catchTag("HarnessCallFailed", finalRecoveryProbe),
							)
						})

					const outcome = yield* Effect.gen(function* () {
						const first = yield* run()
						if (first !== "history_required") {
							return first
						}
						const { messages, trimmed } = yield* messagesBeforeTurn(args.session_id, args.turn, {
							contextWindow: resolved.model.contextWindow,
							system: version.system,
							currentInput: userText,
						}).pipe(Effect.mapError(() => HISTORY_UNAVAILABLE))
						return yield* run({ api: resolved.model.api, messages, trimmed })
					}).pipe(
						Effect.timeoutOrElse({
							duration: settleTimeout,
							orElse: () =>
								Effect.andThen(
									Effect.logError("Harness did not settle the turn in time", conversation),
									Effect.fail<HarnessUnavailable>({ _tag: "HarnessUnavailable" }),
								),
						}),
					)
					if (outcome === "history_required") {
						return yield* Effect.fail(HISTORY_UNAVAILABLE)
					}

					if (!outcome.ok) {
						return yield* Effect.fail(outcome.error)
					}
					return outcome.reply
				}),
			interrupt: (args) =>
				Effect.gen(function* () {
					const { interruptTimeout } = yield* HarnessLimits
					yield* withRetry(
						executor.abortTurn(
							conversationName(args.session_id, args.generation),
							turnOperationId(args.turn),
						),
					).pipe(Effect.timeout(interruptTimeout))
				}).pipe(
					Effect.tapError((error) =>
						Effect.logError("Interrupt not delivered to the harness", error),
					),
					Effect.mapError((): HarnessUnavailable => ({ _tag: "HarnessUnavailable" })),
				),
		}
	}),
)

export const makePiTurnExecutorLayer = (service: PiTurnExecutorService) =>
	Layer.succeed(PiTurnExecutor, service)
