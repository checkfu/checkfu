import * as Domain from "@alchemy.run/domain"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { AgentId } from "../src/Agent/Agent.id.ts"
import { AgentVersionId } from "../src/Agent/AgentVersion.id.ts"
import { ArtifactId } from "../src/Artifact/Artifact.id.ts"
import { ArtifactBytesKept } from "../src/Artifact/ArtifactBytes.external.ts"
import { AutomationId, automationRunId } from "../src/Automation/Automation.id.ts"
import { AUTOMATION_CAPACITY } from "../src/Automation/AutomationCapacity.id.ts"
import { FireAutomation } from "../src/Automation/FireAutomation.command.ts"
import { Automation } from "../src/Automation/Automation.aggregate.ts"
import { MessageText } from "../src/Session/SessionTypes.ts"
import { Checkfu, CheckfuDomainApi, CheckfuHandlersLive } from "../src/Checkfu.model.ts"
import { EnvironmentId } from "../src/Environment/Environment.id.ts"
import { ListingStore } from "../src/Listing/ListingStore.ts"
import { MemoryStoreId } from "../src/Memory/MemoryStore.id.ts"
import { BoundedAgentId, BoundedEnvironmentId } from "../src/Session/AdmitSession.command.ts"
import { Harness } from "../src/Session/Harness.external.ts"
import { SessionId } from "../src/Session/Session.id.ts"
import { SessionOutputsUnpublished } from "../src/Session/SessionOutputs.external.ts"
import { CredentialSecrets } from "../src/Vault/CredentialSecrets.external.ts"
import { CredentialId } from "../src/Vault/Credential.id.ts"
import { VaultId } from "../src/Vault/Vault.id.ts"
import { Vaults, VaultsApi, VaultsHandlersLive } from "../src/Vaults.model.ts"
import { WebhookEvents } from "../src/Webhook/WebhookEvents.external.ts"
import type { WebhookEventPublication } from "../src/Webhook/WebhookEvents.external.ts"

