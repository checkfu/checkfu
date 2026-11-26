import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import type * as Domain from "@alchemy.run/domain"
import * as Model from "@alchemy.run/domain/Model"
import { AgentId } from "@checkfu/domain/Agent/Agent.id"
import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "@checkfu/domain/Agent/AgentVersionByNumberView.view"
import { EnvironmentId } from "@checkfu/domain/Environment/Environment.id"
import { ArchiveSession } from "@checkfu/domain/Session/ArchiveSession.command"
import { ClaimIdempotencyKey } from "@checkfu/domain/Session/ClaimIdempotencyKey.command"
import { SendUserInterrupt } from "@checkfu/domain/Session/SendUserInterrupt.command"
import { SendUserMessage } from "@checkfu/domain/Session/SendUserMessage.command"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import { SessionId } from "@checkfu/domain/Session/Session.id"
import { MAX_MESSAGE_TEXT_LENGTH, MessageText } from "@checkfu/domain/Session/SessionTypes"
import { SessionView } from "@checkfu/domain/Session/SessionView.view"
import type { SessionSnapshot } from "@checkfu/domain/Session/SessionView.view"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import type * as DateTime from "effect/DateTime"
import * as Cache from "effect/Cache"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Sse from "effect/encoding/Sse"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { AdmitSession } from "@checkfu/domain/Session/AdmitSession.command"
import { AdmitSessionDecision } from "@checkfu/domain/Session/AdmitSession.decision"
import { LIST_PAGE_MAX } from "@checkfu/domain/Listing/ListResources.query"
import { AgentVersionWaitTimeout } from "./AgentsHandlers.ts"
import { artifactReads } from "./ArtifactsHandlers.ts"
import { outputsArtifactId } from "../OutputsIdentity.ts"
import { CheckfuApi, CursorFromString, SessionEvent, statusOf } from "./Api.ts"
import type { ClientEventId, SendSessionEventReceipt } from "./Api.ts"
import {
	IDEMPOTENCY_KEY_REUSED,
	commitForStream,
	createCommandId,
	currentRequestId,
	handled,
	idempotentCommandId,
	idempotentId,
	isPending,
	orPending,
	present,
	randomId,
	reject,
	settled,
	sha256Json,
	toApiError,
} from "./HttpHelpers.ts"
import { makeLister } from "./Listing.ts"
import { ViewEventsOverObjectSockets, objectSocketChanges } from "./ObjectSocketEvents.ts"

export const SSE_CATCHUP_PAGE_SIZE = 100
export const DEFAULT_SSE_KEEPALIVE_INTERVAL: Duration.Input = "15 seconds"
export const DEFAULT_SSE_MAX_CONNECTION_DURATION: Duration.Input = "4 minutes"

export const SseKeepaliveInterval = Context.Reference<Duration.Input>(
	"@checkfu/api/SseKeepaliveInterval",
	{ defaultValue: () => DEFAULT_SSE_KEEPALIVE_INTERVAL },
)

export const SseMaxConnectionDuration = Context.Reference<Duration.Input>(
	"@checkfu/api/SseMaxConnectionDuration",
	{ defaultValue: () => DEFAULT_SSE_MAX_CONNECTION_DURATION },
)

const decodeCursor = Schema.decodeEffect(CursorFromString)

export const SessionReadWaitTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/SessionReadWaitTimeout",
	{ defaultValue: () => "5 seconds" },
)

const SSE_KEEPALIVE_FRAME = ": keepalive\n\n"
const IDEMPOTENCY_CONFLICT_MESSAGE =
	"Event id or Idempotency-Key was already used for a different event."

const sessionEventCommandId = (
	digest: Digest.Digest["Service"],
	sessionId: SessionId,
	scope:
		| { readonly kind: "event"; readonly eventId: string }
		| { readonly kind: "batch"; readonly key: string; readonly index: number },
) =>
	idempotentCommandId(
		digest,
		"evt",
		scope.kind === "event"
			? [sessionId, "event", scope.eventId]
			: [sessionId, "batch", scope.key, scope.index],
	)

