import { NO_AGENT_TOOLS, NO_MCP_SERVERS } from "../src/Mcp/McpServers.ts"
import * as Domain from "@alchemy.run/domain"
import { ArtifactBytesKept } from "../src/Artifact/ArtifactBytes.external.ts"
import { FileBytesKept } from "../src/File/FileBytes.external.ts"
import { OutputsSaver, OutputsUnsaved } from "../src/Session/OutputsSaver.external.ts"
import { Story } from "@alchemy.run/domain/Story"
import { Agent } from "../src/Agent/Agent.aggregate.ts"
import { AgentId } from "../src/Agent/Agent.id.ts"
import { AgentArchivedError } from "../src/Agent/AgentArchived.rejection.ts"
import { AgentNotFound } from "../src/Agent/AgentNotFound.rejection.ts"
import { AgentVersionId } from "../src/Agent/AgentVersion.id.ts"
import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "../src/Agent/AgentVersionByNumberView.view.ts"
import { AgentView } from "../src/Agent/AgentView.view.ts"
import { AgentArchived, ArchiveAgent } from "../src/Agent/ArchiveAgent.command.ts"
import { AgentCreated, CreateAgent } from "../src/Agent/CreateAgent.command.ts"
import { AgentUpdated, UpdateAgent } from "../src/Agent/UpdateAgent.command.ts"
import {
	ArchiveEnvironment,
	EnvironmentArchived,
} from "../src/Environment/ArchiveEnvironment.command.ts"
import {
	CreateEnvironment,
	EnvironmentCreated,
} from "../src/Environment/CreateEnvironment.command.ts"
import {
	DeleteEnvironment,
	EnvironmentDeleted,
} from "../src/Environment/DeleteEnvironment.command.ts"
import { Environment } from "../src/Environment/Environment.aggregate.ts"
import { EnvironmentId } from "../src/Environment/Environment.id.ts"
import { EnvironmentArchivedError } from "../src/Environment/EnvironmentArchived.rejection.ts"
import { EnvironmentNotFound } from "../src/Environment/EnvironmentNotFound.rejection.ts"
import { EnvironmentView } from "../src/Environment/EnvironmentView.view.ts"
import {
	AgentMessage,
	SessionStatusIdle,
	SpanModelRequestEnd,
} from "../src/Session/CommitModelReply.command.ts"
import { SessionAlreadyExists, SessionCreated } from "../src/Session/CreateSession.command.ts"
import { Harness } from "../src/Session/Harness.external.ts"
import { SpanModelRequestStart } from "../src/Session/RecordModelRequestStart.command.ts"
import { RunTurn, turnKey } from "../src/Session/RunTurn.saga.ts"
import {
	SendUserMessage,
	SessionStatusRunning,
	UserMessage,
} from "../src/Session/SendUserMessage.command.ts"
import { Session } from "../src/Session/Session.aggregate.ts"
import { SessionId } from "../src/Session/Session.id.ts"
import { SessionView } from "../src/Session/SessionView.view.ts"
import { TurnInput } from "../src/Session/TurnInput.view.ts"
import { describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Checkfu, CheckfuHandlersLive } from "../src/Checkfu.model.ts"
import { ListingStore } from "../src/Listing/ListingStore.ts"
import { WebhookEventsNoop } from "../src/Webhook/WebhookEvents.external.ts"
import { SessionResourceId } from "../src/Session/SessionResource.ts"
import {
	AdmitSession,
	AgentVersionNotFound,
	BoundedAgentId,
	BoundedEnvironmentId,
} from "../src/Session/AdmitSession.command.ts"

const story = Story.make(Checkfu, {
	layer: CheckfuHandlersLive.pipe(
		Layer.provide([ArtifactBytesKept, FileBytesKept, OutputsUnsaved, WebhookEventsNoop]),
		Layer.provide(ListingStore.memory),
	),
	stub: [Harness],
})

const HarnessStubLayer = Harness.toLayer(
	Effect.succeed({
		interrupt: () => Effect.void,
		discardWorkspace: () => Effect.void,
		storeRepositoryToken: () => Effect.void,
		runTurn: () =>
			Effect.succeed({
				thinking: null,
				text: "ok",
				input_tokens: 1,
				output_tokens: 1,
				stop_reason: { type: "end_turn" as const },
			}),
	}),
)

