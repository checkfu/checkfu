import type { SessionEventType, TextBlock } from "@checkfu/sdk/Schemas"
import type * as Domain from "@alchemy.run/domain"
import * as Model from "@alchemy.run/domain/Model"
import { AgentId } from "@checkfu/domain/Agent/Agent.id"
import type { AgentVersionSnapshot } from "@checkfu/domain/Agent/AgentVersionByNumberView.view"
import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "@checkfu/domain/Agent/AgentVersionByNumberView.view"
import { OpenAutomationSession } from "@checkfu/domain/Automation/OpenAutomationSession.command"
import { OpenAutomationSessionDecision } from "@checkfu/domain/Automation/OpenAutomationSession.decision"
import { EnvironmentId } from "@checkfu/domain/Environment/Environment.id"
import { MemoryStore } from "@checkfu/domain/Memory/MemoryStore.aggregate"
import { MemoryStoreId } from "@checkfu/domain/Memory/MemoryStore.id"
import { ArchiveSession } from "@checkfu/domain/Session/ArchiveSession.command"
import {
	encodeInitialMessages,
	initialMessagesBytes,
} from "@checkfu/domain/Session/InitialMessages"
import { MAX_SESSION_INITIAL_MESSAGES_BYTES } from "@checkfu/sdk/Limits"
import { recordInitialMessages } from "@checkfu/domain/Session/RecordInitialMessages.policy"
import { ClaimIdempotencyKey } from "@checkfu/domain/Session/ClaimIdempotencyKey.command"
import { SendSystemMessageDecision } from "@checkfu/domain/Session/SendSystemMessage.decision"
import {
	encodeSystemMessage,
	SendSystemMessage,
} from "@checkfu/domain/Session/SendSystemMessage.command"
import { SendUserInterrupt } from "@checkfu/domain/Session/SendUserInterrupt.command"
import { SendUserMessage } from "@checkfu/domain/Session/SendUserMessage.command"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import {
	SessionId,
	sessionEventId,
	modelEventId,
	submittedSessionEventId,
	toolUseEventId,
	toolUseIdFromEvent,
} from "@checkfu/domain/Session/Session.id"
import {
	MAX_CUSTOM_TOOL_RESULT_LENGTH,
	MAX_MESSAGE_TEXT_LENGTH,
	MessageText,
	ResourceId,
	decodeToolUseIds,
} from "@checkfu/domain/Session/SessionTypes"
import {
	SessionResources,
	artifactMountPath,
	memoryMountPath,
	skillMountPath,
} from "@checkfu/domain/Session/SessionResource"
import type { RepositoryToken, SessionResourceId } from "@checkfu/domain/Session/SessionResource"
import {
	SessionTurnCompletion,
	sessionTurnKey,
} from "@checkfu/domain/Session/SessionTurnCompletion.view"
import { SessionView } from "@checkfu/domain/Session/SessionView.view"
import type { SessionSnapshot } from "@checkfu/domain/Session/SessionView.view"
import { MAX_SKILL_FILE_BYTES } from "@checkfu/sdk/Schemas"
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
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Struct from "effect/Struct"
import * as Unify from "effect/Unify"
import { admissionRefusal } from "@checkfu/domain/Session/AdmissionRefusal"
import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import {
	AdmitSession,
	AdmitSessionWithMessages,
} from "@checkfu/domain/Session/AdmitSession.command"
import { AdmitSessionWithMessagesDecision } from "@checkfu/domain/Session/AdmitSessionWithMessages.decision"
import { Harness } from "@checkfu/domain/Session/Harness.external"
import { AdmitSessionDecision } from "@checkfu/domain/Session/AdmitSession.decision"
import { LIST_PAGE_MAX } from "@checkfu/domain/Listing/ListResources.query"
import { Agent } from "@checkfu/domain/Agent/Agent.aggregate"
import { Environment } from "@checkfu/domain/Environment/Environment.aggregate"
import {
	NO_MCP_SERVER_CREDENTIALS,
	decodeMcpServers,
	encodeMcpServerCredentials,
	mcpHostAllowed,
	resolveMcpServerCredentials,
} from "@checkfu/domain/Mcp/McpServers"
import type { CredentialRequest } from "@checkfu/domain/Mcp/McpServers"
import { ConfirmTool } from "@checkfu/domain/Session/ConfirmTool.command"
import { ConfirmToolDecision } from "@checkfu/domain/Session/ConfirmTool.decision"
import { ReturnCustomToolResult } from "@checkfu/domain/Session/ReturnCustomToolResult.command"
import { ReturnCustomToolResultDecision } from "@checkfu/domain/Session/ReturnCustomToolResult.decision"
import { toolConfirmationId } from "@checkfu/domain/Session/ToolConfirmation.id"
import { Credential } from "@checkfu/domain/Vault/Credential.aggregate"
import { CredentialId } from "@checkfu/domain/Vault/Credential.id"
import {
	CredentialUrlClaim,
	credentialUrlClaimId,
} from "@checkfu/domain/Vault/CredentialUrlClaim.aggregate"
import { Vault } from "@checkfu/domain/Vault/Vault.aggregate"
import { VaultId } from "@checkfu/domain/Vault/Vault.id"
import * as Result from "effect/Result"
import { ArtifactManifestAt } from "../Artifacts/ResolveArtifactVersion.ts"
import { PinnedArtifact } from "../Artifacts/PinnedArtifact.ts"
import { SkillReader } from "../Skills/SkillReader.ts"
import { AgentVersionWaitTimeout } from "./AgentsHandlers.ts"
import { artifactReads } from "./ArtifactsHandlers.ts"
import { outputsArtifactId } from "../OutputsIdentity.ts"
import { CheckfuApi, CursorFromString, SessionEvent, apiError, statusOf } from "./Api.ts"
import type {
	ClientEventId,
	CreateSessionResource,
	SendSessionEventReceipt,
	SessionResourceItem,
} from "./Api.ts"
import {
	IDEMPOTENCY_KEY_REUSED,
	archiveAndRead,
	commitForStream,
	createIdentity,
	currentRequestId,
	errorResponse,
	handled,
	idempotentCommandId,
	idempotentId,
	isPending,
	orPending,
	present,
	randomId,
	readExisting,
	reject,
	settled,
	sha256Json,
	toApiError,
} from "./HttpHelpers.ts"
import { listPage, makeLister } from "./Listing.ts"
import { SessionPreviewSource } from "./SessionPreviewSource.ts"
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

