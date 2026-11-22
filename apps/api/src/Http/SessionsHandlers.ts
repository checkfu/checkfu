import type * as Domain from "@alchemy.run/domain"
import { createHash } from "node:crypto"
import { AgentId } from "@checkfu/agents/Agent/Agent.id"
import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "@checkfu/agents/Agent/AgentVersionByNumberView.view"
import { EnvironmentId } from "@checkfu/environments/Environment/Environment.id"
import { ArchiveSession } from "@checkfu/sessions/Session/ArchiveSession.command"
import { SendUserInterrupt } from "@checkfu/sessions/Session/SendUserInterrupt.command"
import { SendUserMessage } from "@checkfu/sessions/Session/SendUserMessage.command"
import { Session } from "@checkfu/sessions/Session/Session.aggregate"
import { SessionId } from "@checkfu/sessions/Session/Session.id"
import { MAX_MESSAGE_TEXT_LENGTH, MessageText } from "@checkfu/sessions/Session/SessionTypes"
import { type SessionSnapshot, SessionView } from "@checkfu/sessions/Session/SessionView.view"
import * as Context from "effect/Context"
import * as SecureRandom from "effect/crypto/SecureRandom"
import type * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import {
	AdmitSession,
	AdmitSessionDecision,
	ClaimEventBatch,
	EventBatch,
	EventBatchId,
} from "../Checkfu.model.ts"
import { AgentVersionWaitTimeout } from "./AgentsHandlers.ts"
import { CheckfuApi, SessionEvent, statusOf } from "./Api.ts"
import {
	commitForStream,
	currentRequestId,
	handled,
	isPending,
	orPending,
	present,
	randomId,
	reject,
	settled,
	toApiError,
} from "./HttpHelpers.ts"

export const SSE_CATCHUP_PAGE_SIZE = 100
export const DEFAULT_SSE_KEEPALIVE_MS = 15_000
export const DEFAULT_SSE_MAX_CONNECTION_MS = 240_000

export const SseKeepaliveMs = Context.Reference<number>("@checkfu/api/SseKeepaliveMs", {
	defaultValue: () => DEFAULT_SSE_KEEPALIVE_MS,
})

export const SseMaxConnectionMs = Context.Reference<number>("@checkfu/api/SseMaxConnectionMs", {
	defaultValue: () => DEFAULT_SSE_MAX_CONNECTION_MS,
})

export const SessionReadWaitTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/SessionReadWaitTimeout",
	{ defaultValue: () => "5 seconds" },
)

const encodeUtf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
const SSE_KEEPALIVE_FRAME = encodeUtf8(": keepalive\n\n")
const IDEMPOTENCY_CONFLICT_MESSAGE =
	"Event id or Idempotency-Key was already used for a different event."

const sessionEventCommandId = (
	sessionId: SessionId,
	scope:
		| { readonly kind: "event"; readonly eventId: string }
		| { readonly kind: "batch"; readonly key: string; readonly index: number },
): string => {
	const tuple =
		scope.kind === "event"
			? [sessionId, "event", scope.eventId]
			: [sessionId, "batch", scope.key, scope.index]
	return `evt:${createHash("sha256").update(JSON.stringify(tuple)).digest("hex")}`
}

const sessionEventBatchId = (sessionId: SessionId, idempotencyKey: string): EventBatchId =>
	EventBatchId.make(
		`eb_${createHash("sha256")
			.update(JSON.stringify([sessionId, "batch", idempotencyKey]))
			.digest("hex")}`,
	)

const sessionEventClaimId = (sessionId: SessionId, eventId: string): EventBatchId =>
	EventBatchId.make(
		`ev_${createHash("sha256")
			.update(JSON.stringify([sessionId, "event", eventId]))
			.digest("hex")}`,
	)

const singleEventFingerprint = (
	item:
		| { readonly type: "user.interrupt" }
		| { readonly type: "user.message"; readonly text: string },
): string =>
	createHash("sha256")
		.update(
			JSON.stringify(
				item.type === "user.interrupt" ? { type: item.type } : { type: item.type, text: item.text },
			),
		)
		.digest("hex")

