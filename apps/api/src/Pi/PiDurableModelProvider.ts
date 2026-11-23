import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "@checkfu/agents/Agent/AgentVersionByNumberView.view"
import { Environment } from "@checkfu/environments/Environment/Environment.aggregate"
import { EnvironmentId } from "@checkfu/environments/Environment/Environment.id"
import { EnvironmentView } from "@checkfu/environments/Environment/EnvironmentView.view"
import {
	type HarnessUnavailable,
	DEFAULT_MODEL_TIMEOUT_MS,
	type ModelProviderError,
	boundedModelProvider,
} from "@checkfu/sessions/Session/ModelProvider.external"
import { Session } from "@checkfu/sessions/Session/Session.aggregate"
import { SessionView } from "@checkfu/sessions/Session/SessionView.view"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Url from "effect/http/Url"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
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
import type { PiSeed, PiSeedMessage, PiTurnRequest, PiTurnResult } from "./PiDurableEngine.ts"
import {
	PROVIDER_API_KEY_ENV,
	createPiModels,
	providerApiKeys,
	providerBaseUrls,
	resolveCatalogModel,
} from "./PiModels.ts"
import type { PiTurnOutcome } from "./PiRefusals.ts"

export class HarnessCallFailed extends Data.TaggedError("HarnessCallFailed")<{
	readonly cause: unknown
}> {}

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
	readonly baseDelayMs: number
	readonly interruptTimeoutMs: number
	readonly settleMarginMs: number
}>("@checkfu/api/HarnessLimits", {
	defaultValue: () => ({
		attempts: 6,
		baseDelayMs: 500,
		interruptTimeoutMs: 30_000,
		settleMarginMs: 60_000,
	}),
})

export const conversationName = (sessionId: string, generation: number): string =>
	`${generation}:${sessionId}`

const withRetry = <A>(call: Effect.Effect<A, HarnessCallFailed>) =>
	Effect.gen(function* () {
		const { attempts, baseDelayMs } = yield* HarnessLimits
		return yield* Effect.retry(call, {
			times: attempts - 1,
			schedule: Schedule.exponential(Duration.millis(baseDelayMs)),
		})
	})

export class PiTurnExecutor extends Context.Service<PiTurnExecutor, PiTurnExecutorService>()(
	"PiTurnExecutor",
) {}

export const AgentVersionLookupTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/AgentVersionLookupTimeout",
	{ defaultValue: () => "5 seconds" },
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
	if (minA + minB > total) return null
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

const HISTORY_UNAVAILABLE: ModelProviderError = {
	_tag: "ModelProviderError",
	error_type: "session_history_unavailable",
	message: "Could not rebuild the conversation from the session's events.",
	terminal: false,
}

const normalizeHost = (host: string): string =>
	host.endsWith(".") ? host.slice(0, -1).toLowerCase() : host.toLowerCase()

const IPV6_LITERAL_INNER = /^[0-9a-fA-F:.]+$/

const parseAllowedHostEntry = (
	trimmed: string,
): { readonly host: string; readonly port: string | null } | null => {
	if (trimmed.length === 0 || trimmed.includes("/") || trimmed.includes("://")) return null
	if (trimmed.startsWith("[")) {
		const closeBracket = trimmed.indexOf("]")
		if (closeBracket === -1) return null
		const inner = trimmed.slice(1, closeBracket)
		if (!inner.includes(":") || !IPV6_LITERAL_INNER.test(inner)) return null
		const bracketedHost = trimmed.slice(0, closeBracket + 1)
		const rest = trimmed.slice(closeBracket + 1)
		let port: string | null = null
		if (rest.length > 0) {
			if (!rest.startsWith(":")) return null
			port = rest.slice(1)
			if (!/^\d+$/.test(port)) return null
		}
		try {
			const parsed = new URL(`http://${bracketedHost}`)
			if (
				parsed.username.length > 0 ||
				parsed.password.length > 0 ||
				parsed.port.length > 0 ||
				parsed.pathname !== "/" ||
				parsed.search.length > 0 ||
				parsed.hash.length > 0 ||
				!parsed.hostname.startsWith("[") ||
				!parsed.hostname.endsWith("]")
			) {
				return null
			}
			return { host: parsed.hostname.toLowerCase(), port }
		} catch {
			return null
		}
	}
	if (trimmed.includes("[") || trimmed.includes("]")) return null
	const colonIndex = trimmed.lastIndexOf(":")
	let hostPattern = trimmed
	let port: string | null = null
	if (colonIndex !== -1) {
		port = trimmed.slice(colonIndex + 1)
		if (!/^\d+$/.test(port)) return null
		hostPattern = trimmed.slice(0, colonIndex)
		if (hostPattern.includes(":")) return null
	}
	const host = normalizeHost(hostPattern)
	return host.length === 0 ? null : { host, port }
}