const rejectReusedSessionKey = () => reject(409, IDEMPOTENCY_KEY_REUSED)

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

type PreparedEvent =
	| { readonly type: "user.interrupt" }
	| { readonly type: "user.message"; readonly text: string }
	| { readonly type: "system.message"; readonly content: ReadonlyArray<TextBlock> }
	| {
			readonly type: "user.tool_confirmation"
			readonly tool_use_id: string
			readonly result: "allow" | "deny"
			readonly deny_message: string
	  }
	| {
			readonly type: "user.custom_tool_result"
			readonly custom_tool_use_id: string
			readonly text: string
			readonly is_error: boolean
	  }

const readToolUseId = (sessionId: string, eventId: string) =>
	Schema.decodeEffect(ResourceId)(toolUseIdFromEvent(sessionId, eventId)).pipe(
		Effect.catch(() => reject(400, "Invalid tool use ID.")),
	)

const eventFields = (item: PreparedEvent) => {
	switch (item.type) {
		case "user.interrupt":
			return {}
		case "user.message":
			return { text: item.text }
		case "system.message":
			return { content: item.content }
		case "user.tool_confirmation":
			return { tool_use_id: item.tool_use_id, result: item.result, deny_message: item.deny_message }
		case "user.custom_tool_result":
			return {
				custom_tool_use_id: item.custom_tool_use_id,
				text: item.text,
				is_error: item.is_error,
			}
	}
}

const eventBatchFingerprint = (
	digest: Digest.Digest["Service"],
	items: ReadonlyArray<PreparedEvent & { readonly eventId: string | undefined }>,
) =>
	sha256Json(
		digest,
		items.map((item) => ({
			type: item.type,
			...(item.eventId === undefined ? {} : { id: item.eventId }),
			...eventFields(item),
		})),
	)

const serializeResources = (
	resources: SessionResources,
	created_at: DateTime.Utc,
): ReadonlyArray<SessionResourceItem> =>
	resources.map((resource) => ({
		...(resource.type === "github_repository"
			? Struct.omit(resource, ["requires_token"])
			: resource),
		created_at,
		updated_at: created_at,
	}))

const pinnedAgent = ({
	agent_id,
	type,
	version,
	name,
	model,
	system,
	description,
	mcp_servers,
	tools,
}: AgentVersionSnapshot) => ({
	id: agent_id,
	type,
	version,
	name,
	model,
	system,
	description,
	mcp_servers,
	tools,
})

const serializeSession = (
	{ agent_id: _agentId, agent_version: _agentVersion, ...snapshot }: SessionSnapshot,
	agent: AgentVersionSnapshot,
) => ({
	...snapshot,
	agent: pinnedAgent(agent),
	resources: serializeResources(snapshot.resources, snapshot.created_at),
})

const SKILL_FILE = "SKILL.md"

const strictUtf8 = new TextDecoder("utf-8", { fatal: true })
const utf8Of = (bytes: Uint8Array): Option.Option<string> => {
	try {
		return Option.some(strictUtf8.decode(bytes))
	} catch {
		return Option.none()
	}
}

const decodeResources = Schema.decodeUnknownEffect(SessionResources)

const repositoryName = (url: string): string => url.slice(url.lastIndexOf("/") + 1)

export type DomainSessionEvent = Domain.View.EventOf<typeof SessionView>

const eventTypeFilters = {
	"system.message": { _tag: "system.message" },
	"user.message": { _tag: "user.message" },
	"user.interrupt": { _tag: "user.interrupt" },
	"user.tool_confirmation": { _tag: "user.tool_confirmation" },
	"user.custom_tool_result": { _tag: "user.custom_tool_result" },
	"session.status_running": { _tag: "session.status_running" },
	"span.model_request_start": { _tag: "span.model_request_start" },
	"agent.tool_use": { _tag: "agent.tool_use" },
	"agent.tool_result": { _tag: "agent.tool_result" },
	"agent.mcp_tool_use": { _tag: "agent.mcp_tool_use" },
	"agent.mcp_tool_result": { _tag: "agent.mcp_tool_result" },
	"agent.custom_tool_use": { _tag: "agent.custom_tool_use" },
	"agent.thinking": { _tag: "agent.thinking" },
	"agent.message": { _tag: "agent.message" },
	"span.model_request_end": { _tag: "span.model_request_end" },
	"session.status_idle": { _tag: "session.status_idle" },
	"session.error": { _tag: "session.error" },
	"session.status_terminated": { _tag: "session.status_terminated" },
	"session.archived": { _tag: "session.archived" },
} as const satisfies { readonly [Type in SessionEventType]: { readonly _tag: Type } }

export interface SessionEventEntry {
	readonly envelope: {
		readonly id: string
		readonly commandId: string
		readonly seq: number
		readonly at: DateTime.Utc
	}
	readonly event: DomainSessionEvent
}

