import * as Domain from "@alchemy.run/domain"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { AgentId } from "../src/Agent/Agent.id.ts"
import { AgentVersionId } from "../src/Agent/AgentVersion.id.ts"
import { ArtifactId } from "../src/Artifact/Artifact.id.ts"
import { ArtifactBytesKept } from "../src/Artifact/ArtifactBytes.external.ts"
import { Checkfu, CheckfuDomainApi, CheckfuHandlersLive } from "../src/Checkfu.model.ts"
import { EnvironmentId } from "../src/Environment/Environment.id.ts"
import { ListingStore } from "../src/Listing/ListingStore.ts"
import { BoundedAgentId, BoundedEnvironmentId } from "../src/Session/AdmitSession.command.ts"
import { Harness } from "../src/Session/Harness.external.ts"
import { SessionId } from "../src/Session/Session.id.ts"
import { SessionOutputsUnpublished } from "../src/Session/SessionOutputs.external.ts"
import { WebhookEvents } from "../src/Webhook/WebhookEvents.external.ts"
import type { WebhookEventPublication } from "../src/Webhook/WebhookEvents.external.ts"

const HarnessStubLayer = Harness.toLayer(
	Effect.succeed({
		interrupt: () => Effect.void,
		discardWorkspace: () => Effect.void,
		runTurn: () =>
			Effect.succeed({
				thinking: null,
				text: "done",
				input_tokens: 5,
				output_tokens: 3,
				stop_reason: { type: "end_turn" as const },
			}),
	}),
)

describe("PublishWebhookEvents policy", () => {
	it.effect(
		"forwards committed lifecycle events with deterministic ids and omits artifact publish tokens and agent system prompts",
		() => {
			const published: Array<WebhookEventPublication> = []
			const eventsLayer = Layer.succeed(WebhookEvents, {
				publish: (event) =>
					Effect.sync(() => {
						published.push(event)
					}),
			})
			const layer = Checkfu.layer(
				CheckfuHandlersLive.pipe(
					Layer.provide([ArtifactBytesKept, SessionOutputsUnpublished, eventsLayer]),
					Layer.provide([HarnessStubLayer, ListingStore.memory]),
				),
			).pipe(Layer.provide(Domain.InMemory))

			return Effect.gen(function* () {
				const domain = yield* CheckfuDomainApi.clientInProcess
				const agentId = AgentId.make("agent_pub_1")
				const envId = EnvironmentId.make("env_pub_1")
				const sessionId = SessionId.make("sess_pub_1")
				const artifactId = ArtifactId.make("art_pub_1")

				yield* domain.CreateAgent({
					agent_id: agentId,
					version_id: AgentVersionId.make("aver_pub_1"),
					name: "Publisher Agent",
					model: { id: "gpt-4o-mini" },
					system: "TOP_SECRET_SYSTEM_PROMPT_SHOULD_NOT_BE_SENT",
					description: "desc",
				})
				yield* domain.CreateEnvironment({
					environment_id: envId,
					name: "Publisher Env",
					description: null,
					config: { type: "cloud", networking: { type: "unrestricted" } },
				})
				yield* domain.AdmitSession({
					session_id: sessionId,
					agent_id: BoundedAgentId.make(agentId),
					agent_version: 1,
					environment_id: BoundedEnvironmentId.make(envId),
					title: "Session 1",
				})
				yield* domain.ReserveArtifact({ artifact_id: artifactId })
				yield* domain.CreateArtifact({
					artifact_id: artifactId,
					name: "Report",
					manifest: "a".repeat(64),
					file_count: 1,
					total_bytes: 12,
					reservation: 1,
				})
				yield* domain.PublishArtifact({
					artifact_id: artifactId,
					pinned_version: 1,
					token: "pub_secret_token_never_leak",
				})
				// Allow asynchronous in-memory policy delivery to settle.
				for (let i = 0; i < 10; i++) {
					yield* Effect.yieldNow
				}

				const byType = new Map(published.map((event) => [event.event_type, event]))
				expect(byType.has("agent.created")).toBe(true)
				expect(byType.has("environment.created")).toBe(true)
				expect(byType.has("session.created")).toBe(true)
				expect(byType.has("artifact.created")).toBe(true)
				expect(byType.has("artifact.published")).toBe(true)

				const agentEvent = byType.get("agent.created")
				expect(agentEvent?.event_id).toMatch(/^evt_agent_agent_pub_1_\d+$/)
				expect(agentEvent?.data_json).not.toContain("TOP_SECRET_SYSTEM_PROMPT_SHOULD_NOT_BE_SENT")

				const artifactPub = byType.get("artifact.published")
				expect(artifactPub?.event_id).toMatch(/^evt_artifact_art_pub_1_\d+$/)
				expect(artifactPub?.data_json).not.toContain("pub_secret_token_never_leak")
				expect(JSON.parse(artifactPub?.data_json ?? "{}")).toEqual({
					artifact_id: artifactId,
					pinned_version: 1,
				})
			}).pipe(Effect.scoped, Effect.provide(layer))
		},
	)
})