const t0 = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")

describe("Checkfu unified hosted model stories", () => {
	it.effect("is well defined", () =>
		Effect.scoped(
			Layer.build(
				Checkfu.layer(
					CheckfuHandlersLive.pipe(
						Layer.provide([ArtifactBytesKept, FileBytesKept, OutputsUnsaved, WebhookEventsNoop]),
						Layer.provide([HarnessStubLayer, ListingStore.memory]),
					),
				),
			),
		).pipe(Effect.provide(Domain.InMemory)),
	)

	it.effect(
		"enforces cross-domain admission eligibility, version pinning, and turn execution on the real Checkfu model",
		() => {
			const agent = Agent.ref(AgentId.make("agent_verify_1"))
			const boundedAgentId = BoundedAgentId.make(agent.id)
			const v1 = AgentVersionId.make("aver_verify_1")
			const v2 = AgentVersionId.make("aver_verify_2")
			const env = Environment.ref(EnvironmentId.make("env_verify_1"))
			const boundedEnvId = BoundedEnvironmentId.make(env.id)
			const archivedEnv = Environment.ref(EnvironmentId.make("env_verify_archived"))
			const boundedArchivedEnvId = BoundedEnvironmentId.make(archivedEnv.id)
			const deletedEnv = Environment.ref(EnvironmentId.make("env_verify_deleted"))
			const boundedDeletedEnvId = BoundedEnvironmentId.make(deletedEnv.id)
			const missingAgentId = BoundedAgentId.make("agent_missing")
			const missingEnvId = BoundedEnvironmentId.make("env_missing")
			const sessionV1 = Session.ref(SessionId.make("sess_verify_v1"))
			const sessionLatest = Session.ref(SessionId.make("sess_verify_latest"))
			const sessionRejected = Session.ref(SessionId.make("sess_verify_rejected"))
			const reqId = `${sessionV1.id}:turn:1:req:1`
			const envConfig = { type: "cloud" as const, networking: { type: "unrestricted" as const } }
			const repositories = [
				{
					id: SessionResourceId.make("sesrsc_verify_api"),
					type: "github_repository" as const,
					access: "read_write" as const,
					url: "https://github.com/acme/api",
					mount_path: "/workspace/api",
					checkout: null,
				},
				{
					id: SessionResourceId.make("sesrsc_verify_docs"),
					type: "github_repository" as const,
					access: "read_write" as const,
					url: "https://github.com/acme/docs",
					mount_path: "/workspace/handbook",
					checkout: {
						type: "commit" as const,
						sha: "0123456789abcdef0123456789abcdef01234567",
					},
				},
			]

			return story(
				Story.clock(t0),

				Story.when(
					new AdmitSession({
						session_id: sessionRejected.id,
						agent_id: missingAgentId,
						agent_version: null,
						environment_id: missingEnvId,
						title: null,
						mcp_server_credentials: "[]",
					}),
				),
				Story.rejected(new AgentNotFound({ agent_id: AgentId.make(missingAgentId) })),

				Story.when(
					new CreateAgent({
						mcp_servers: NO_MCP_SERVERS,
						tools: NO_AGENT_TOOLS,
						agent_id: agent.id,
						version_id: v1,
						name: "Verified Agent",
						model: { id: "gpt-4o-mini" },
						system: "Be concise.",
						description: null,
					}),
				),
				Story.then(
					agent,
					new AgentCreated({
						mcp_servers: "[]",
						tools: "[]",
						version: 1,
						version_id: v1,
						name: "Verified Agent",
						model: { id: "gpt-4o-mini" },
						system: "Be concise.",
						description: null,
					}),
				),
				Story.when(
					new UpdateAgent({
						agent_id: agent.id,
						expected_version: 1,
						next_version_id: v2,
						changes: {
							name: "Verified Agent v2",
							model: { id: "gpt-4o-mini" },
							system: "Be extra concise.",
							description: null,
						},
					}),
				),
				Story.then(
					agent,
					new AgentUpdated({
						mcp_servers: "[]",
						tools: "[]",
						version: 2,
						version_id: v2,
						name: "Verified Agent v2",
						model: { id: "gpt-4o-mini" },
						system: "Be extra concise.",
						description: null,
					}),
				),
				Story.when(
					new CreateEnvironment({
						environment_id: env.id,
						name: "Verified Env",
						description: null,
						config: envConfig,
					}),
				),
				Story.then(
					env,
					new EnvironmentCreated({
						version: 1,
						name: "Verified Env",
						description: null,
						config: envConfig,
					}),
				),
				Story.when(
					new CreateEnvironment({
						environment_id: archivedEnv.id,
						name: "Archived Env",
						description: null,
						config: envConfig,
					}),
				),
				Story.then(
					archivedEnv,
					new EnvironmentCreated({
						version: 1,
						name: "Archived Env",
						description: null,
						config: envConfig,
					}),
				),
				Story.when(new ArchiveEnvironment({ environment_id: archivedEnv.id })),
				Story.then(archivedEnv, new EnvironmentArchived()),
				Story.when(
					new CreateEnvironment({
						environment_id: deletedEnv.id,
						name: "Deleted Env",
						description: null,
						config: envConfig,
					}),
				),
				Story.then(
					deletedEnv,
					new EnvironmentCreated({
						version: 1,
						name: "Deleted Env",
						description: null,
						config: envConfig,
					}),
				),
				Story.when(new DeleteEnvironment({ environment_id: deletedEnv.id })),
				Story.then(deletedEnv, new EnvironmentDeleted()),
				Story.view(EnvironmentView, deletedEnv, Story.none),

				Story.when(
					new AdmitSession({
						session_id: sessionRejected.id,
						agent_id: boundedAgentId,
						agent_version: 3,
						environment_id: boundedEnvId,
						title: null,
						mcp_server_credentials: "[]",
					}),
				),
				Story.rejected(new AgentVersionNotFound({ agent_id: agent.id, version: 3 })),
				Story.when(
					new AdmitSession({
						session_id: sessionRejected.id,
						agent_id: boundedAgentId,
						agent_version: null,
						environment_id: missingEnvId,
						title: null,
						mcp_server_credentials: "[]",
					}),
				),
				Story.rejected(
					new EnvironmentNotFound({ environment_id: EnvironmentId.make(missingEnvId) }),
				),
				Story.when(
					new AdmitSession({
						session_id: sessionRejected.id,
						agent_id: boundedAgentId,
						agent_version: null,
						environment_id: boundedDeletedEnvId,
						title: null,
						mcp_server_credentials: "[]",
					}),
				),
				Story.rejected(new EnvironmentNotFound({ environment_id: deletedEnv.id })),
				Story.when(
					new AdmitSession({
						session_id: sessionRejected.id,
						agent_id: boundedAgentId,
						agent_version: null,
						environment_id: boundedArchivedEnvId,
						title: null,
						mcp_server_credentials: "[]",
					}),
				),
				Story.rejected(new EnvironmentArchivedError({ environment_id: archivedEnv.id })),

				Story.when(
					new AdmitSession({
						session_id: sessionV1.id,
						agent_id: boundedAgentId,
						agent_version: 1,
						environment_id: boundedEnvId,
						title: "Pinned v1",
						mcp_server_credentials: "[]",
						resources: repositories,
					}),
				),
				Story.then(
					sessionV1,
					new SessionCreated({
						agent_id: agent.id,
						agent_version: 1,
						environment_id: env.id,
						title: "Pinned v1",
						mcp_server_credentials: "[]",
						resources: repositories,
					}),
				),
				Story.replied({ agent_version: 1 }),
				Story.when(
					new AdmitSession({
						session_id: sessionV1.id,
						agent_id: boundedAgentId,
						agent_version: null,
						environment_id: boundedEnvId,
						title: null,
						mcp_server_credentials: "[]",
					}),
				),
				Story.rejected(new SessionAlreadyExists({ session_id: sessionV1.id })),
				Story.when(
					new AdmitSession({
						session_id: sessionLatest.id,
						agent_id: boundedAgentId,
						agent_version: null,
						environment_id: boundedEnvId,
						title: null,
						mcp_server_credentials: "[]",
					}),
				),
				Story.then(
					sessionLatest,
					new SessionCreated({
						agent_id: agent.id,
						agent_version: 2,
						environment_id: env.id,
						title: null,
						mcp_server_credentials: "[]",
					}),
				),
				Story.replied({ agent_version: 2 }),

				Story.view(AgentVersionByNumberView, agentVersionLookupKey(agent.id, 1), {
					id: v1,
					agent_id: agent.id,
					type: "agent",
					version: 1,
					name: "Verified Agent",
					model: { id: "gpt-4o-mini" },
					system: "Be concise.",
					description: null,
					created_at: t0,
				}),
				Story.view(AgentVersionByNumberView, agentVersionLookupKey(agent.id, 2), {
					id: v2,
					agent_id: agent.id,
					type: "agent",
					version: 2,
					name: "Verified Agent v2",
					model: { id: "gpt-4o-mini" },
					system: "Be extra concise.",
					description: null,
					created_at: t0,
				}),
				Story.view(EnvironmentView, env, {
					id: env.id,
					type: "environment",
					version: 1,
					name: "Verified Env",
					description: null,
					config: envConfig,
					created_at: t0,
					updated_at: t0,
					archived_at: null,
				}),
				Story.view(SessionView, sessionV1, { resources: repositories }),
				Story.view(TurnInput, sessionV1, { resources: repositories }),
				Story.view(SessionView, sessionLatest, {
					id: sessionLatest.id,
					type: "session",
					agent_id: agent.id,
					agent_version: 2,
					environment_id: env.id,
					title: null,
					resources: [],
					status: "idle",
					turn: 0,
					usage: { input_tokens: 0, output_tokens: 0 },
					created_at: t0,
					updated_at: t0,
					archived_at: null,
				}),
				Story.view(TurnInput, sessionLatest, {
					agent_id: agent.id,
					agent_version: 2,
					environment_id: env.id,
					resources: [],
					turn: 0,
					input: [],
					unsent: [],
				}),

				Story.when(new ArchiveAgent({ agent_id: agent.id })),
				Story.then(agent, new AgentArchived()),
				Story.view(AgentView, agent, {
					id: agent.id,
					type: "agent",
					version: 2,
					current_version_id: v2,
					name: "Verified Agent v2",
					model: { id: "gpt-4o-mini" },
					system: "Be extra concise.",
					description: null,
					created_at: t0,
					updated_at: t0,
					archived_at: t0,
				}),
				Story.when(
					new AdmitSession({
						session_id: sessionRejected.id,
						agent_id: boundedAgentId,
						agent_version: null,
						environment_id: boundedEnvId,
						title: null,
						mcp_server_credentials: "[]",
					}),
				),
				Story.rejected(new AgentArchivedError({ agent_id: agent.id })),

				Story.when(new SendUserMessage({ session_id: sessionV1.id, text: "Hello Checkfu" })),
				Story.then(
					sessionV1,
					new UserMessage({ content: [{ type: "text", text: "Hello Checkfu" }] }),
					new SessionStatusRunning({ turn: 1 }),
				),
				Story.then(sessionV1, new SpanModelRequestStart({ model_request_start_id: reqId })),
				Story.call(Harness.runTurn, {
					session_id: sessionV1.id,
					agent_id: agent.id,
					agent_version: 1,
					environment_id: env.id,
					resources: repositories,
					turn: 1,
				}),
				Story.succeed(Harness.runTurn, {
					thinking: null,
					text: "Hello from v1",
					input_tokens: 10,
					output_tokens: 5,
					stop_reason: { type: "end_turn" },
				}),
				Story.then(
					sessionV1,
					new AgentMessage({ content: [{ type: "text", text: "Hello from v1" }] }),
					new SpanModelRequestEnd({
						model_request_start_id: reqId,
						model_usage: { input_tokens: 10, output_tokens: 5 },
						is_error: false,
					}),
					new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, event_ids: "[]" }),
				),
				Story.call(OutputsSaver.save, {
					session_id: sessionV1.id,
					turn: 1,
				}),
				Story.returned(OutputsSaver.save, undefined),
				Story.saga(RunTurn, turnKey(sessionV1.id, 1), {
					_tag: "Completed",
					result: { status: "completed" },
				}),
				Story.state(sessionV1, { _tag: "Idle", turn: 1 }),
				Story.view(SessionView, sessionV1, {
					id: sessionV1.id,
					type: "session",
					agent_id: agent.id,
					agent_version: 1,
					environment_id: env.id,
					title: "Pinned v1",
					status: "idle",
					turn: 1,
					usage: { input_tokens: 10, output_tokens: 5 },
					created_at: t0,
					updated_at: t0,
					archived_at: null,
				}),
			)
		},
	)
})
