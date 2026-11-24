import type * as Domain from "@alchemy.run/domain"
import { Agent } from "@checkfu/domain/Agent/Agent.aggregate"
import { AgentId } from "@checkfu/domain/Agent/Agent.id"
import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "@checkfu/domain/Agent/AgentVersionByNumberView.view"
import { Environment } from "@checkfu/domain/Environment/Environment.aggregate"
import { EnvironmentId } from "@checkfu/domain/Environment/Environment.id"
import {
	McpServerSet,
	McpServerSetId,
	RecordMcpServers,
} from "@checkfu/domain/Mcp/McpServerSet.aggregate"
import { McpServerBindingList, McpServerList } from "@checkfu/domain/Mcp/McpServers"
import { ArchiveSession } from "@checkfu/domain/Session/ArchiveSession.command"
import { SendUserInterrupt } from "@checkfu/domain/Session/SendUserInterrupt.command"
import { SendUserMessage } from "@checkfu/domain/Session/SendUserMessage.command"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import { SessionId } from "@checkfu/domain/Session/Session.id"
import { MAX_MESSAGE_TEXT_LENGTH, MessageText } from "@checkfu/domain/Session/SessionTypes"
import { SessionView } from "@checkfu/domain/Session/SessionView.view"
import type { SessionSnapshot } from "@checkfu/domain/Session/SessionView.view"
import { Credential } from "@checkfu/domain/Vault/Credential.aggregate"
import { CredentialId } from "@checkfu/domain/Vault/Credential.id"
import { Vault } from "@checkfu/domain/Vault/Vault.aggregate"
import { VaultId } from "@checkfu/domain/Vault/Vault.id"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import type * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Sse from "effect/encoding/Sse"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { IdempotencyClaim } from "@checkfu/domain/IdempotencyClaim/IdempotencyClaim.aggregate"
import { AdmitSession } from "@checkfu/domain/Session/AdmitSession.command"
import { AdmitSessionDecision } from "@checkfu/domain/Session/AdmitSession.decision"
import { AgentVersionWaitTimeout } from "./AgentsHandlers.ts"
import { bindSessionServers } from "../Connection/McpBindings.ts"
import { CheckfuApi, CursorFromString, SessionEvent, statusOf } from "./Api.ts"
import type { ClientEventId, SendSessionEventReceipt } from "./Api.ts"
import {
	claimCreate,
	claimIdempotency,
	commitForStream,
	currentRequestId,
	handled,
	idempotencyClaimId,
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

const sessionEventBatchId = (
	digest: Digest.Digest["Service"],
	sessionId: SessionId,
	idempotencyKey: string,
) => idempotencyClaimId(digest, "eb", [sessionId, "batch", idempotencyKey])

const sessionEventClaimId = (
	digest: Digest.Digest["Service"],
	sessionId: SessionId,
	eventId: string,
) => idempotencyClaimId(digest, "ev", [sessionId, "event", eventId])

const singleEventFingerprint = (
	digest: Digest.Digest["Service"],
	item:
		| { readonly type: "user.interrupt" }
		| { readonly type: "user.message"; readonly text: string },
) =>
	sha256Json(
		digest,
		item.type === "user.interrupt" ? { type: item.type } : { type: item.type, text: item.text },
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

const serializeSession = (
	{ agent_id, agent_version, ...snapshot }: SessionSnapshot,
	mcpServers: string,
) => ({
	...snapshot,
	agent: { id: agent_id, version: agent_version },
	mcp_servers: McpServerBindingList.decode(mcpServers),
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
			}
		case "agent.mcp_tool_use":
			return {
				...sessionEventEnvelope(entry, "agent.mcp_tool_use"),
				tool_use_id: event.tool_use_id,
				mcp_server_name: event.mcp_server_name,
				name: event.name,
				input: event.input,
				...(event.parent_tool_use_id === undefined
					? {}
					: { parent_tool_use_id: event.parent_tool_use_id }),
				...(event.truncated === true ? { truncated: true as const } : {}),
			}
		case "agent.mcp_tool_result":
			return {
				...sessionEventEnvelope(entry, "agent.mcp_tool_result"),
				tool_use_id: event.tool_use_id,
				content: event.content.map((block) => ({ type: block.type, text: block.text })),
				is_error: event.is_error,
				...(event.truncated === true ? { truncated: true as const } : {}),
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
		const agents = yield* Agent
		const environments = yield* Environment
		const vaults = yield* Vault
		const credentials = yield* Credential
		const serverSets = yield* McpServerSet
		// A session's servers, with the credential each was bound to, are recorded under its id.
		const boundServers = (sessionId: string) =>
			Effect.map(serverSets.get(McpServerSetId.make(sessionId)), (set) => set.servers)
		const idempotencyClaims = yield* IdempotencyClaim
		const sessions = yield* Session
		const sessionViews = yield* SessionView
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom
		const sseKeepaliveInterval = yield* SseKeepaliveInterval
		const sseMaxConnectionDuration = yield* SseMaxConnectionDuration

		const waitForPinnedAgentVersion = (agentId: string, version: number, timeout: Duration.Input) =>
			Effect.gen(function* () {
				const lookupKey = agentVersionLookupKey(agentId, version)
				if (Option.isSome(yield* agentVersionsByNumber.get(lookupKey))) {
					return true
				}
				const found = yield* agentVersionsByNumber.waitFor(lookupKey, { version }, { timeout })
				return found !== null
			})

		// The servers of the version a session will pin, and that version. An agent or
		// version that does not exist is left for admission to refuse.
		const declaredMcpServers = (agentId: AgentId, requested: number | undefined) =>
			Effect.gen(function* () {
				const head = yield* agents.get(agentId)
				if (head.status === "" || (requested !== undefined && requested > head.version)) {
					return { version: requested ?? null, servers: [] }
				}
				const version = requested ?? head.version
				if (version === head.version) {
					return {
						version,
						servers: McpServerList.decode(
							(yield* serverSets.get(McpServerSetId.make(head.current_version_id))).servers,
						),
					}
				}
				const pinned = yield* agentVersionsByNumber.waitFor(
					agentVersionLookupKey(agentId, version),
					{ version },
					{ timeout: yield* AgentVersionWaitTimeout },
				)
				if (pinned === null) {
					return yield* reject(503, `Agent ${agentId} version ${version} projection is not ready.`)
				}
				return {
					version,
					servers: McpServerList.decode(
						(yield* serverSets.get(McpServerSetId.make(pinned.id))).servers,
					),
				}
			})

		const activeVaultCredentials = (vaultId: string) =>
			Effect.gen(function* () {
				const vault = yield* vaults.get(VaultId.make(vaultId))
				if (vault.status === "" || vault.status === "deleted") {
					return yield* reject(404, `Vault ${vaultId} not found.`)
				}
				if (vault.status !== "active") {
					return yield* reject(400, `Vault ${vaultId} is archived.`)
				}
				return vault.credentials
			})

		const storedUrlOf = (credentialId: string) =>
			Effect.gen(function* () {
				const credential = yield* credentials.get(CredentialId.make(credentialId))
				if (credential.status !== "active") {
					return null
				}
				const vault = yield* vaults.get(VaultId.make(credential.vault_id))
				return (
					vault.credentials.find((held) => held.credential_id === credentialId)?.mcp_server_url ??
					null
				)
			})

		const bindMcpServers = (
			servers: ReturnType<typeof McpServerList.decode>,
			environmentId: EnvironmentId,
			payload: {
				readonly vault_ids?: ReadonlyArray<string>
				readonly mcp_server_credentials?: ReadonlyArray<{
					readonly mcp_server_name: string
					readonly credential_id: string
				}>
			},
		) =>
			Effect.gen(function* () {
				const offered = (yield* Effect.forEach(
					payload.vault_ids ?? [],
					activeVaultCredentials,
				)).flat()
				const explicit = yield* Effect.forEach(payload.mcp_server_credentials ?? [], (binding) =>
					Effect.map(storedUrlOf(binding.credential_id), (mcp_server_url) => ({
						...binding,
						mcp_server_url,
					})),
				)
				const environment = yield* environments.get(environmentId)
				const bound = bindSessionServers({
					servers,
					explicit,
					offered,
					networking: environment.config === null ? null : environment.config.networking,
				})
				if (!bound.ok) {
					return yield* reject(400, bound.message)
				}
				return bound.mcpServers
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
					// A retried create whose session already exists binds nothing again: it gets the
					// session that was committed, with the servers that were bound for it then.
					const retriedId =
						idempotencyKey === undefined
							? undefined
							: SessionId.make(
									yield* idempotentId(digest, "sess", ["create", "session", "id", idempotencyKey]),
								)
					const committed =
						retriedId !== undefined && (yield* sessions.get(retriedId))._tag !== "Uninitialized"
					const declared = committed
						? { version: agentVersion, servers: [] }
						: yield* declaredMcpServers(agentId, explicitVersion)
					const mcpServers = committed
						? ""
						: yield* bindMcpServers(declared.servers, environmentId, payload)
					let id: SessionId
					let sendOptions: { readonly commandId: string } | undefined
					if (idempotencyKey !== undefined && retriedId !== undefined) {
						const commandId = yield* claimCreate(
							idempotencyClaims,
							digest,
							"session",
							idempotencyKey,
							{
								agent_id: agentId,
								agent_version: agentVersion,
								environment_id: environmentId,
								title,
								...(payload.vault_ids === undefined ? {} : { vault_ids: payload.vault_ids }),
								...(payload.mcp_server_credentials === undefined
									? {}
									: { mcp_server_credentials: payload.mcp_server_credentials }),
							},
						)
						id = retriedId
						sendOptions = { commandId }
					} else {
						id = SessionId.make(yield* randomId(random, "sess"))
					}
					if (mcpServers !== "") {
						yield* serverSets.send(
							new RecordMcpServers({ set_id: McpServerSetId.make(id), servers: mcpServers }),
						)
					}
					const receipt = yield* admitSession.send(
						new AdmitSession({
							session_id: id,
							agent_id: agentId,
							// Servers were bound for one version, so that version is the one admitted.
							agent_version: mcpServers === "" ? agentVersion : declared.version,
							environment_id: environmentId,
							title,
						}),
						sendOptions,
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
						mcp_servers: McpServerBindingList.decode(yield* boundServers(id)),
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
					return serializeSession(snapshot, yield* boundServers(snapshot.id))
				}).pipe(handled),
			)
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
					return serializeSession(
						yield* present(result, 404, `Session ${id} not found.`),
						yield* boundServers(id),
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

					const hasClientEventIds = prepared.some((item) => item.eventId !== undefined)
					if (idempotencyKey !== undefined || hasClientEventIds) {
						const committedSession = yield* sessions.get(id)
						if (committedSession._tag === "Uninitialized") {
							return yield* reject(404, `Session ${id} not found.`)
						}
					}
					if (idempotencyKey !== undefined) {
						const batchId = yield* sessionEventBatchId(digest, id, idempotencyKey)
						const fingerprint = yield* eventBatchFingerprint(digest, prepared)
						yield* claimIdempotency(idempotencyClaims, batchId, fingerprint)
					}

					const accepted: Array<SendSessionEventReceipt> = []
					for (const [index, item] of prepared.entries()) {
						const sendOptions =
							item.commandId === undefined ? undefined : { commandId: item.commandId }
						const eventId = item.eventId
						const claimEventId =
							eventId === undefined
								? Effect.void
								: Effect.gen(function* () {
										const claimId = yield* sessionEventClaimId(digest, id, eventId)
										const fingerprint = yield* singleEventFingerprint(digest, item)
										yield* claimIdempotency(idempotencyClaims, claimId, fingerprint).pipe(
											Effect.catch(() => reject(409, IDEMPOTENCY_CONFLICT_MESSAGE)),
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
					const snapshot = yield* existing(id)
					const header = request.headers["last-event-id"]
					const rawCursor = header !== undefined && header.length > 0 ? header : query.after
					const after =
						rawCursor === undefined
							? undefined
							: yield* decodeCursor(rawCursor).pipe(
									Effect.catch(() => reject(400, "Cursor must be a non-negative integer.")),
								)
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
								if (state.delayMs > 0) {
									yield* Effect.sleep(Duration.millis(state.delayMs))
								}
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