const encodeSessionEventJson = Schema.encodeSync(
	Schema.fromJsonString(Schema.toCodecJson(SessionEvent)),
)

const isSessionEvent = Schema.is(SessionEvent)

export const serializeSessionEvent = (
	{ envelope, event }: SessionEventEntry,
	completedAt?: DateTime.Utc | null,
): SessionEvent => {
	const { id, commandId, seq, at } = envelope
	const { _tag: type, ...fields } = event
	const input = type.startsWith("user.") || type === "system.message"
	const preview =
		event._tag === "agent.message" || event._tag === "agent.thinking"
			? event.preview_origin
			: undefined
	const eventId =
		preview !== undefined && (type === "agent.message" || type === "agent.thinking")
			? modelEventId(id, preview.turn, preview.started_at, type)
			: input && (commandId.startsWith("evt:") || commandId.startsWith("evt_"))
				? submittedSessionEventId(id, commandId)
				: sessionEventId(id, seq)
	const processedAt =
		event._tag === "user.message" || event._tag === "user.interrupt" ? (completedAt ?? null) : at
	const base = { id: eventId, seq, created_at: at, processed_at: processedAt }

	switch (type) {
		case "system.message":
			return {
				...base,
				type,
				content: event.content,
				processed_at: event.processed_at,
			}
		case "user.message":
			return { ...base, type, content: event.content }
		case "user.interrupt":
		case "agent.thinking":
			return { ...base, type }
		case "agent.message":
			return {
				...base,
				type,
				content: event.content,
				...(event.truncated === true ? { truncated: true as const } : {}),
			}
		case "session.status_idle": {
			const unanswered = decodeToolUseIds(event.event_ids).map((call) => toolUseEventId(id, call))
			return event.stop_reason.type === "requires_action"
				? {
						...base,
						type,
						stop_reason: { type: "requires_action", event_ids: unanswered },
						turn: event.turn,
					}
				: {
						...base,
						type,
						stop_reason: { type: event.stop_reason.type },
						turn: event.turn,
						...(unanswered.length === 0 ? {} : { cancelled_event_ids: unanswered }),
					}
		}
		case "session.status_terminated": {
			const unanswered = decodeToolUseIds(event.event_ids).map((call) => toolUseEventId(id, call))
			return {
				...base,
				type,
				...(unanswered.length === 0 ? {} : { cancelled_event_ids: unanswered }),
			}
		}
		case "session.archived":
			return { ...base, type }
		default: {
			const payload = { ...base, type, ...fields }
			if ("tool_use_id" in payload) {
				payload.tool_use_id = toolUseEventId(id, payload.tool_use_id)
				if (
					type === "agent.tool_use" ||
					type === "agent.mcp_tool_use" ||
					type === "agent.custom_tool_use"
				) {
					payload.id = payload.tool_use_id
				}
			}
			if ("custom_tool_use_id" in payload) {
				payload.custom_tool_use_id = toolUseEventId(id, payload.custom_tool_use_id)
			}
			if (isSessionEvent(payload)) {
				return payload
			}
			throw new Error(`Invalid payload for session event ${type}.`)
		}
	}
}

const askedResource = (resource: CreateSessionResource) => {
	switch (resource.type) {
		case "github_repository":
			return {
				type: resource.type,
				url: resource.url,
				mount_path: resource.mount_path ?? `/workspace/${repositoryName(resource.url)}`,
				checkout: resource.checkout ?? null,
				...(resource.authorization_token === undefined ? {} : { requires_token: true as const }),
			}
		case "memory_store":
			return {
				type: resource.type,
				memory_store_id: resource.memory_store_id,
				access: resource.access ?? "read_write",
				instructions: resource.instructions ?? null,
			}
		default:
			return {
				type: resource.type,
				artifact_id: resource.artifact_id,
				version: resource.version ?? null,
			}
	}
}