const eventBatchFingerprint = (
	digest: Digest.Digest["Service"],
	items: ReadonlyArray<
		| { readonly type: "user.interrupt"; readonly eventId: string | undefined }
		| {
				readonly type: "user.message"
				readonly eventId: string | undefined
				readonly text: string
		  }
	>,
) =>
	sha256Json(
		digest,
		items.map((item) =>
			item.type === "user.interrupt"
				? { type: item.type, ...(item.eventId === undefined ? {} : { id: item.eventId }) }
				: {
						type: item.type,
						...(item.eventId === undefined ? {} : { id: item.eventId }),
						text: item.text,
					},
		),
	)

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
			return {
				...sessionEventEnvelope(entry, "session.status_running"),
				turn: event.turn,
			}
		case "span.model_request_start":
			return {
				...sessionEventEnvelope(entry, "span.model_request_start"),
				model_request_start_id: event.model_request_start_id,
			}
		case "agent.tool_use":
			return {
				...sessionEventEnvelope(entry, "agent.tool_use"),
				tool_use_id: event.tool_use_id,
				name: event.name,
				input: event.input,
				...(event.truncated === true ? { truncated: true as const } : {}),
			}
		case "agent.tool_result":
			return {
				...sessionEventEnvelope(entry, "agent.tool_result"),
				tool_use_id: event.tool_use_id,
				content: event.content.map((block) => ({ type: block.type, text: block.text })),
				is_error: event.is_error,
				...(event.truncated === true ? { truncated: true as const } : {}),
				...(event.rejected === undefined ? {} : { rejected: event.rejected }),
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
				turn: event.turn,
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
		const sessions = yield* Session
		const sessionViews = yield* SessionView
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom
		const sseKeepaliveInterval = yield* SseKeepaliveInterval
		const sseMaxConnectionDuration = yield* SseMaxConnectionDuration
		const list = yield* makeLister
		const overObjectSockets = yield* ViewEventsOverObjectSockets
		const connectSessionView = overObjectSockets
			? (yield* Model.Internals).views.get(SessionView.viewName)?.connect
			: undefined
		if (overObjectSockets && connectSessionView === undefined) {
			return yield* Effect.die(new Error("SessionView is not pushed over object sockets."))
		}
		const { readArtifact } = yield* artifactReads
		const artifacts = yield* Artifact

		const waitForPinnedAgentVersion = (agentId: string, version: number, timeout: Duration.Input) =>
			Effect.gen(function* () {
				const lookupKey = agentVersionLookupKey(agentId, version)
				if (Option.isSome(yield* agentVersionsByNumber.get(lookupKey))) {
					return true
				}
				const found = yield* agentVersionsByNumber.waitFor(lookupKey, { version }, { timeout })
				return found !== null
			})

		const existing = (id: SessionId) =>
			Effect.gen(function* () {
				const ref = Session.ref(id)
				const found = Option.getOrNull(yield* sessionViews.get(ref))
				if (found !== null) {
					return found
				}
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

		const pinnedVersionReady = (agentId: string, version: number) =>
			Effect.gen(function* () {
				const timeout = Duration.min(
					Duration.fromInputUnsafe(yield* SessionReadWaitTimeout),
					Duration.fromInputUnsafe(yield* AgentVersionWaitTimeout),
				)
				return yield* waitForPinnedAgentVersion(agentId, version, timeout)
			})

		const retrieve = (id: SessionId, ready: typeof pinnedVersionReady = pinnedVersionReady) =>
			Effect.gen(function* () {
				const snapshot = yield* existing(id)
				if (!(yield* ready(snapshot.agent_id, snapshot.agent_version))) {
					return yield* reject(503, `Session ${id} pinned agent version projection is not ready.`)
				}
				return serializeSession(snapshot)
			})

		return handlers
			.handle("create", ({ payload, headers }) =>
				Effect.gen(function* () {
					const idempotencyKey = headers["idempotency-key"]
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

					const decodedAgentId = Schema.decodeOption(AgentId)(rawAgentId)
					if (Option.isNone(decodedAgentId)) {
						return yield* reject(404, `Agent ${rawAgentId} not found.`)
					}
					const decodedEnvironmentId = Schema.decodeOption(EnvironmentId)(payload.environment_id)
					if (Option.isNone(decodedEnvironmentId)) {
						return yield* reject(404, `Environment ${payload.environment_id} not found.`)
					}
					const agentId = decodedAgentId.value
					const explicitVersion = nestedVersion ?? payload.agent_version
					const environmentId = decodedEnvironmentId.value
					const agentVersion = explicitVersion ?? null
					const title = payload.title ?? null
					let id: SessionId
					let sendOptions: { readonly commandId: string } | undefined
					if (idempotencyKey !== undefined) {
						id = SessionId.make(
							yield* idempotentId(digest, "sess", ["create", "session", "id", idempotencyKey]),
						)
						sendOptions = {
							commandId: yield* createCommandId(digest, "session", idempotencyKey, {
								agent_id: agentId,
								agent_version: agentVersion,
								environment_id: environmentId,
								title,
							}),
						}
					} else {
						id = SessionId.make(yield* randomId(random, "sess"))
					}
					const receipt = yield* admitSession
						.send(
							new AdmitSession({
								session_id: id,
								agent_id: agentId,
								agent_version: agentVersion,
								environment_id: environmentId,
								title,
							}),
							sendOptions,
						)
						.pipe(
							Effect.catchTag("SessionAlreadyExists", () => reject(409, IDEMPOTENCY_KEY_REUSED)),
						)
					const pinnedVersion = receipt.reply.agent_version
					const pinnedReady = yield* waitForPinnedAgentVersion(
						agentId,
						pinnedVersion,
						yield* AgentVersionWaitTimeout,
					).pipe(orPending(id, "session"))
					if (isPending(pinnedReady)) {
						return pinnedReady
					}
					if (!pinnedReady) {
						return { id, type: "session" as const, pending: true as const }
					}
					const sessionCommit = commitForStream(receipt.commits, `Session/${id}`)
					const result = yield* sessionViews
						.get(Session.ref(id), sessionCommit === undefined ? {} : { atLeast: sessionCommit })
						.pipe(orPending(id, "session"))
					if (isPending(result)) {
						return result
					}
					const snapshot = yield* present(result, 500, "Failed to load created session.")
					return {
						id,
						type: "session" as const,
						status: "idle" as const,
						agent: { id: agentId, version: pinnedVersion },
						environment_id: environmentId,
						title,
						turn: 0,
						usage: {
							input_tokens: 0,
							output_tokens: 0,
						},
						created_at: snapshot.created_at,
						updated_at: snapshot.created_at,
						archived_at: null,
					}
				}).pipe(handled),
			)
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const pinned = yield* Cache.make({
						capacity: LIST_PAGE_MAX,
						lookup: (key: string) =>
							pinnedVersionReady(
								key.slice(key.indexOf(":") + 1),
								Number(key.slice(0, key.indexOf(":"))),
							),
					})
					return yield* list("session", query, (id) =>
						retrieve(SessionId.make(id), (agentId, version) =>
							Cache.get(pinned, `${version}:${agentId}`),
						),
					)
				}).pipe(handled),
			)
			.handle("get", ({ params }) => retrieve(params.session_id).pipe(handled))
			.handle("archive", ({ params }) =>
				Effect.gen(function* () {
					const id = params.session_id
					const receipt = yield* sessions.send(new ArchiveSession({ session_id: id }))
					const result = yield* sessionViews
						.get(Session.ref(id), { atLeast: receipt })
						.pipe(orPending(id, "session"))
					if (isPending(result)) {
						return result
					}
					return serializeSession(yield* present(result, 404, `Session ${id} not found.`))
				}).pipe(handled),
			)
			.handle("getOutputs", ({ params }) =>
				Effect.gen(function* () {
					const sessionId = params.session_id
					const id = yield* outputsArtifactId(digest, sessionId)
					const artifact = yield* artifacts.get(id)
					if (artifact.status === "active") {
						return yield* readArtifact(id, artifact)
					}
					return yield* reject(
						404,
						(yield* sessions.get(sessionId))._tag === "Uninitialized"
							? `Session ${sessionId} not found.`
							: `Session ${sessionId} has published no outputs.`,
					)
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
								readonly eventId: ClientEventId | undefined
								readonly commandId: string | undefined
						  }
						| {
								readonly type: "user.message"
								readonly eventId: ClientEventId | undefined
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
								? yield* sessionEventCommandId(digest, id, { kind: "event", eventId: event.id })
								: idempotencyKey !== undefined
									? yield* sessionEventCommandId(digest, id, {
											kind: "batch",
											key: idempotencyKey,
											index,
										})
									: undefined
						if (event.type === "user.interrupt") {
							prepared.push({ type: "user.interrupt", eventId: event.id, commandId })
							continue
						}
						const joined = event.content.map((block) => block.text).join("\n")
						const text = yield* Schema.decodeEffect(MessageText)(joined).pipe(
							Effect.catch(() =>
								reject(
									400,
									`events[${index}] combined text must be between 1 and ${MAX_MESSAGE_TEXT_LENGTH} characters.`,
								),
							),
						)
						prepared.push({ type: "user.message", eventId: event.id, commandId, text })
					}

					if (idempotencyKey !== undefined) {
						const fingerprint = yield* eventBatchFingerprint(digest, prepared)
						const claim = yield* sessions.send(
							new ClaimIdempotencyKey({ session_id: id, fingerprint }),
							{ commandId: yield* idempotentCommandId(digest, "batch", [id, idempotencyKey]) },
						)
						if (
							!claim.events.some(
								(event) =>
									event._tag === "idempotency_key.claimed" && event.fingerprint === fingerprint,
							)
						) {
							return yield* reject(409, IDEMPOTENCY_KEY_REUSED)
						}
					}

					const accepted: Array<SendSessionEventReceipt> = []
					for (const [index, item] of prepared.entries()) {
						const sendOptions =
							item.commandId === undefined ? undefined : { commandId: item.commandId }
						const outcome =
							item.type === "user.interrupt"
								? yield* settled(
										sessions.send(new SendUserInterrupt({ session_id: id }), sendOptions).pipe(
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
										sessions
											.send(new SendUserMessage({ session_id: id, text: item.text }), sendOptions)
											.pipe(
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
														return Effect.die(
															new Error("SendUserMessage receipt is missing reply."),
														)
													}
													const queued = !receipt.events.some(
														(event) => event._tag === "session.status_running",
													)
													return Effect.succeed({
														type: "user.message" as const,
														...(item.eventId === undefined ? {} : { id: item.eventId }),
														turn: receipt.reply.turn,
														queued,
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
						...(query.after === undefined ? {} : { after: query.after }),
						take: query.limit ?? 50,
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
					const ref = Session.ref(id)
					const projected = yield* sessionViews.snapshot(ref)
					const head =
						projected.state !== null
							? projected
							: yield* Effect.andThen(existing(id), sessionViews.snapshot(ref))
					const header = request.headers["last-event-id"]
					const rawCursor = header !== undefined && header.length > 0 ? header : query.after
					const after =
						rawCursor === undefined
							? undefined
							: yield* decodeCursor(rawCursor).pipe(
									Effect.catch(() => reject(400, "Cursor must be a non-negative integer.")),
								)
					const from = after ?? 0
					if (head.state !== null && head.state.archived_at !== null && head.cursor <= from) {
						return HttpServerResponse.empty({ status: 204 })
					}
					let cursor = Math.min(from, head.cursor)
					const pagesAfterCursor = (until: "empty" | "last page") =>
						Stream.suspend(() =>
							Stream.paginate(cursor, (seq: number) =>
								Effect.map(
									sessionViews.list(ref, {
										after: seq,
										take: SSE_CATCHUP_PAGE_SIZE,
										order: "asc",
									}),
									(page) =>
										[
											page.entries,
											until === "empty"
												? Option.map(
														Option.fromUndefinedOr(page.entries.at(-1)),
														(last) => last.envelope.seq,
													)
												: Option.fromNullOr(page.cursor),
										] as const,
								),
							),
						).pipe(Stream.tap((entry) => Effect.sync(() => (cursor = entry.envelope.seq))))
					const catchUp = cursor < head.cursor ? pagesAfterCursor("empty") : Stream.empty
					const live: Stream.Stream<SessionEventEntry> =
						connectSessionView === undefined
							? Stream.suspend(() => sessionViews.events(ref, { after: cursor }))
							: Stream.suspend(() => {
									cursor = Math.max(cursor, from)
									return objectSocketChanges(connectSessionView, id).pipe(
										Stream.buffer({ capacity: 1, strategy: "sliding" }),
										Stream.takeWhile((latest) => !(latest.archived && latest.seq <= cursor)),
										Stream.flatMap((latest) =>
											latest.seq > cursor ? pagesAfterCursor("last page") : Stream.empty,
										),
									)
								})
					const frames = Stream.concat(catchUp, live).pipe(
						Stream.takeUntil((entry) => entry.event._tag === "session.archived"),
						Stream.filter((entry) => entry.envelope.seq > from),
						Stream.map((entry) => {
							const payload = serializeSessionEvent(entry)
							return Sse.encoder.write({
								_tag: "Event",
								id: String(entry.envelope.seq),
								event: payload.type,
								data: encodeSessionEventJson(payload),
							})
						}),
						Stream.interruptWhen(Effect.sleep(sseMaxConnectionDuration)),
					)
					const keepalive = Stream.tick(sseKeepaliveInterval).pipe(
						Stream.drop(1),
						Stream.as(SSE_KEEPALIVE_FRAME),
					)
					return HttpServerResponse.stream(
						Stream.merge(frames, keepalive, { haltStrategy: "left" }).pipe(Stream.encodeText),
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
