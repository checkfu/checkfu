import * as Domain from "@alchemy.run/domain"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Harness } from "../src/Session/Harness.external.ts"
import { Checkfu, CheckfuDomainApi, CheckfuHandlersLive } from "../src/Checkfu.model.ts"
import { ListingStore } from "../src/Listing/ListingStore.ts"
import type { ListingFilter } from "../src/Listing/ListingStore.ts"
import { BoundedAgentId, BoundedEnvironmentId } from "../src/Session/AdmitSession.command.ts"
import { AgentId } from "../src/Agent/Agent.id.ts"
import { AgentVersionId } from "../src/Agent/AgentVersion.id.ts"
import { ArtifactId } from "../src/Artifact/Artifact.id.ts"
import { EnvironmentId } from "../src/Environment/Environment.id.ts"
import { SessionId } from "../src/Session/Session.id.ts"
import { AutomationId } from "../src/Automation/Automation.id.ts"
import { AUTOMATION_CAPACITY } from "../src/Automation/AutomationCapacity.id.ts"

const ids = (page: { readonly entries: ReadonlyArray<{ readonly id: string }> }) =>
	page.entries.map((entry) => entry.id)

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

const CheckfuInMemory = Checkfu.layer(
	CheckfuHandlersLive.pipe(Layer.provide([HarnessStubLayer, ListingStore.memory])),
).pipe(Layer.provide(Domain.InMemory))

describe("ListResources", () => {
	it.effect("lists what the Listing projection was given for each kind", () =>
		Effect.gen(function* () {
			const domain = yield* CheckfuDomainApi.clientInProcess
			const config = { type: "cloud" as const, networking: { type: "unrestricted" as const } }
			for (const n of [1, 2]) {
				yield* domain.CreateAgent({
					agent_id: AgentId.make(`agent_list_${n}`),
					version_id: AgentVersionId.make(`aver_list_${n}`),
					name: `Agent ${n}`,
					model: { id: "gpt-4o-mini" },
					system: null,
					description: null,
				})
			}
			for (const n of [1, 2, 3]) {
				yield* domain.CreateEnvironment({
					environment_id: EnvironmentId.make(`env_list_${n}`),
					name: `Env ${n}`,
					description: null,
					config,
				})
			}
			const sessions = [
				["sess_list_1", "agent_list_1"],
				["sess_list_2", "agent_list_2"],
				["sess_list_3", "agent_list_1"],
			] as const
			for (const [session, agent] of sessions) {
				yield* domain.AdmitSession({
					session_id: SessionId.make(session),
					agent_id: BoundedAgentId.make(agent),
					agent_version: null,
					environment_id: BoundedEnvironmentId.make("env_list_1"),
					title: null,
					resources: [],
				})
			}
			const automations = [
				["auto_list_1", "agent_list_1"],
				["auto_list_2", "agent_list_2"],
				["auto_list_3", "agent_list_1"],
			] as const
			for (const [automation, agent] of automations) {
				yield* domain.AdmitAutomation({
					automation_id: AutomationId.make(automation),
					capacity_id: AUTOMATION_CAPACITY,
					name: automation,
					description: null,
					agent_id: BoundedAgentId.make(agent),
					agent_version: null,
					environment_id: BoundedEnvironmentId.make("env_list_1"),
					text: "Report.",
					schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
				})
			}
			const archivedAutomation = yield* domain.ArchiveAutomation({
				automation_id: AutomationId.make("auto_list_3"),
			})
			const archivedAgent = yield* domain.ArchiveAgent({ agent_id: AgentId.make("agent_list_2") })
			const archivedEnv = yield* domain.ArchiveEnvironment({
				environment_id: EnvironmentId.make("env_list_2"),
			})
			const deletedEnv = yield* domain.DeleteEnvironment({
				environment_id: EnvironmentId.make("env_list_3"),
			})
			const archivedSession = yield* domain.ArchiveSession({
				session_id: SessionId.make("sess_list_3"),
			})
			for (const n of [1, 2, 3]) {
				yield* domain.CreateArtifact({
					artifact_id: ArtifactId.make(`art_list_${n}`),
					name: `Artifact ${n}`,
					manifest: "m".repeat(64),
					file_count: 1,
					total_bytes: 1,
					fence: 0,
				})
			}
			const deletedArtifact = yield* domain.DeleteArtifact({
				artifact_id: ArtifactId.make("art_list_2"),
				fence: 0,
			})
			const atLeast = [
				archivedAgent,
				archivedEnv,
				deletedEnv,
				archivedSession,
				archivedAutomation,
				deletedArtifact,
			]

			const list = (input: Partial<ListingFilter> & Pick<ListingFilter, "kind">) =>
				domain
					.ListResources(
						{ include_archived: false, agent_id: null, order: "asc", ...input },
						{ atLeast },
					)
					.pipe(Effect.map(ids))

			expect(yield* list({ kind: "agent" })).toEqual(["agent_list_1"])
			expect(yield* list({ kind: "agent", include_archived: true })).toEqual([
				"agent_list_1",
				"agent_list_2",
			])
			expect(yield* list({ kind: "environment", include_archived: true })).toEqual([
				"env_list_1",
				"env_list_2",
			])
			expect(yield* list({ kind: "environment" })).toEqual(["env_list_1"])
			expect(yield* list({ kind: "session" })).toEqual(["sess_list_1", "sess_list_2"])
			expect(yield* list({ kind: "automation" })).toEqual(["auto_list_1", "auto_list_2"])
			expect(
				yield* list({ kind: "automation", include_archived: true, agent_id: "agent_list_1" }),
			).toEqual(["auto_list_1", "auto_list_3"])
			expect(yield* list({ kind: "artifact" })).toEqual(["art_list_1", "art_list_3"])
			expect(yield* list({ kind: "artifact", include_archived: true })).toEqual([
				"art_list_1",
				"art_list_3",
			])
			expect(yield* list({ kind: "artifact", order: "desc" })).toEqual(["art_list_3", "art_list_1"])
			expect(
				yield* list({ kind: "session", include_archived: true, agent_id: "agent_list_1" }),
			).toEqual(["sess_list_1", "sess_list_3"])
			expect(yield* list({ kind: "session", order: "desc", include_archived: true })).toEqual([
				"sess_list_3",
				"sess_list_2",
				"sess_list_1",
			])

			const first = yield* domain.ListResources(
				{ kind: "session", include_archived: true, agent_id: null, order: "asc" },
				{ take: 2 },
			)
			expect(ids(first)).toEqual(["sess_list_1", "sess_list_2"])
			const rest = yield* domain.ListResources(
				{ kind: "session", include_archived: true, agent_id: null, order: "asc" },
				{ take: 2, after: first.cursor ?? "" },
			)
			expect(rest).toMatchObject({ cursor: null })
			expect(ids(rest)).toEqual(["sess_list_3"])

			for (const after of ["bad", "12", "1:a/b", ""]) {
				const refused = yield* Effect.flip(
					domain.ListResources(
						{ kind: "session", include_archived: true, agent_id: null, order: "asc" },
						{ after },
					),
				)
				expect([after, refused._tag]).toEqual([after, "InvalidListingCursor"])
			}
		}).pipe(Effect.scoped, Effect.provide(CheckfuInMemory)),
	)
})