const HarnessStubLayer = Harness.toLayer(
	Effect.succeed({
		interrupt: () => Effect.void,
		storeRepositoryToken: () => Effect.void,
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
				const automationId = AutomationId.make("auto_pub_1")
				const automations = yield* Automation

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
					mcp_server_credentials: "[]",
					resources: [],
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
				yield* domain.AdmitAutomation({
					automation_id: automationId,
					capacity_id: AUTOMATION_CAPACITY,
					name: "Daily report",
					description: null,
					agent_id: BoundedAgentId.make(agentId),
					agent_version: 1,
					environment_id: BoundedEnvironmentId.make(envId),
					text: MessageText.make("Write a report."),
					schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
				})
				yield* domain.RunAutomation({ automation_id: automationId })
				yield* automations.send(
					new FireAutomation({
						automation_id: automationId,
						activation: 0,
						scheduled_at: 1,
					}),
				)

				const memory_store_id = MemoryStoreId.make("memst_webhooks")
				yield* domain.CreateMemoryStore({
					memory_store_id,
					name: "Reports",
					description: "Stores report context.",
				})
				yield* domain.ArchiveMemoryStore({ memory_store_id })
				yield* domain.ArchiveMemoryStore({ memory_store_id })
				yield* domain.DeleteMemoryStore({ memory_store_id })

				// Allow asynchronous in-memory policy delivery to settle.
				for (let i = 0; i < 10; i++) {
					yield* Effect.yieldNow
				}

				const notifications = JSON.stringify(published)
				expect(notifications).not.toContain("TOP_SECRET_SYSTEM_PROMPT_SHOULD_NOT_BE_SENT")
				expect(notifications).not.toContain("pub_secret_token_never_leak")
				const byType = new Map(published.map((event) => [event.event_type, event]))
				expect(byType.has("agent.created")).toBe(true)
				expect(byType.has("environment.created")).toBe(true)
				expect([...byType.keys()]).not.toContain("session.created")
				expect(byType.has("artifact.created")).toBe(true)
				expect(byType.has("artifact.published")).toBe(true)

				expect(
					published.flatMap(({ event_type, resource_id, resource_type }) =>
						resource_type === "memory_store" ? [{ event_type, resource_id }] : [],
					),
				).toEqual([
					{ event_type: "memory_store.created", resource_id: memory_store_id },
					{ event_type: "memory_store.archived", resource_id: memory_store_id },
					{ event_type: "memory_store.deleted", resource_id: memory_store_id },
				])

				const runEvents = published.filter((event) =>
					event.event_type.startsWith("automation_run."),
				)
				expect(runEvents.map((event) => event.event_type).sort()).toEqual([
					"automation_run.started",
					"automation_run.succeeded",
				])
				expect(
					runEvents.every((event) => event.resource_id === automationRunId(automationId, 2)),
				).toBe(true)
				expect(new Set(runEvents.map((event) => event.event_id)).size).toBe(2)

				const agentEvent = byType.get("agent.created")
				expect(agentEvent?.event_id).toMatch(/^evt_agent_agent_pub_1_\d+$/)
				expect(agentEvent?.resource_id).toBe(agentId)

				const artifactPub = byType.get("artifact.published")
				expect(artifactPub?.event_id).toMatch(/^evt_artifact_art_pub_1_\d+$/)
				expect(artifactPub?.resource_id).toBe(artifactId)
			}).pipe(Effect.scoped, Effect.provide(layer))
		},
	)

	it.effect(
		"forwards vault and credential lifecycle events including archive/delete cascades without exposing secrets",
		() => {
			const published: Array<WebhookEventPublication> = []
			const eventsLayer = Layer.succeed(WebhookEvents, {
				publish: (event) =>
					Effect.sync(() => {
						published.push(event)
					}),
			})
			const secretsStub = CredentialSecrets.toLayer(
				Effect.succeed({
					put: () => Effect.succeed({ refused: null }),
					erase: () => Effect.void,
					seal: () => Effect.void,
				}),
			)
			const layer = Vaults.layer(
				VaultsHandlersLive.pipe(Layer.provide([ListingStore.memory, eventsLayer, secretsStub])),
			).pipe(Layer.provide(Domain.InMemory))

			return Effect.gen(function* () {
				const domain = yield* VaultsApi.clientInProcess
				const vaultId = VaultId.make("vlt_pub_1")
				const credA = CredentialId.make("vcrd_pub_1")
				const credB = CredentialId.make("vcrd_pub_2")

				yield* domain.CreateVault({
					vault_id: vaultId,
					display_name: "Prod Vault",
				})
				yield* domain.UpdateVault({
					vault_id: vaultId,
					changes: { display_name: "Renamed Vault" },
				})
				yield* domain.CreateCredential({
					vault_id: vaultId,
					credential_id: credA,
					auth: { type: "static_bearer", mcp_server_url: "https://mcp.example.com/a" },
					display_name: "Cred A",
				})
				yield* domain.CreateCredential({
					vault_id: vaultId,
					credential_id: credB,
					auth: { type: "static_bearer", mcp_server_url: "https://mcp.example.com/b" },
					display_name: "Cred B",
				})
				yield* domain.UpdateCredential({
					vault_id: vaultId,
					credential_id: credA,
					changes: { display_name: "Cred A Renamed" },
				})
				// Direct credential archive + delete on credA, then vault archive + delete cascading credB.
				yield* domain.ArchiveCredential({
					vault_id: vaultId,
					credential_id: credA,
					mcp_server_url: "https://mcp.example.com/a",
				})
				yield* domain.DeleteCredential({
					vault_id: vaultId,
					credential_id: credA,
					mcp_server_url: "https://mcp.example.com/a",
				})
				yield* domain.ArchiveVault({ vault_id: vaultId })
				// Allow ArchiveVault cascade (RetireReleasedCredentials -> CredentialArchived) to settle before DeleteVault.
				for (let i = 0; i < 200; i++) {
					if (
						published.some(
							(e) => e.event_type === "vault_credential.archived" && e.resource_id === credB,
						)
					) {
						break
					}
					yield* Effect.yieldNow
				}
				yield* domain.DeleteVault({ vault_id: vaultId })

				// Wait for async policies (including RetireReleasedCredentials -> PublishVaultWebhookEvents).
				for (let i = 0; i < 200; i++) {
					if (
						published.some((e) => e.event_type === "vault.deleted" && e.resource_id === vaultId) &&
						published.some(
							(e) => e.event_type === "vault_credential.deleted" && e.resource_id === credB,
						)
					) {
						break
					}
					yield* Effect.yieldNow
				}

				const summary = published.map((e) => ({
					event_type: e.event_type,
					resource_type: e.resource_type,
					resource_id: e.resource_id,
					vault_id: e.vault_id,
				}))
				expect(summary).toEqual(
					expect.arrayContaining([
						{
							event_type: "vault.created",
							resource_type: "vault",
							resource_id: vaultId,
							vault_id: undefined,
						},
						{
							event_type: "vault_credential.created",
							resource_type: "vault_credential",
							resource_id: credA,
							vault_id: vaultId,
						},
						{
							event_type: "vault_credential.created",
							resource_type: "vault_credential",
							resource_id: credB,
							vault_id: vaultId,
						},
						{
							event_type: "vault_credential.archived",
							resource_type: "vault_credential",
							resource_id: credA,
							vault_id: vaultId,
						},
						{
							event_type: "vault_credential.deleted",
							resource_type: "vault_credential",
							resource_id: credA,
							vault_id: vaultId,
						},
						{
							event_type: "vault.archived",
							resource_type: "vault",
							resource_id: vaultId,
							vault_id: undefined,
						},
						{
							event_type: "vault_credential.archived",
							resource_type: "vault_credential",
							resource_id: credB,
							vault_id: vaultId,
						},
						{
							event_type: "vault.deleted",
							resource_type: "vault",
							resource_id: vaultId,
							vault_id: undefined,
						},
						{
							event_type: "vault_credential.deleted",
							resource_type: "vault_credential",
							resource_id: credB,
							vault_id: vaultId,
						},
					]),
				)
				// Rename / update does not emit unsupported update events.
				expect(published.some((e) => e.event_type.includes("updated"))).toBe(false)
			}).pipe(Effect.scoped, Effect.provide(layer))
		},
	)
})
