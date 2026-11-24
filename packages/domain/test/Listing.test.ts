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
import { EnvironmentId } from "../src/Environment/Environment.id.ts"
import { SessionId } from "../src/Session/Session.id.ts"

const ids = (page: { readonly entries: ReadonlyArray<{ readonly id: string }> }) =>
	page.entries.map((entry) => entry.id)

const HarnessStubLayer = Harness.toLayer(
	Effect.succeed({
		interrupt: () => Effect.void,
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
				})
			}
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
			const atLeast = [archivedAgent, archivedEnv, deletedEnv, archivedSession]

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
