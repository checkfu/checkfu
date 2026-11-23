import * as Domain from "@alchemy.run/domain"
import { Story } from "@alchemy.run/domain/Story"
import { Agent } from "@checkfu/agents/Agent/Agent.aggregate"
import { AgentId } from "@checkfu/agents/Agent/Agent.id"
import { AgentArchivedError } from "@checkfu/agents/Agent/AgentArchived.rejection"
import { AgentNotFound } from "@checkfu/agents/Agent/AgentNotFound.rejection"
import { AgentVersion, AgentVersionMinted } from "@checkfu/agents/Agent/AgentVersion.aggregate"
import { AgentVersionId } from "@checkfu/agents/Agent/AgentVersion.id"
import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "@checkfu/agents/Agent/AgentVersionByNumberView.view"
import { AgentView } from "@checkfu/agents/Agent/AgentView.view"
import { AgentArchived, ArchiveAgent } from "@checkfu/agents/Agent/ArchiveAgent.command"
import { AgentCreated, CreateAgent } from "@checkfu/agents/Agent/CreateAgent.command"
import { AgentUpdated, UpdateAgent } from "@checkfu/agents/Agent/UpdateAgent.command"
import {
	ArchiveEnvironment,
	EnvironmentArchived,
} from "@checkfu/environments/Environment/ArchiveEnvironment.command"
import {
	CreateEnvironment,
	EnvironmentCreated,
} from "@checkfu/environments/Environment/CreateEnvironment.command"
import {
	DeleteEnvironment,
	EnvironmentDeleted,
} from "@checkfu/environments/Environment/DeleteEnvironment.command"
import { Environment } from "@checkfu/environments/Environment/Environment.aggregate"
import { EnvironmentId } from "@checkfu/environments/Environment/Environment.id"
import { EnvironmentArchivedError } from "@checkfu/environments/Environment/EnvironmentArchived.rejection"
import { EnvironmentNotFound } from "@checkfu/environments/Environment/EnvironmentNotFound.rejection"
import { EnvironmentView } from "@checkfu/environments/Environment/EnvironmentView.view"
import { SessionStatusIdle } from "@checkfu/sessions/Session/CompleteTurn.command"
import {
	SessionAlreadyExists,
	SessionCreated,
} from "@checkfu/sessions/Session/CreateSession.command"
import { ModelProvider } from "@checkfu/sessions/Session/ModelProvider.external"
import { AgentMessage } from "@checkfu/sessions/Session/RecordAgentMessage.command"
import { SpanModelRequestEnd } from "@checkfu/sessions/Session/RecordModelRequestEnd.command"
import { SpanModelRequestStart } from "@checkfu/sessions/Session/RecordModelRequestStart.command"
import { RunTurn, turnKey } from "@checkfu/sessions/Session/RunTurn.saga"
import {
	SendUserMessage,
	SessionStatusRunning,
	UserMessage,
} from "@checkfu/sessions/Session/SendUserMessage.command"
import { Session } from "@checkfu/sessions/Session/Session.aggregate"
import { SessionId } from "@checkfu/sessions/Session/Session.id"
import { SessionView } from "@checkfu/sessions/Session/SessionView.view"
import { TurnInput } from "@checkfu/sessions/Session/TurnInput.view"
import { SessionsHandlersLive } from "@checkfu/sessions/Sessions.model"
import { describe, expect, it } from "@effect/vitest"
import * as Arbitrary from "effect/Arbitrary"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
	AdmitSession,
	AgentVersionNotFound,
	BatchFingerprint,
	BoundedAgentId,
	BoundedEnvironmentId,
	Checkfu,
	ClaimEventBatch,
	EventBatch,
	EventBatchClaimed,
	EventBatchId,
	IdempotencyKeyConflict,
} from "../src/Checkfu.model.ts"

const story = Story.make(Checkfu, {
	layer: SessionsHandlersLive,
	stub: [ModelProvider],
})