export const SessionsLive = HttpApiBuilder.group(CheckfuApi, "sessions", (handlers) =>
	Effect.gen(function* () {
		const agentVersionsByNumber = yield* AgentVersionByNumberView
		const admitSession = yield* AdmitSessionDecision
		const admitWithMessages = yield* AdmitSessionWithMessagesDecision
		const startSession = yield* OpenAutomationSessionDecision
		const confirmTool = yield* ConfirmToolDecision
		const returnCustomToolResult = yield* ReturnCustomToolResultDecision
		const sendSystem = yield* SendSystemMessageDecision
		const sessions = yield* Session
		const sessionViews = yield* SessionView
		const memoryStores = yield* MemoryStore
		const artifacts = yield* Artifact
		const manifestAt = yield* ArtifactManifestAt
		const pinnedArtifact = yield* PinnedArtifact
		const skills = yield* SkillReader
		const harness = yield* Harness
		const completions = yield* SessionTurnCompletion
		const publishedEvent = (entry: SessionEventEntry) => {
			const event = entry.event
			const turn =
				event._tag === "user.message" || event._tag === "user.interrupt" ? event.turn : undefined
			return turn === null || turn === undefined
				? Effect.succeed(serializeSessionEvent(entry))
				: Effect.map(completions.get(sessionTurnKey(entry.envelope.id, turn)), (finished) =>
						serializeSessionEvent(entry, Option.getOrNull(finished)),
					)
		}
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom
		const sseKeepaliveInterval = yield* SseKeepaliveInterval
		const sseMaxConnectionDuration = yield* SseMaxConnectionDuration
		const list = yield* makeLister
		const overObjectSockets = yield* ViewEventsOverObjectSockets
		const watchPreviews = yield* SessionPreviewSource
		const connectSessionView = overObjectSockets
			? (yield* Model.Internals).views.get(SessionView.viewName)?.connect
			: undefined
		if (overObjectSockets && connectSessionView === undefined) {
			return yield* Effect.die(new Error("SessionView is not pushed over object sockets."))
		}
		const { readArtifact } = yield* artifactReads

		const agents = yield* Agent
		const environments = yield* Environment
		const vaults = yield* Vault
		const credentials = yield* Credential
		const urlClaims = yield* CredentialUrlClaim

		const placeOf = (credentialId: string) =>
			Effect.gen(function* () {
				const credential = yield* credentials.get(CredentialId.make(credentialId))
				if (credential.status !== "active") {
					return { vault_id: null, target: null }
				}
				const vault = yield* vaults.get(VaultId.make(credential.vault_id))
				return vault.status === "active"
					? { vault_id: credential.vault_id, target: credential.mcp_server_url }
					: { vault_id: null, target: null }
			})

		const credentialsFor = (
			agentId: AgentId,
			agentVersion: number | null,
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
				const head = yield* agents.get(agentId)
				const environment = yield* environments.get(environmentId)
				const pinned = agentVersion ?? head.version
				const refusal = admissionRefusal(
					{ id: agentId, state: head },
					{ id: environmentId, state: environment },
					pinned,
				)
				if (refusal !== undefined) {
					return yield* refusal
				}
				const version =
					pinned === head.version
						? { mcp_servers: decodeMcpServers(head.mcp_servers) }
						: yield* agentVersionsByNumber
								.waitFor(
									agentVersionLookupKey(agentId, pinned),
									{ version: pinned },
									{ timeout: yield* AgentVersionWaitTimeout },
								)
								.pipe(Effect.orElseSucceed(() => null))
				if (version === null) {
					return yield* reject(503, `Agent ${agentId} version ${pinned} is not ready yet.`)
				}
				const servers = version.mcp_servers
				const networking = environment.config?.networking
				for (const server of servers) {
					const { host } = new URL(server.url)
					if (!mcpHostAllowed(networking, host)) {
						return yield* reject(
							400,
							`MCP server "${server.name}" (${host}) is not allowed by the environment's network rules.`,
						)
					}
				}
				const urls = [...new Set(servers.map((server) => server.url))]
				const claimed: Array<CredentialRequest["vaults"][number]> = []
				for (const vaultId of new Set(payload.vault_ids)) {
					const vault = yield* vaults.get(VaultId.make(vaultId))
					if (vault.status !== "active") {
						return yield* reject(400, `Vault ${vaultId} is not an active vault.`)
					}
					const holders = yield* Effect.forEach(
						urls,
						(mcp_server_url) =>
							Effect.map(urlClaims.get(credentialUrlClaimId(vaultId, mcp_server_url)), (claim) => ({
								credential_id: claim.holder,
								mcp_server_url,
							})),
						{ concurrency: 8 },
					)
					claimed.push({
						id: vaultId,
						credentials: holders.filter((entry) => entry.credential_id !== ""),
					})
				}
				const explicit = yield* Effect.forEach(payload.mcp_server_credentials ?? [], (pair) =>
					Effect.map(placeOf(pair.credential_id), (place) => ({ ...pair, ...place })),
				)
				const resolved = resolveMcpServerCredentials({ servers, explicit, vaults: claimed })
				if (Result.isFailure(resolved)) {
					return yield* reject(400, resolved.failure)
				}
				const text = encodeMcpServerCredentials(resolved.success)
				if (text === undefined) {
					return yield* reject(400, "The session's MCP server credentials are too long.")
				}
				return { agent_version: pinned, text }
			})

		const waitForPinnedAgentVersion = (agentId: string, version: number, timeout: Duration.Input) =>
			Effect.gen(function* () {
				const lookupKey = agentVersionLookupKey(agentId, version)
				const found = yield* agentVersionsByNumber.get(lookupKey)
				if (Option.isSome(found) && found.value !== null) {
					return found.value
				}
				const pinned = yield* agentVersionsByNumber.waitFor(lookupKey, { version }, { timeout })
				return pinned === null
					? yield* reject(503, `Agent ${agentId} version ${version} projection is not ready.`)
					: pinned
			})

		const existing = (id: SessionId) => {
			const ref = Session.ref(id)
			return readExisting({
				current: sessionViews.get(ref),
				missing: Effect.flatMap(sessions.get(id), (committed) =>
					committed._tag === "Uninitialized"
						? reject(404, `Session ${id} not found.`)
						: Effect.void,
				),
				projected: Effect.flatMap(SessionReadWaitTimeout, (timeout) =>
					sessionViews.waitFor(ref, { id }, { timeout }),
				),
			})
		}

		const resolvePinnedAgent = (agentId: string, version: number) =>
			Effect.gen(function* () {
				const timeout = Duration.min(
					Duration.fromInputUnsafe(yield* SessionReadWaitTimeout),
					Duration.fromInputUnsafe(yield* AgentVersionWaitTimeout),
				)
				return yield* waitForPinnedAgentVersion(agentId, version, timeout)
			})

		const retrieve = (id: SessionId, resolve: typeof resolvePinnedAgent = resolvePinnedAgent) =>
			Effect.gen(function* () {
				const snapshot = yield* existing(id)
				const agent = yield* resolve(snapshot.agent_id, snapshot.agent_version)
				return serializeSession(snapshot, agent)
			})

		const storeToken = (
			sessionId: SessionId,
			resourceId: SessionResourceId,
			authorization_token: RepositoryToken,
			replace: boolean,
		) =>
			harness
				.storeRepositoryToken({
					session_id: sessionId,
					resource_id: resourceId,
					authorization_token,
					replace,
				})
				.pipe(
					Effect.catchTag("HarnessUnavailable", () =>
						reject(
							503,
							`The token for resource ${resourceId} of session ${sessionId} could not be stored. Send it again with POST /v1/sessions/${sessionId}/resources/${resourceId}.`,
						),
					),
				)

		const artifactVersion = Effect.fn(function* (wanted: {
			readonly artifact_id: ArtifactId
			readonly version?: number
		}) {
			const artifact = yield* artifacts.get(wanted.artifact_id)
			if (artifact.status !== "active") {
				return yield* reject(404, `Artifact ${wanted.artifact_id} not found.`)
			}
			const version = wanted.version ?? artifact.version
			if (version === 0) {
				return yield* reject(
					400,
					`Artifact ${wanted.artifact_id} has no published version yet; publish one before mounting it.`,
				)
			}
			if (version > artifact.version) {
				return yield* reject(404, `Artifact ${wanted.artifact_id} has no version ${version}.`)
			}
			const manifest = yield* manifestAt(wanted.artifact_id, artifact, version).pipe(
				Effect.catchTag("ArtifactVersionNotReady", () =>
					reject(503, "Timed out waiting for view consistency."),
				),
			)
			if (manifest === null) {
				return yield* reject(404, `Artifact ${wanted.artifact_id} not found.`)
			}
			return {
				artifact_id: wanted.artifact_id,
				version,
				manifest,
				name: artifact.name,
				mount_path: artifactMountPath(artifact.name, wanted.artifact_id),
			}
		})

		const skillOf = Effect.fn(
			function* (pinned: { readonly artifact_id: ArtifactId; readonly manifest: string }) {
				const invalid = (reason: string) =>
					reject(400, `Artifact ${pinned.artifact_id} is not a skill: ${reason}.`)
				const gone = reject(404, `Artifact ${pinned.artifact_id} not found.`)
				const manifest = yield* pinnedArtifact.manifest(pinned.artifact_id, pinned.manifest)
				if (manifest === null) {
					return yield* gone
				}
				const file = manifest.files.find(({ path }) => path === SKILL_FILE)
				if (file === undefined) {
					return yield* invalid(`it has no ${SKILL_FILE} at its root`)
				}
				if (file.size > MAX_SKILL_FILE_BYTES) {
					return yield* invalid(
						`its ${SKILL_FILE} is ${file.size} bytes; the limit is ${MAX_SKILL_FILE_BYTES}`,
					)
				}
				const bytes = yield* pinnedArtifact.blob(pinned.artifact_id, file.sha256)
				if (bytes === null) {
					return yield* gone
				}
				const markdown = Option.getOrUndefined(utf8Of(bytes))
				if (markdown === undefined) {
					return yield* invalid(`its ${SKILL_FILE} is not UTF-8 text`)
				}
				const read = yield* skills.read(markdown)
				if (!read.ok) {
					return yield* invalid(read.message)
				}
				return { name: read.name, description: read.description }
			},
			Effect.catchTag("ArtifactBytesMissing", () => reject(500, "Failed to load artifact files.")),
		)

		const requestedResource = Effect.fn(function* (resource: CreateSessionResource) {
			if (resource.type === "github_repository") {
				return {
					type: resource.type,
					url: resource.url,
					mount_path: resource.mount_path ?? `/workspace/${repositoryName(resource.url)}`,
					checkout: resource.checkout ?? null,
					...(resource.authorization_token === undefined ? {} : { requires_token: true as const }),
				}
			}
			if (resource.type === "artifact") {
				return {
					type: resource.type,
					...(yield* artifactVersion({
						...resource,
						artifact_id: ArtifactId.make(resource.artifact_id),
					})),
				}
			}
			if (resource.type === "skill") {
				const pinned = yield* artifactVersion({
					...resource,
					artifact_id: ArtifactId.make(resource.artifact_id),
				})
				const { name, description } = yield* skillOf(pinned)
				return {
					...pinned,
					type: resource.type,
					name,
					description,
					mount_path: skillMountPath(name),
				}
			}
			const storeId = MemoryStoreId.make(resource.memory_store_id)
			const store = yield* memoryStores.get(storeId)
			if (store.status === "" || store.status === "deleted") {
				return yield* reject(404, `Memory store ${storeId} not found.`)
			}
			if (store.status !== "active") {
				return yield* reject(409, `Memory store ${storeId} is archived.`)
			}
			return {
				type: resource.type,
				memory_store_id: storeId,
				access: resource.access ?? "read_write",
				instructions: resource.instructions ?? null,
				name: store.name,
				description: store.description,
				mount_path: memoryMountPath(store.name, storeId),
			}
		})

		const existingResource = (sessionId: SessionId, resourceId: SessionResourceId) =>
			Effect.gen(function* () {
				const session = yield* existing(sessionId)
				const resource = session.resources.find(({ id }) => id === resourceId)
				if (resource === undefined) {
					return yield* reject(404, `Resource ${resourceId} not found in session ${sessionId}.`)
				}
				return { session, resource }
			})

		return handlers
			.handle("create", ({ payload, headers }) =>
				Effect.gen(function* () {
					const idempotencyKey = headers["idempotency-key"]
					const agent = payload.agent
					const rawAgentId = typeof agent === "string" ? agent : agent.id
					const decodedAgentId = Schema.decodeOption(AgentId)(rawAgentId)
					if (Option.isNone(decodedAgentId)) {
						return yield* reject(404, `Agent ${rawAgentId} not found.`)
					}
					const decodedEnvironmentId = Schema.decodeOption(EnvironmentId)(payload.environment_id)
					if (Option.isNone(decodedEnvironmentId)) {
						return yield* reject(404, `Environment ${payload.environment_id} not found.`)
					}
					const agentId = decodedAgentId.value
					const environmentId = decodedEnvironmentId.value
					const missing = {
						AgentNotFound: () => reject(404, `Agent ${agentId} not found.`),
						AgentVersionNotFound: ({ version }: { readonly version: number }) =>
							reject(404, `Agent ${agentId} has no version ${version}.`),
						EnvironmentNotFound: () => reject(404, `Environment ${environmentId} not found.`),
					}
					const agentVersion = typeof agent === "string" ? null : (agent.version ?? null)
					const title = payload.title ?? null
					const messages = yield* Effect.forEach(
						payload.initial_events ?? [],
						({ content }, index) =>
							Schema.decodeEffect(MessageText)(content.map(({ text }) => text).join("\n")).pipe(
								Effect.catch(() =>
									reject(
										400,
										`initial_events[${index}] combined text must be between 1 and ${MAX_MESSAGE_TEXT_LENGTH} characters.`,
									),
								),
							),
					)
					const initialMessage = messages[0]
					const initialPlan =
						messages.length <= 1
							? undefined
							: { count: messages.length, messages: encodeInitialMessages(messages) }
					if (
						initialPlan !== undefined &&
						initialMessagesBytes(initialPlan.messages) > MAX_SESSION_INITIAL_MESSAGES_BYTES
					) {
						return yield* errorResponse(
							apiError(
								413,
								`Initial messages exceed ${MAX_SESSION_INITIAL_MESSAGES_BYTES} bytes of JSON-encoded text.`,
								yield* currentRequestId,
							),
						)
					}
					const asked = (payload.resources ?? []).map(askedResource)
					const identity = yield* createIdentity(digest, random, {
						resource: "session",
						prefix: "sess",
						key: idempotencyKey,
						body: {
							agent_id: agentId,
							agent_version: agentVersion,
							environment_id: environmentId,
							title,
							initial_events: messages,
							vault_ids: payload.vault_ids,
							mcp_server_credentials: payload.mcp_server_credentials,
							...(asked.length === 0 ? {} : { resources: asked }),
						},
					})
					const id = SessionId.make(identity.id)
					const sendOptions = identity.options
					const unverified = reject(
						503,
						`The creation receipt for session ${id} is unavailable. Retry the request.`,
					)
					const replay =
						sendOptions !== undefined &&
						(yield* sessions.get(id).pipe(Effect.catchDefect(() => unverified)))._tag !==
							"Uninitialized"
					const given = replay
						? { agent_version: agentVersion, text: NO_MCP_SERVER_CREDENTIALS }
						: yield* credentialsFor(agentId, agentVersion, environmentId, payload).pipe(
								Effect.catchTags(missing),
							)
					const resources = replay
						? []
						: yield* decodeResources(
								yield* Effect.forEach(
									yield* Effect.forEach(payload.resources ?? [], requestedResource),
									(resource, index) =>
										Effect.map(
											idempotencyKey === undefined
												? randomId(random, "sesrsc")
												: idempotentId(digest, "sesrsc", [
														"create",
														"session",
														"resource",
														idempotencyKey,
														index,
													]),
											(resourceId) => ({ id: resourceId, ...resource }),
										),
								),
							).pipe(Effect.catchTag("SchemaError", (error) => reject(400, error.message)))
					const admission = {
						session_id: id,
						agent_id: agentId,
						agent_version: given.agent_version,
						mcp_server_credentials: given.text,
						environment_id: environmentId,
						title,
						resources,
					}
					const refused = { SessionAlreadyExists: rejectReusedSessionKey, ...missing }
					// The host looks up the original command receipt before deciding against the current state.
					const send =
						initialPlan !== undefined
							? admitWithMessages.send(
									new AdmitSessionWithMessages({ ...admission, initial_messages: initialPlan }),
									sendOptions,
								)
							: initialMessage === undefined
								? admitSession.send(new AdmitSession(admission), sendOptions)
								: startSession.send(
										new OpenAutomationSession({ ...admission, text: initialMessage }),
										sendOptions,
									)
					const receipt = yield* Unify.unify(send).pipe(
						Effect.catchTags(refused),
						Effect.catchDefect((cause) => (replay ? unverified : Effect.die(cause))),
					)
					const created = receipt.events.find((event) => event._tag === "session.created")
					if (created?._tag !== "session.created") {
						return yield* unverified
					}
					const unstored = yield* Effect.forEach(payload.resources ?? [], (resource, index) =>
						Effect.gen(function* () {
							if (
								resource.type !== "github_repository" ||
								resource.authorization_token === undefined
							) {
								return []
							}
							const stored = created.resources[index]
							if (stored?.type !== "github_repository" || stored.requires_token !== true) {
								return yield* unverified
							}
							return yield* harness
								.storeRepositoryToken({
									session_id: id,
									resource_id: stored.id,
									authorization_token: Redacted.make(resource.authorization_token),
									replace: false,
								})
								.pipe(
									Effect.as([]),
									Effect.catchTag("HarnessUnavailable", () => Effect.succeed([stored.id])),
								)
						}),
					)
					if (unstored.flat().length > 0) {
						return yield* reject(
							503,
							`The tokens for resources ${unstored.flat().join(", ")} of session ${id} could not be stored. Send each again with POST /v1/sessions/${id}/resources/{resource_id}.`,
						)
					}
					const pinnedReady = yield* waitForPinnedAgentVersion(
						created.agent_id,
						created.agent_version,
						yield* AgentVersionWaitTimeout,
					).pipe(orPending(id, "session"))
					if (isPending(pinnedReady)) {
						return pinnedReady
					}
					const finished =
						created.initial_messages === undefined
							? undefined
							: (yield* recordInitialMessages(sessions, id, created.initial_messages.messages)).at(
									-1,
								)
					const sessionCommit = commitForStream(
						finished?.commits ?? receipt.commits,
						`Session/${id}`,
					)
					const result = yield* sessionViews
						.get(Session.ref(id), sessionCommit === undefined ? {} : { atLeast: sessionCommit })
						.pipe(orPending(id, "session"))
					if (isPending(result)) {
						return result
					}
					const snapshot = yield* present(result, 500, "Failed to load created session.")
					return {
						...serializeSession(snapshot, pinnedReady),
						status: initialMessage === undefined ? ("idle" as const) : ("running" as const),
						turn: initialMessage === undefined ? 0 : 1,
						usage: { input_tokens: 0, output_tokens: 0 },
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
							resolvePinnedAgent(
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
					const result = yield* archiveAndRead(
						params.session_id,
						"session",
						"Session",
						sessions.send(new ArchiveSession({ session_id: params.session_id })),
						(receipt) => sessionViews.get(Session.ref(params.session_id), { atLeast: receipt }),
					)
					if (isPending(result)) {
						return result
					}
					const agent = yield* resolvePinnedAgent(result.agent_id, result.agent_version).pipe(
						orPending(params.session_id, "session"),
					)
					return isPending(agent) ? agent : serializeSession(result, agent)
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
			.handle("listResources", ({ params }) =>
				Effect.gen(function* () {
					const session = yield* existing(params.session_id)
					return { data: serializeResources(session.resources, session.created_at) }
				}).pipe(handled),
			)
			.handle("getResource", ({ params }) =>
				Effect.gen(function* () {
					const { session, resource } = yield* existingResource(
						params.session_id,
						params.resource_id,
					)
					const [item] = serializeResources([resource], session.created_at)
					return yield* present(Option.fromNullishOr(item), 404, "Resource not found.")
				}).pipe(handled),
			)
			.handle("updateResource", ({ params, payload }) =>
				Effect.gen(function* () {
					const { session, resource } = yield* existingResource(
						params.session_id,
						params.resource_id,
					)
					if (resource.type !== "github_repository") {
						return yield* reject(400, `Resource ${resource.id} is not a repository.`)
					}
					if (session.status === "terminated") {
						return yield* reject(409, `Session ${session.id} is terminated.`)
					}
					yield* storeToken(
						session.id,
						resource.id,
						Redacted.make(payload.authorization_token),
						true,
					)
					if ((yield* sessions.get(session.id))._tag === "Terminated") {
						return yield* reject(409, `Session ${session.id} is terminated.`)
					}
					const [item] = serializeResources([resource], session.created_at)
					return yield* present(Option.fromNullishOr(item), 404, "Resource not found.")
				}).pipe(handled),
			)
			.handle("sendEvents", ({ params, headers, payload }) =>
				Effect.gen(function* () {
					const id = params.session_id
					const idempotencyKey = headers["idempotency-key"]
					const seenEventIds = new Set<string>()
					const prepared: Array<
						PreparedEvent & {
							readonly eventId: ClientEventId | undefined
							readonly commandId: string
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
									: yield* randomId(random, "evt")
						if (event.type === "user.interrupt") {
							prepared.push({ type: "user.interrupt", eventId: event.id, commandId })
							continue
						}
						if (event.type === "user.tool_confirmation") {
							if (event.result === "allow" && event.deny_message !== undefined) {
								return yield* reject(
									400,
									`events[${index}] has a deny_message but allows the call.`,
								)
							}
							prepared.push({
								type: "user.tool_confirmation",
								eventId: event.id,
								commandId,
								tool_use_id: yield* readToolUseId(id, event.tool_use_id),
								result: event.result,
								deny_message: event.deny_message ?? "",
							})
							continue
						}
						if (event.type === "user.custom_tool_result") {
							const resultText = event.content.map((block) => block.text).join("\n")
							if (resultText.length > MAX_CUSTOM_TOOL_RESULT_LENGTH) {
								return yield* reject(
									400,
									`events[${index}] content is more than ${MAX_CUSTOM_TOOL_RESULT_LENGTH} characters.`,
								)
							}
							prepared.push({
								type: "user.custom_tool_result",
								eventId: event.id,
								commandId,
								custom_tool_use_id: yield* readToolUseId(id, event.custom_tool_use_id),
								text: resultText,
								is_error: event.is_error === true,
							})
							continue
						}
						if (event.type === "system.message") {
							prepared.push({
								type: event.type,
								eventId: event.id,
								commandId,
								content: event.content,
							})
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
						prepared.push({ type: event.type, eventId: event.id, commandId, text })
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
						const sendOptions = { commandId: item.commandId }
						const eventId = submittedSessionEventId(id, item.commandId)
						const claimed =
							item.eventId === undefined && idempotencyKey === undefined
								? Effect.void
								: Effect.gen(function* () {
										const fingerprint = yield* eventBatchFingerprint(digest, [item])
										const claim = yield* sessions.send(
											new ClaimIdempotencyKey({ session_id: id, fingerprint }),
											sendOptions,
										)
										if (
											!claim.events.some(
												(event) =>
													event._tag === "idempotency_key.claimed" &&
													event.fingerprint === fingerprint,
											)
										) {
											return yield* reject(409, IDEMPOTENCY_CONFLICT_MESSAGE)
										}
									})
						const outcome =
							item.type === "system.message"
								? yield* settled(
										claimed.pipe(
											Effect.andThen(
												sendSystem.send(
													new SendSystemMessage({
														session_id: id,
														content_json: encodeSystemMessage(item.content),
													}),
													sendOptions,
												),
											),
											Effect.flatMap((receipt) => {
												const recorded = receipt.events.find(
													(event) => event._tag === "system.message",
												)
												return recorded === undefined
													? reject(409, IDEMPOTENCY_CONFLICT_MESSAGE)
													: Effect.succeed({
															type: "system.message" as const,
															id: eventId,
															content: recorded.content,
															processed_at: recorded.processed_at,
														})
											}),
										),
									)
								: item.type === "user.tool_confirmation"
									? yield* settled(
											claimed.pipe(
												Effect.andThen(
													confirmTool.send(
														new ConfirmTool({
															session_id: id,
															confirmation_id: toolConfirmationId(id, item.tool_use_id),
															tool_use_id: item.tool_use_id,
															result: item.result,
															deny_message: item.deny_message,
														}),
														sendOptions,
													),
												),
												Effect.map((receipt) => ({
													type: "user.tool_confirmation" as const,
													id: eventId,
													processed_at:
														receipt.events.find((event) => event._tag === "user.tool_confirmation")
															?.processed_at ?? null,
													tool_use_id: toolUseEventId(id, item.tool_use_id),
													result: item.result,
													...(item.deny_message === "" ? {} : { deny_message: item.deny_message }),
												})),
											),
										)
									: item.type === "user.custom_tool_result"
										? yield* settled(
												claimed.pipe(
													Effect.andThen(
														returnCustomToolResult.send(
															new ReturnCustomToolResult({
																session_id: id,
																confirmation_id: toolConfirmationId(id, item.custom_tool_use_id),
																custom_tool_use_id: item.custom_tool_use_id,
																text: item.text,
																is_error: item.is_error,
															}),
															sendOptions,
														),
													),
													Effect.map((receipt) => ({
														type: "user.custom_tool_result" as const,
														id: eventId,
														processed_at:
															receipt.events.find(
																(event) => event._tag === "user.custom_tool_result",
															)?.processed_at ?? null,
														custom_tool_use_id: toolUseEventId(id, item.custom_tool_use_id),
														content: [{ type: "text" as const, text: item.text }],
														...(item.is_error ? { is_error: true } : {}),
													})),
												),
											)
										: item.type === "user.interrupt"
											? yield* settled(
													sessions
														.send(new SendUserInterrupt({ session_id: id }), sendOptions)
														.pipe(
															Effect.flatMap((receipt) =>
																receipt.events.some((event) => event._tag === "user.interrupt")
																	? Effect.succeed({
																			type: "user.interrupt" as const,
																			id: eventId,
																			processed_at: null,
																		})
																	: reject(409, IDEMPOTENCY_CONFLICT_MESSAGE),
															),
														),
												)
											: yield* settled(
													sessions
														.send(
															new SendUserMessage({ session_id: id, text: item.text }),
															sendOptions,
														)
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
																	id: eventId,
																	processed_at: null,
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
					const after = query.page === undefined ? undefined : Number(query.page)
					const page = yield* sessionViews.list(Session.ref(params.session_id), {
						...(after === undefined ? {} : { after }),
						take: query.limit ?? 50,
						order: query.order ?? "asc",
						...(query.types === undefined || query.types.length === 0
							? {}
							: { where: { OR: query.types.map((type) => eventTypeFilters[type]) } }),
					})
					return listPage(
						yield* Effect.forEach(page.entries, publishedEvent, { concurrency: 8 }),
						page.cursor,
					)
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
					const deltaTypes = query["event_deltas[]"] ?? []
					let caughtUp = false
					const offsets = new Map<string, number>()
					const finished = new Set<string>()
					const previews = Stream.suspend(() => {
						return watchPreviews(id).pipe(
							Stream.catchCause(() => Stream.empty),
							Stream.filter(({ event, offset }) => {
								if (!caughtUp) {
									return false
								}
								if (event.type === "event_start") {
									if (
										finished.has(event.event.id) ||
										offsets.has(event.event.id) ||
										!deltaTypes.includes(event.event.type)
									) {
										return false
									}
									if (offsets.size >= 32) {
										offsets.clear()
									}
									offsets.set(event.event.id, 0)
									return true
								}
								if (offsets.get(event.event_id) !== offset - 1) {
									offsets.delete(event.event_id)
									return false
								}
								offsets.set(event.event_id, offset)
								return true
							}),
							Stream.map(({ event }) =>
								Sse.encoder.write({
									_tag: "Event",
									id: undefined,
									event: event.type,
									data: JSON.stringify(event),
								}),
							),
						)
					})
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
					const frames = Stream.concat(
						catchUp.pipe(
							Stream.onEnd(
								Effect.sync(() => {
									caughtUp = true
								}),
							),
						),
						live,
					).pipe(
						Stream.takeUntil((entry) => entry.event._tag === "session.archived"),
						Stream.filter((entry) => entry.envelope.seq > from),
						Stream.mapEffect(publishedEvent),
						Stream.map((payload) => {
							if (
								deltaTypes.length > 0 &&
								(payload.type === "agent.message" || payload.type === "agent.thinking")
							) {
								offsets.delete(payload.id)
								if (finished.size >= 32) {
									finished.delete(finished.values().next().value ?? "")
								}
								finished.add(payload.id)
							}
							return Sse.encoder.write({
								_tag: "Event",
								id: String(payload.seq),
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
						Stream.merge(
							deltaTypes.length === 0
								? frames
								: Stream.merge(frames, previews, { haltStrategy: "left" }),
							keepalive,
							{ haltStrategy: "left" },
						).pipe(Stream.encodeText),
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