const isAllowedHost = (targetUrl: URL, allowedHosts: ReadonlyArray<string>): boolean => {
	if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") return false
	const targetHost = normalizeHost(targetUrl.hostname)
	if (targetHost.length === 0) return false
	const targetPort = targetUrl.port || (targetUrl.protocol === "https:" ? "443" : "80")

	return allowedHosts.some((rawEntry) => {
		const parsed = parseAllowedHostEntry(rawEntry.trim())
		if (parsed === null) return false
		if (parsed.port !== null && parsed.port !== targetPort) return false
		const rule = parsed.host
		if (rule === targetHost) return true
		if (rule.startsWith("*.")) {
			const suffix = rule.slice(1)
			// Require a concrete base domain (at least two labels after "*."), e.g. "*.openai.com".
			if (suffix.length <= 1 || suffix.includes("*") || !suffix.slice(1).includes(".")) {
				return false
			}
			return targetHost.endsWith(suffix) && targetHost.length > suffix.length
		}
		return false
	})
}

export const PiDurableModelProviderLive = boundedModelProvider(
	Effect.gen(function* () {
		const agentVersionsByNumber = yield* AgentVersionByNumberView
		const environments = yield* Environment
		const environmentViews = yield* EnvironmentView
		const sessionViews = yield* SessionView
		const executor = yield* PiTurnExecutor
		const apiKeys = yield* providerApiKeys
		const baseUrls = yield* providerBaseUrls
		const catalog = createPiModels(apiKeys, baseUrls)

		const enforceEnvironmentNetworking = Effect.fnUntraced(function* (
			rawEnvironmentId: string,
			providerBaseUrl: string,
			lookupTimeout: Duration.Input,
		) {
			const envId = EnvironmentId.make(rawEnvironmentId)
			const envState = yield* environments.get(envId)
			if (envState.status === "" || envState.status === "deleted") {
				return yield* Effect.fail<ModelProviderError>({
					_tag: "ModelProviderError",
					error_type: "environment_not_found",
					message: `Environment ${rawEnvironmentId} is no longer available.`,
					terminal: envState.status === "deleted",
				})
			}

			const envRef = Environment.ref(envId)
			let envSnapshot = Option.getOrNull(
				yield* environmentViews.get(envRef).pipe(Effect.orElseSucceed(() => Option.none())),
			)
			if (envSnapshot === null || envSnapshot.version < envState.version) {
				envSnapshot = yield* environmentViews
					.waitFor(envRef, { version: { gte: envState.version } }, { timeout: lookupTimeout })
					.pipe(Effect.orElseSucceed(() => null))
			}
			if (envSnapshot === null || envSnapshot.version < envState.version) {
				const latest = yield* environments.get(envId)
				if (latest.status === "deleted") {
					return yield* Effect.fail<ModelProviderError>({
						_tag: "ModelProviderError",
						error_type: "environment_not_found",
						message: `Environment ${rawEnvironmentId} is no longer available.`,
						terminal: true,
					})
				}
				return yield* Effect.fail<ModelProviderError>({
					_tag: "ModelProviderError",
					error_type: "environment_unavailable",
					message: `Environment ${rawEnvironmentId} configuration is not ready.`,
					terminal: false,
				})
			}

			const { networking } = envSnapshot.config
			if (networking.type !== "limited") return

			const parsedUrlResult = Url.fromString(providerBaseUrl)
			if (Result.isFailure(parsedUrlResult)) {
				return yield* Effect.fail<ModelProviderError>({
					_tag: "ModelProviderError",
					error_type: "environment_network_blocked",
					message: `Environment ${rawEnvironmentId} cannot verify the provider endpoint URL.`,
					terminal: false,
				})
			}
			const parsedUrl = parsedUrlResult.success

			if (!isAllowedHost(parsedUrl, networking.allowed_hosts)) {
				return yield* Effect.fail<ModelProviderError>({
					_tag: "ModelProviderError",
					error_type: "environment_network_blocked",
					message: `Environment ${rawEnvironmentId} does not allow outbound requests to ${parsedUrl.hostname}.`,
					terminal: false,
				})
			}
		})

		const messagesBeforeTurn = Effect.fnUntraced(function* (
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
				if (current?.turn !== turn) return yield* Effect.fail(HISTORY_UNAVAILABLE)
				return { messages: [] as ReadonlyArray<PiSeedMessage>, trimmed: true }
			}

			const maxScanPages = Math.max(1, yield* SeedMaxScanPages)

			const newestFirst: Array<PiSeedMessage> = []
			let roomChars = PI_SEED_MAX_CHARS
			let budgetExhausted = false

			const keepExchange = (userText: string, assistantText: string) => {
				if (userText.length === 0 || assistantText.length === 0) return
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
							if (budgetExhausted) break
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
				if (budgetExhausted) break
				if (page.cursor === null) {
					if (boundaries === 0) return yield* Effect.fail(HISTORY_UNAVAILABLE)
					if (pendingReply !== null) {
						keepExchange(input.join("\n"), pendingReply)
					}
					reachedBeginning = true
					break
				}
				after = page.cursor
			}

			if (boundaries === 0) return yield* Effect.fail(HISTORY_UNAVAILABLE)

			const current = Option.getOrNull(yield* sessionViews.get(ref))
			if (current?.turn !== turn) return yield* Effect.fail(HISTORY_UNAVAILABLE)

			return {
				messages: newestFirst.toReversed(),
				trimmed: budgetExhausted || !reachedBeginning,
			}
		})

		return {
			generate: (args) =>
				Effect.gen(function* () {
					const { settleMarginMs } = yield* HarnessLimits
					const conversation = conversationName(args.session_id, args.generation)
					const operationId = turnOperationId(args.turn)

					// Recover any already-admitted or settled Pi operation before checking
					// mutable prerequisites (views, environment policy, API keys) so a replay
					// after a RunTurn restart always records Pi's actual outcome instead of
					// diverging from Pi's live conversation history.
					const recovered = yield* withRetry(executor.recoverTurn(conversation, operationId)).pipe(
						Effect.catchTag("HarnessCallFailed", (error) =>
							Effect.andThen(
								Effect.logError("Harness unreachable", conversation, error.cause),
								Effect.fail<HarnessUnavailable>({ _tag: "HarnessUnavailable" }),
							),
						),
						Effect.timeoutOption(Duration.millis(DEFAULT_MODEL_TIMEOUT_MS + settleMarginMs)),
					)
					if (Option.isNone(recovered)) {
						yield* Effect.logError("Harness did not settle the turn in time", conversation)
						return yield* Effect.fail<HarnessUnavailable>({ _tag: "HarnessUnavailable" })
					}
					if (recovered.value !== null) {
						if (!recovered.value.ok) {
							return yield* Effect.fail(recovered.value.error)
						}
						return recovered.value.reply
					}

					const lookupTimeout = yield* AgentVersionLookupTimeout
					const lookupKey = agentVersionLookupKey(args.agent_id, args.agent_version)
					const missingVersion: ModelProviderError = {
						_tag: "ModelProviderError",
						error_type: "agent_version_not_found",
						message: `Agent version ${args.agent_id}@${args.agent_version} was not found.`,
						terminal: false,
					}
					const version = yield* agentVersionsByNumber
						.waitFor(lookupKey, { version: args.agent_version }, { timeout: lookupTimeout })
						.pipe(Effect.mapError(() => missingVersion))
					if (version === null) return yield* Effect.fail(missingVersion)

					const resolved = resolveCatalogModel(catalog, version.model.id)
					if (resolved === null) {
						return yield* Effect.fail<ModelProviderError>({
							_tag: "ModelProviderError",
							error_type: "unknown_model_error",
							message: `Unsupported model "${version.model.id}". Only OpenAI and Anthropic models are supported.`,
							terminal: true,
						})
					}

					const userText = args.input.join("\n")
					if (userText.length === 0) {
						return yield* Effect.fail<ModelProviderError>({
							_tag: "ModelProviderError",
							error_type: "invalid_turn_input",
							message: "Turn contained no user message to send to Pi.",
							terminal: false,
						})
					}

					yield* enforceEnvironmentNetworking(
						args.environment_id,
						resolved.model.baseUrl,
						lookupTimeout,
					)

					if (apiKeys[resolved.provider] === null) {
						return yield* Effect.fail<ModelProviderError>({
							_tag: "ModelProviderError",
							error_type: "missing_api_key_error",
							message: `Missing ${PROVIDER_API_KEY_ENV[resolved.provider]} for provider "${resolved.provider}".`,
							terminal: false,
						})
					}

					const run = (seed?: PiSeed) =>
						Effect.gen(function* () {
							const { attempts, baseDelayMs } = yield* HarnessLimits
							const request: PiTurnRequest = {
								operationId,
								turn: args.turn,
								provider: resolved.provider,
								modelId: resolved.model.id,
								system: version.system,
								text: userText,
								...(seed === undefined ? {} : { seed }),
							}
							let lastError: HarnessCallFailed | null = null
							for (let attempt = 0; attempt < attempts; attempt++) {
								if (attempt > 0) {
									yield* Effect.sleep(Duration.millis(baseDelayMs * 2 ** (attempt - 1)))
									// After an ambiguous RPC failure, check whether Pi already admitted
									// or settled this operation before rechecking mutable policy; if not
									// admitted, revalidate the environment so revocations during backoff
									// prevent dispatching the transcript under stale permissions.
									const recoveredAttempt = yield* executor
										.recoverTurn(conversation, operationId)
										.pipe(
											Effect.map((outcome) => ({ ok: true as const, outcome })),
											Effect.catchTag("HarnessCallFailed", (error) =>
												Effect.succeed({ ok: false as const, error }),
											),
										)
									if (!recoveredAttempt.ok) {
										lastError = recoveredAttempt.error
										continue
									}
									if (recoveredAttempt.outcome !== null) return recoveredAttempt.outcome
									yield* enforceEnvironmentNetworking(
										args.environment_id,
										resolved.model.baseUrl,
										lookupTimeout,
									)
								}
								const attemptResult = yield* executor.runTurn(conversation, request).pipe(
									Effect.map((outcome) => ({ ok: true as const, outcome })),
									Effect.catchTag("HarnessCallFailed", (error) =>
										Effect.succeed({ ok: false as const, error }),
									),
								)
								if (attemptResult.ok) return attemptResult.outcome
								lastError = attemptResult.error
							}
							// Perform one bounded read-only recovery probe after the final failed
							// submission so a saved reply whose RPC receipt was lost is still
							// recovered instead of abandoning the turn and advancing generation.
							yield* Effect.sleep(Duration.millis(baseDelayMs))
							const finalRecovered = yield* executor.recoverTurn(conversation, operationId).pipe(
								Effect.catchTag("HarnessCallFailed", (error) => {
									lastError = error
									return Effect.succeed(null)
								}),
							)
							if (finalRecovered !== null) return finalRecovered
							yield* Effect.logError("Harness unreachable", conversation, lastError?.cause)
							return yield* Effect.fail<HarnessUnavailable>({ _tag: "HarnessUnavailable" })
						})

					const settled = yield* Effect.gen(function* () {
						const first = yield* run()
						if (first !== "history_required") return first
						const { messages, trimmed } = yield* messagesBeforeTurn(args.session_id, args.turn, {
							contextWindow: resolved.model.contextWindow,
							system: version.system,
							currentInput: userText,
						}).pipe(Effect.mapError(() => HISTORY_UNAVAILABLE))
						yield* enforceEnvironmentNetworking(
							args.environment_id,
							resolved.model.baseUrl,
							lookupTimeout,
						)
						return yield* run({ api: resolved.model.api, messages, trimmed })
					}).pipe(Effect.timeoutOption(Duration.millis(DEFAULT_MODEL_TIMEOUT_MS + settleMarginMs)))
					if (Option.isNone(settled)) {
						yield* Effect.logError("Harness did not settle the turn in time", conversation)
						return yield* Effect.fail<HarnessUnavailable>({ _tag: "HarnessUnavailable" })
					}
					const outcome = settled.value
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
					const { interruptTimeoutMs } = yield* HarnessLimits
					yield* withRetry(
						executor.abortTurn(
							conversationName(args.session_id, args.generation),
							turnOperationId(args.turn),
						),
					).pipe(Effect.timeout(Duration.millis(interruptTimeoutMs)))
				}).pipe(
					Effect.catch((error) =>
						Effect.andThen(
							Effect.logError("Interrupt not delivered to the harness", error),
							Effect.fail<HarnessUnavailable>({ _tag: "HarnessUnavailable" }),
						),
					),
				),
		}
	}),
)

export const makePiTurnExecutorLayer = (service: PiTurnExecutorService) =>
	Layer.succeed(PiTurnExecutor, service)