const ModelProviderStubLayer = ModelProvider.toLayer(
	Effect.succeed({
		interrupt: () => Effect.void,
		generate: () =>
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
			Layer.build(Checkfu.layer(SessionsHandlersLive.pipe(Layer.provide(ModelProviderStubLayer)))),
		).pipe(Effect.provide(Domain.InMemory)),
	)

	it.effect(
		"enforces cross-domain admission eligibility, version pinning, idempotency, and turn execution on the real Checkfu model",
		() => {
			const agent = Agent.ref(AgentId.make("agent_verify_1"))
			const boundedAgentId = BoundedAgentId.make(agent.id)
			const v1 = AgentVersion.ref(AgentVersionId.make("aver_verify_1"))
			const v2 = AgentVersion.ref(AgentVersionId.make("aver_verify_2"))
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
			const batch = EventBatch.ref(EventBatchId.make("batch_verify_1"))
			const reqId = `${sessionV1.id}:turn:1:req:1`
			const envConfig = { type: "cloud" as const, networking: { type: "unrestricted" as const } }

			return story(
				Story.clock(t0),

				// EventBatch idempotency: initial claim, identical retry no-op, conflicting fingerprint 409.
				Story.when(new ClaimEventBatch({ batch_id: batch.id, fingerprint: "fp_alpha" })),
				Story.then(batch, new EventBatchClaimed({ fingerprint: "fp_alpha" })),
				Story.when(new ClaimEventBatch({ batch_id: batch.id, fingerprint: "fp_alpha" })),
				Story.then(batch),
				Story.when(new ClaimEventBatch({ batch_id: batch.id, fingerprint: "fp_beta" })),
				Story.rejected(new IdempotencyKeyConflict({ batch_id: batch.id })),

				// Reject admission before Agent exists.
				Story.when(
					new AdmitSession({
						session_id: sessionRejected.id,
						agent_id: missingAgentId,
						agent_version: null,
						environment_id: missingEnvId,
						title: null,
					}),
				),
				Story.rejected(new AgentNotFound({ agent_id: AgentId.make(missingAgentId) })),

				// Create Agent v1, update to v2, and create two Environments.
				Story.when(
					new CreateAgent({
						agent_id: agent.id,
						version_id: v1.id,
						name: "Verified Agent",
						model: { id: "gpt-4o-mini" },
						system: "Be concise.",
						description: null,
					}),
				),
				Story.then(
					agent,
					new AgentCreated({
						version: 1,
						version_id: v1.id,
						name: "Verified Agent",
						model: { id: "gpt-4o-mini" },
						system: "Be concise.",
						description: null,
					}),
				),
				Story.then(
					v1,
					new AgentVersionMinted({
						agent_id: agent.id,
						version: 1,
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
						next_version_id: v2.id,
						name: "Verified Agent v2",
						model: { id: "gpt-4o-mini" },
						system: "Be extra concise.",
						description: null,
					}),
				),
				Story.then(
					agent,
					new AgentUpdated({
						version: 2,
						version_id: v2.id,
						name: "Verified Agent v2",
						model: { id: "gpt-4o-mini" },
						system: "Be extra concise.",
						description: null,
					}),
				),
				Story.then(
					v2,
					new AgentVersionMinted({
						agent_id: agent.id,
						version: 2,
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

				// Reject nonexistent future version and missing, deleted, or archived environments.
				Story.when(
					new AdmitSession({
						session_id: sessionRejected.id,
						agent_id: boundedAgentId,
						agent_version: 3,
						environment_id: boundedEnvId,
						title: null,
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
					}),
				),
				Story.rejected(new EnvironmentArchivedError({ environment_id: archivedEnv.id })),

				// Admit session pinned to v1, and a second session defaulting to head v2.
				Story.when(
					new AdmitSession({
						session_id: sessionV1.id,
						agent_id: boundedAgentId,
						agent_version: 1,
						environment_id: boundedEnvId,
						title: "Pinned v1",
					}),
				),
				Story.then(
					sessionV1,
					new SessionCreated({
						agent_id: agent.id,
						agent_version: 1,
						environment_id: env.id,
						title: "Pinned v1",
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
					}),
				),
				Story.then(
					sessionLatest,
					new SessionCreated({
						agent_id: agent.id,
						agent_version: 2,
						environment_id: env.id,
						title: null,
					}),
				),
				Story.replied({ agent_version: 2 }),

				// Verify hosted cross-domain views for both pinned v1 and head v2 admissions.
				Story.view(AgentVersionByNumberView, agentVersionLookupKey(agent.id, 1), {
					id: v1.id,
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
					id: v2.id,
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
				Story.view(SessionView, sessionLatest, {
					id: sessionLatest.id,
					type: "session",
					agent_id: agent.id,
					agent_version: 2,
					environment_id: env.id,
					title: null,
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
					turn: 0,
					harness_generation: 0,
					input: [],
					unsent: [],
				}),

				// Archiving the Agent blocks new admissions...
				Story.when(new ArchiveAgent({ agent_id: agent.id })),
				Story.then(agent, new AgentArchived()),
				Story.view(AgentView, agent, {
					id: agent.id,
					type: "agent",
					version: 2,
					current_version_id: v2.id,
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
					}),
				),
				Story.rejected(new AgentArchivedError({ agent_id: agent.id })),

				// ...while the already-admitted v1 session completes a full turn against its active
				// environment via StartTurn + RunTurn.
				Story.when(new SendUserMessage({ session_id: sessionV1.id, text: "Hello Checkfu" })),
				Story.then(
					sessionV1,
					new UserMessage({ content: [{ type: "text", text: "Hello Checkfu" }] }),
					new SessionStatusRunning(),
				),
				Story.then(sessionV1, new SpanModelRequestStart({ model_request_start_id: reqId })),
				Story.call(ModelProvider.generate, {
					session_id: sessionV1.id,
					agent_id: agent.id,
					agent_version: 1,
					environment_id: env.id,
					turn: 1,
				}),
				Story.succeed(ModelProvider.generate, {
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
					new SessionStatusIdle({ stop_reason: { type: "end_turn" } }),
				),
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

	it("allows zero-event retries only for matching fingerprints and rejects every distinct fingerprint pair with IdempotencyKeyConflict", async () => {
		const distinctCount = await Effect.runPromise(
			Effect.gen(function* () {
				const fingerprintArb = Arbitrary.schema(BatchFingerprint)
				const left = yield* Arbitrary.sampleEffect(fingerprintArb, {
					count: 50,
					seed: "event-batch-fp-left",
				})
				const right = yield* Arbitrary.sampleEffect(fingerprintArb, {
					count: 50,
					seed: "event-batch-fp-right",
				})
				const pairs: ReadonlyArray<readonly [string, string]> = [
					["a", "b"],
					["a", "a "],
					["fp_prefix", "fp_prefix_extra"],
					["x".repeat(128), `${"x".repeat(127)}y`],
					...left.map((fp1, index): readonly [string, string] => [fp1, right[index]!]),
				]
				let count = 0
				for (let index = 0; index < pairs.length; index++) {
					const [fp1, fp2] = pairs[index]!
					const batch = EventBatch.ref(EventBatchId.make(`batch_prop_${index}`))
					if (fp1 === fp2) {
						yield* story(
							Story.when(new ClaimEventBatch({ batch_id: batch.id, fingerprint: fp1 })),
							Story.then(batch, new EventBatchClaimed({ fingerprint: fp1 })),
							Story.state(batch, { _tag: "Claimed", fingerprint: fp1 }),
							Story.when(new ClaimEventBatch({ batch_id: batch.id, fingerprint: fp2 })),
							Story.then(batch),
							Story.state(batch, { _tag: "Claimed", fingerprint: fp1 }),
						)
						continue
					}
					count += 1
					yield* story(
						Story.when(new ClaimEventBatch({ batch_id: batch.id, fingerprint: fp1 })),
						Story.then(batch, new EventBatchClaimed({ fingerprint: fp1 })),
						Story.state(batch, { _tag: "Claimed", fingerprint: fp1 }),
						Story.when(new ClaimEventBatch({ batch_id: batch.id, fingerprint: fp1 })),
						Story.then(batch),
						Story.state(batch, { _tag: "Claimed", fingerprint: fp1 }),
						Story.when(new ClaimEventBatch({ batch_id: batch.id, fingerprint: fp2 })),
						Story.rejected(new IdempotencyKeyConflict({ batch_id: batch.id })),
						Story.state(batch, { _tag: "Claimed", fingerprint: fp1 }),
						Story.when(new ClaimEventBatch({ batch_id: batch.id, fingerprint: fp1 })),
						Story.then(batch),
						Story.state(batch, { _tag: "Claimed", fingerprint: fp1 }),
					)
				}
				return count
			}),
		)
		expect(distinctCount).toBeGreaterThanOrEqual(40)
	})
})