const eventBatchFingerprint = (
	items: ReadonlyArray<
		| { readonly type: "user.interrupt"; readonly eventId: string | undefined }
		| {
				readonly type: "user.message"
				readonly eventId: string | undefined
				readonly text: string
		  }
	>,
): string =>
	createHash("sha256")
		.update(
			JSON.stringify(
				items.map((item) =>
					item.type === "user.interrupt"
						? { type: item.type, ...(item.eventId === undefined ? {} : { id: item.eventId }) }
						: {
								type: item.type,
								...(item.eventId === undefined ? {} : { id: item.eventId }),
								text: item.text,
							},
				),
			),
		)
		.digest("hex")

const serializeSession = ({ agent_id, agent_version, ...snapshot }: SessionSnapshot) => ({
	...snapshot,
	agent: { id: agent_id, version: agent_version },
})

export type DomainSessionEvent = Domain.View.EventOf<typeof SessionView>

export interface SessionEventEntry {
	readonly envelope: { readonly seq: number; readonly at: DateTime.Utc }
	readonly event: DomainSessionEvent
}

const encodeSessionEventJson = Schema.encodeSync(
	Schema.fromJsonString(Schema.toCodecJson(SessionEvent)),
)

const sessionEventEnvelope = <const T extends SessionEvent["type"]>(
	entry: SessionEventEntry,
	type: T,
) => ({
	id: `evt_${entry.envelope.seq}`,
	seq: entry.envelope.seq,
	type,
	created_at: entry.envelope.at,
})

export const serializeSessionEvent = (entry: SessionEventEntry): SessionEvent => {
	const { event } = entry
	switch (event._tag) {
		case "user.message":
			return {
				...sessionEventEnvelope(entry, "user.message"),
				content: event.content.map((block) => ({ type: block.type, text: block.text })),
			}
		case "user.interrupt":
			return sessionEventEnvelope(entry, "user.interrupt")
		case "session.status_running":
			return sessionEventEnvelope(entry, "session.status_running")
		case "span.model_request_start":
			return {
				...sessionEventEnvelope(entry, "span.model_request_start"),
				model_request_start_id: event.model_request_start_id,
			}
		case "agent.thinking":
			return {
				...sessionEventEnvelope(entry, "agent.thinking"),
				thinking: event.thinking,
			}
		case "agent.message":
			return {
				...sessionEventEnvelope(entry, "agent.message"),
				content: event.content.map((block) => ({ type: block.type, text: block.text })),
				...(event.truncated === true ? { truncated: true as const } : {}),
			}
		case "span.model_request_end":
			return {
				...sessionEventEnvelope(entry, "span.model_request_end"),
				model_request_start_id: event.model_request_start_id,
				model_usage: {
					input_tokens: event.model_usage.input_tokens,
					output_tokens: event.model_usage.output_tokens,
				},
				is_error: event.is_error,
			}
		case "session.status_idle":
			return {
				...sessionEventEnvelope(entry, "session.status_idle"),
				stop_reason: { type: event.stop_reason.type },
			}
		case "session.error":
			return {
				...sessionEventEnvelope(entry, "session.error"),
				error: {
					type: event.error.type,
					message: event.error.message,
					retry_status: { type: event.error.retry_status.type },
				},
			}
		case "session.status_terminated":
			return sessionEventEnvelope(entry, "session.status_terminated")
		case "session.archived":
			return sessionEventEnvelope(entry, "session.archived")
		default: {
			const exhaustive: never = event
			throw new Error(`Unhandled session event: ${JSON.stringify(exhaustive)}`)
		}
	}
}

export const SessionsLive = HttpApiBuilder.group(CheckfuApi, "sessions", (handlers) =>
	Effect.gen(function* () {
		const agentVersionsByNumber = yield* AgentVersionByNumberView
		const admitSession = yield* AdmitSessionDecision
		const eventBatches = yield* EventBatch
		const sessions = yield* Session
		const sessionViews = yield* SessionView
		const random = yield* SecureRandom.SecureRandom
		const sseKeepaliveMs = yield* SseKeepaliveMs
		const sseMaxConnectionMs = yield* SseMaxConnectionMs

		const waitForPinnedAgentVersion = (agentId: string, version: number, timeout: Duration.Input) =>
			Effect.gen(function* () {
				const lookupKey = agentVersionLookupKey(agentId, version)
				if (Option.isSome(yield* agentVersionsByNumber.get(lookupKey))) return true
				const found = yield* agentVersionsByNumber.waitFor(lookupKey, { version }, { timeout })
				return found !== null
			})

		const existing = (id: SessionId) =>
			Effect.gen(function* () {
				const ref = Session.ref(id)
				const found = Option.getOrNull(yield* sessionViews.get(ref))
				if (found !== null) return found
				const committed = yield* sessions.get(id)
				if (committed._tag === "Uninitialized") {
					return yield* reject(404, `Session ${id} not found.`)
				}
				const projected = yield* sessionViews.waitFor(
					ref,
					{ id },
					{ timeout: yield* SessionReadWaitTimeout },
				)
				if (projected === null) {
					return yield* reject(503, `Session ${id} projection is not ready.`)
				}
				return projected
			})

		return handlers
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const nested = payload.agent
					const nestedAgentId = typeof nested === "string" ? nested : nested?.id
					if (
						nestedAgentId !== undefined &&
						payload.agent_id !== undefined &&
						nestedAgentId !== payload.agent_id
					) {
						return yield* reject(400, "Conflicting agent and agent_id values.")
					}
					const nestedVersion = typeof nested === "object" ? nested.version : undefined
					if (
						nestedVersion !== undefined &&
						payload.agent_version !== undefined &&
						nestedVersion !== payload.agent_version
					) {
						return yield* reject(400, "Conflicting agent.version and agent_version values.")
					}
					const rawAgentId = nestedAgentId ?? payload.agent_id
					if (rawAgentId === undefined) {
						return yield* reject(400, "Either agent or agent_id is required.")
					}

					const agentId = AgentId.make(rawAgentId)
					const explicitVersion = nestedVersion ?? payload.agent_version
					const environmentId = EnvironmentId.make(payload.environment_id)
					const id = SessionId.make(yield* randomId(random, "sess"))
					const receipt = yield* admitSession.send(
						new AdmitSession({
							session_id: id,
							agent_id: agentId,
							agent_version: explicitVersion ?? null,
							environment_id: environmentId,
							title: payload.title ?? null,
						}),
					)
					const pinnedVersion = receipt.reply.agent_version
					const pinnedReady = yield* waitForPinnedAgentVersion(
						agentId,
						pinnedVersion,
						yield* AgentVersionWaitTimeout,
					).pipe(orPending(id, "session"))
					if (isPending(pinnedReady)) return pinnedReady
					if (!pinnedReady) return { id, type: "session", pending: true as const }
					const sessionCommit = commitForStream(receipt.commits, `Session/${id}`)
					const result = yield* sessionViews
						.get(Session.ref(id), sessionCommit === undefined ? {} : { atLeast: sessionCommit })
						.pipe(orPending(id, "session"))
					if (isPending(result)) return result
					return serializeSession(yield* present(result, 500, "Failed to load created session."))
				}).pipe(handled),
			)
			.handle("get", ({ params }) =>
				Effect.gen(function* () {
					const snapshot = yield* existing(params.session_id)
					const versionTimeout = Duration.min(
						Duration.fromInputUnsafe(yield* SessionReadWaitTimeout),
						Duration.fromInputUnsafe(yield* AgentVersionWaitTimeout),
					)
					const ready = yield* waitForPinnedAgentVersion(
						snapshot.agent_id,
						snapshot.agent_version,
						versionTimeout,
					)
					if (!ready) {
						return yield* reject(
							503,
							`Session ${params.session_id} pinned agent version projection is not ready.`,
						)
					}
					return serializeSession(snapshot)
				}).pipe(handled),
			)
			.handle("archive", ({ params }) =>
				Effect.gen(function* () {
					const id = params.session_id
					const receipt = yield* sessions.send(new ArchiveSession({ session_id: id }))
					const result = yield* sessionViews
						.get(Session.ref(id), { atLeast: receipt })
						.pipe(orPending(id, "session"))
					if (isPending(result)) return result
					return serializeSession(yield* present(result, 404, `Session ${id} not found.`))
				}).pipe(handled),
			)
			.handle("sendEvents", ({ params, headers, payload }) =>
				Effect.gen(function* () {
					const id = params.session_id
					const idempotencyKey = headers["idempotency-key"]
					const seenEventIds = new Set<string>()
					const prepared: Array<
						| {
								readonly type: "user.interrupt"
								readonly eventId: string | undefined
								readonly commandId: string | undefined
						  }
						| {
								readonly type: "user.message"
								readonly eventId: string | undefined
								readonly commandId: string | undefined
								readonly text: typeof MessageText.Type
						  }
					> = []
					for (const [index, event] of payload.events.entries()) {
						if (event.id !== undefined) {
							if (seenEventIds.has(event.id)) {
								return yield* reject(400, `Duplicate event id "${event.id}" in batch.`)
							}
							seenEventIds.add(event.id)
						}
						const commandId =
							event.id !== undefined
								? sessionEventCommandId(id, { kind: "event", eventId: event.id })
								: idempotencyKey !== undefined
									? sessionEventCommandId(id, { kind: "batch", key: idempotencyKey, index })
									: undefined
						if (event.type === "user.interrupt") {
							prepared.push({ type: "user.interrupt", eventId: event.id, commandId })
							continue
						}
						const joined = event.content.map((block) => block.text).join("\n")
						const text = yield* Schema.decodeUnknownEffect(MessageText)(joined).pipe(
							Effect.catch(() =>
								reject(
									400,
									`events[${index}] combined text must be between 1 and ${MAX_MESSAGE_TEXT_LENGTH} characters.`,
								),
							),
						)
						prepared.push({ type: "user.message", eventId: event.id, commandId, text })
					}

					const hasClientEventIds = prepared.some((item) => item.eventId !== undefined)
					if (idempotencyKey !== undefined || hasClientEventIds) {
						const committedSession = yield* sessions.get(id)
						if (committedSession._tag === "Uninitialized") {
							return yield* reject(404, `Session ${id} not found.`)
						}
					}
					if (idempotencyKey !== undefined) {
						const batchId = sessionEventBatchId(id, idempotencyKey)
						const fingerprint = eventBatchFingerprint(prepared)
						yield* eventBatches.send(new ClaimEventBatch({ batch_id: batchId, fingerprint }), {
							commandId: `claim:${batchId}:${fingerprint}`,
						})
					}

					const accepted: Array<unknown> = []
					for (const [index, item] of prepared.entries()) {
						const sendOptions =
							item.commandId === undefined ? undefined : { commandId: item.commandId }
						const claimEventId =
							item.eventId === undefined
								? Effect.void
								: Effect.suspend(() => {
										const claimId = sessionEventClaimId(id, item.eventId!)
										const fingerprint = singleEventFingerprint(item)
										return eventBatches
											.send(new ClaimEventBatch({ batch_id: claimId, fingerprint }), {
												commandId: `claim:${claimId}:${fingerprint}`,
											})
											.pipe(
												Effect.catch(() => reject(409, IDEMPOTENCY_CONFLICT_MESSAGE)),
												Effect.asVoid,
											)
									})
						const outcome =
							item.type === "user.interrupt"
								? yield* settled(
										claimEventId.pipe(
											Effect.andThen(
												sessions.send(new SendUserInterrupt({ session_id: id }), sendOptions),
											),
											Effect.flatMap((receipt) =>
												receipt.events.some((event) => event._tag === "user.interrupt")
													? Effect.succeed({
															type: "user.interrupt" as const,
															...(item.eventId === undefined ? {} : { id: item.eventId }),
														})
													: reject(409, IDEMPOTENCY_CONFLICT_MESSAGE),
											),
										),
									)
								: yield* settled(
										claimEventId.pipe(
											Effect.andThen(
												sessions.send(
													new SendUserMessage({ session_id: id, text: item.text }),
													sendOptions,
												),
											),
											Effect.flatMap((receipt) => {
												const committed = receipt.events.find(
													(event) => event._tag === "user.message",
												)
												if (
													committed?._tag !== "user.message" ||
													committed.content[0]?.text !== item.text
												) {
													return reject(409, IDEMPOTENCY_CONFLICT_MESSAGE)
												}
												if (receipt.reply === undefined) {
													return Effect.die(new Error("SendUserMessage receipt is missing reply."))
												}
												return Effect.succeed({
													type: "user.message" as const,
													...(item.eventId === undefined ? {} : { id: item.eventId }),
													turn: receipt.reply.turn,
													content: [{ type: "text" as const, text: item.text }],
												})
											}),
										),
									)
						if (outcome._tag === "Failure") {
							const { confirmed, error } = outcome.failure
							const mapped = toApiError(error, yield* currentRequestId)
							const isUnconfirmed = !confirmed || statusOf(mapped) >= 500
							if (isUnconfirmed) {
								return yield* Effect.fail({
									...mapped,
									...(accepted.length > 0 ? { accepted } : {}),
									unconfirmed_index: index,
								})
							}
							return yield* Effect.fail(
								accepted.length > 0 ? { ...mapped, accepted, failed_index: index } : mapped,
							)
						}
						accepted.push(outcome.success)
					}
					return { data: accepted }
				}).pipe(handled),
			)
			.handle("listEvents", ({ params, query }) =>
				Effect.gen(function* () {
					yield* existing(params.session_id)
					const page = yield* sessionViews.list(Session.ref(params.session_id), {
						...(query.after === undefined ? {} : { after: Number(query.after) }),
						take: query.limit === undefined ? 50 : Number(query.limit),
						order: query.order ?? "asc",
					})
					return {
						data: page.entries.map((entry) => serializeSessionEvent(entry)),
						has_more: page.cursor !== null,
						next_cursor: page.cursor,
					}
				}).pipe(handled),
			)
			.handleRaw("streamEvents", ({ params, query, request }) =>
				Effect.gen(function* () {
					const id = params.session_id
					const snapshot = yield* existing(id)
					const header = request.headers["last-event-id"]
					const rawCursor = header !== undefined && header.length > 0 ? header : query.after
					if (rawCursor !== undefined && !/^\d{1,15}$/.test(rawCursor)) {
						return yield* reject(400, "Cursor must be a non-negative integer.")
					}
					const after = rawCursor === undefined ? undefined : Number(rawCursor)
					const ref = Session.ref(id)
					let initialHead = 0
					if (snapshot.archived_at !== null) {
						const latest = yield* sessionViews.snapshot(ref)
						if (latest.cursor <= (after ?? 0)) {
							return HttpServerResponse.empty({ status: 204 })
						}
						initialHead = latest.cursor
					}
					// Poll `snapshot` (one view RPC) to observe both the latest emitted seq and
					// archival state, fetching bounded event pages only when events exist past
					// `state.cursor`. Back off while caught up, and drain busy sessions without sleeping.
					const events = Stream.paginate(
						{ cursor: after ?? 0, delayMs: 0, knownHead: initialHead },
						(state) =>
							Effect.gen(function* () {
								if (state.delayMs > 0) yield* Effect.sleep(Duration.millis(state.delayMs))
								let knownHead = state.knownHead
								if (state.cursor >= knownHead) {
									const latest = yield* sessionViews.snapshot(ref)
									knownHead = latest.cursor
									if (knownHead <= state.cursor) {
										if (latest.state !== null && latest.state.archived_at !== null) {
											return [[], Option.none()] as const
										}
										return [
											[],
											Option.some({
												cursor: state.cursor,
												delayMs: Math.min(1000, Math.max(300, state.delayMs * 2)),
												knownHead,
											}),
										] as const
									}
								}
								const page = yield* sessionViews.list(ref, {
									after: state.cursor,
									take: SSE_CATCHUP_PAGE_SIZE,
									order: "asc",
								})
								const last = page.entries.at(-1)
								if (last === undefined) {
									return [
										page.entries,
										Option.some({
											cursor: state.cursor,
											delayMs: Math.min(1000, Math.max(300, state.delayMs * 2)),
											knownHead: state.cursor,
										}),
									] as const
								}
								return [
									page.entries,
									Option.some({
										cursor: last.envelope.seq,
										delayMs: 0,
										knownHead: Math.max(knownHead, last.envelope.seq),
									}),
								] as const
							}),
					)
					const frames = events.pipe(
						Stream.takeUntil((entry) => entry.event._tag === "session.archived"),
						Stream.map((entry) => {
							const payload = serializeSessionEvent(entry)
							return encodeUtf8(
								`id: ${entry.envelope.seq}\nevent: ${payload.type}\ndata: ${encodeSessionEventJson(payload)}\n\n`,
							)
						}),
						Stream.interruptWhen(Effect.sleep(Duration.millis(sseMaxConnectionMs))),
					)
					const keepalive = Stream.tick(Duration.millis(sseKeepaliveMs)).pipe(
						Stream.drop(1),
						Stream.map(() => SSE_KEEPALIVE_FRAME),
					)
					return HttpServerResponse.stream(
						Stream.merge(frames, keepalive, { haltStrategy: "left" }),
						{
							status: 200,
							headers: {
								"content-type": "text/event-stream; charset=utf-8",
								"cache-control": "no-cache, no-store",
							},
						},
					)
				}).pipe(handled),
			)
	}),
)
