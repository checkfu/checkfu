import * as Domain from "@alchemy.run/domain"
import { Story } from "@alchemy.run/domain/Story"
import { describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Agent } from "../src/Agent/Agent.aggregate.ts"
import { AgentArchivedError } from "../src/Agent/AgentArchived.rejection.ts"
import { AgentNotFound } from "../src/Agent/AgentNotFound.rejection.ts"
import { AgentVersion, AgentVersionMinted } from "../src/Agent/AgentVersion.aggregate.ts"
import { AgentVersionAlreadyExists } from "../src/Agent/AgentVersionAlreadyExists.rejection.ts"
import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "../src/Agent/AgentVersionByNumberView.view.ts"
import { AgentVersionView } from "../src/Agent/AgentVersionView.view.ts"
import { AgentView } from "../src/Agent/AgentView.view.ts"
import { AgentArchived, ArchiveAgent } from "../src/Agent/ArchiveAgent.command.ts"
import { AgentAlreadyExists, AgentCreated, CreateAgent } from "../src/Agent/CreateAgent.command.ts"
import {
	AgentUpdated,
	AgentVersionConflict,
	UpdateAgent,
} from "../src/Agent/UpdateAgent.command.ts"
import { Agents } from "../src/Agents.model.ts"

const story = Story.make(Agents)

const t0 = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")
const t1 = DateTime.makeUnsafe("2026-01-01T00:05:00.000Z")
const t2 = DateTime.makeUnsafe("2026-01-01T00:10:00.000Z")

describe("Agents", () => {
	it.effect("is well defined", () =>
		Effect.scoped(Layer.build(Agents.layer(Layer.empty))).pipe(Effect.provide(Domain.InMemory)),
	)

	it.effect(
		"creates an agent, mints version 1, and projects AgentView and AgentVersionView",
		() => {
			const agent = Agent.ref("agent_001")
			const v1 = AgentVersion.ref("aver_001_1")
			return story(
				Story.clock(t0),
				Story.when(
					new CreateAgent({
						agent_id: agent.id,
						version_id: v1.id,
						name: "Coding Assistant",
						model: { id: "gpt-5.4" },
						system: "You are helpful.",
						description: "General coding agent",
					}),
				),
				Story.then(
					agent,
					new AgentCreated({
						version: 1,
						version_id: v1.id,
						name: "Coding Assistant",
						model: { id: "gpt-5.4" },
						system: "You are helpful.",
						description: "General coding agent",
					}),
				),
				Story.then(
					v1,
					new AgentVersionMinted({
						agent_id: agent.id,
						version: 1,
						name: "Coding Assistant",
						model: { id: "gpt-5.4" },
						system: "You are helpful.",
						description: "General coding agent",
					}),
				),
				Story.replied({ version: 1, version_id: v1.id }),
				Story.state(agent, {
					status: "active",
					version: 1,
					current_version_id: v1.id,
					name: "Coding Assistant",
					model_id: "gpt-5.4",
					has_system: true,
					system: "You are helpful.",
					has_description: true,
					description: "General coding agent",
				}),
				Story.state(v1, {
					minted: true,
					agent_id: agent.id,
					version: 1,
					name: "Coding Assistant",
					model_id: "gpt-5.4",
					has_system: true,
					system: "You are helpful.",
					has_description: true,
					description: "General coding agent",
				}),
				Story.view(AgentView, agent, {
					id: agent.id,
					type: "agent",
					version: 1,
					current_version_id: v1.id,
					name: "Coding Assistant",
					model: { id: "gpt-5.4" },
					system: "You are helpful.",
					description: "General coding agent",
					created_at: t0,
					updated_at: t0,
					archived_at: null,
				}),
				Story.view(AgentVersionByNumberView, agentVersionLookupKey(agent.id, 1), {
					id: v1.id,
					agent_id: agent.id,
					type: "agent",
					version: 1,
					name: "Coding Assistant",
					model: { id: "gpt-5.4" },
					system: "You are helpful.",
					description: "General coding agent",
					created_at: t0,
				}),
				Story.view(AgentVersionView, v1, {
					id: v1.id,
					agent_id: agent.id,
					type: "agent",
					version: 1,
					name: "Coding Assistant",
					model: { id: "gpt-5.4" },
					system: "You are helpful.",
					description: "General coding agent",
					created_at: t0,
				}),
			)
		},
	)

	it.effect("bumps version on changes and no-ops when config is unchanged", () => {
		const agent = Agent.ref("agent_002")
		const v1 = AgentVersion.ref("aver_002_1")
		const v2Unused = AgentVersion.ref("aver_002_unused")
		const v2 = AgentVersion.ref("aver_002_2")
		return story(
			Story.clock(t0),
			Story.when(
				new CreateAgent({
					agent_id: agent.id,
					version_id: v1.id,
					name: "Reviewer",
					model: { id: "gpt-5.4" },
					system: null,
					description: null,
				}),
			),
			Story.then(
				agent,
				new AgentCreated({
					version: 1,
					version_id: v1.id,
					name: "Reviewer",
					model: { id: "gpt-5.4" },
					system: null,
					description: null,
				}),
			),
			Story.then(
				v1,
				new AgentVersionMinted({
					agent_id: agent.id,
					version: 1,
					name: "Reviewer",
					model: { id: "gpt-5.4" },
					system: null,
					description: null,
				}),
			),
			Story.replied({ version: 1, version_id: v1.id }),
			Story.clock(t1),
			Story.when(
				new UpdateAgent({
					agent_id: agent.id,
					expected_version: 1,
					next_version_id: v2Unused.id,
					changes: {
						name: "Reviewer",
						model: { id: "gpt-5.4" },
						system: null,
						description: null,
					},
				}),
			),
			Story.then(agent),
			Story.then(v2Unused),
			Story.replied({ version: 1, version_id: v1.id }),
			Story.state(v2Unused, {
				minted: false,
				agent_id: "",
				version: 0,
				name: "",
				model_id: "",
				has_system: false,
				system: "",
				has_description: false,
				description: "",
			}),
			Story.when(
				new UpdateAgent({
					agent_id: agent.id,
					expected_version: 1,
					next_version_id: v2.id,
					changes: {
						name: "Reviewer",
						model: { id: "gpt-5.4" },
						system: "Review every pull request carefully.",
						description: "Code reviewer",
					},
				}),
			),
			Story.then(
				agent,
				new AgentUpdated({
					version: 2,
					version_id: v2.id,
					name: "Reviewer",
					model: { id: "gpt-5.4" },
					system: "Review every pull request carefully.",
					description: "Code reviewer",
				}),
			),
			Story.then(
				v2,
				new AgentVersionMinted({
					agent_id: agent.id,
					version: 2,
					name: "Reviewer",
					model: { id: "gpt-5.4" },
					system: "Review every pull request carefully.",
					description: "Code reviewer",
				}),
			),
			Story.replied({ version: 2, version_id: v2.id }),
			Story.view(AgentView, agent, {
				id: agent.id,
				type: "agent",
				version: 2,
				current_version_id: v2.id,
				name: "Reviewer",
				model: { id: "gpt-5.4" },
				system: "Review every pull request carefully.",
				description: "Code reviewer",
				created_at: t0,
				updated_at: t1,
				archived_at: null,
			}),
			Story.view(AgentVersionByNumberView, agentVersionLookupKey(agent.id, 1), {
				id: v1.id,
				agent_id: agent.id,
				type: "agent",
				version: 1,
				name: "Reviewer",
				model: { id: "gpt-5.4" },
				system: null,
				description: null,
				created_at: t0,
			}),
			Story.view(AgentVersionByNumberView, agentVersionLookupKey(agent.id, 2), {
				id: v2.id,
				agent_id: agent.id,
				type: "agent",
				version: 2,
				name: "Reviewer",
				model: { id: "gpt-5.4" },
				system: "Review every pull request carefully.",
				description: "Code reviewer",
				created_at: t1,
			}),
			Story.view(AgentVersionView, v1, {
				id: v1.id,
				agent_id: agent.id,
				type: "agent",
				version: 1,
				name: "Reviewer",
				model: { id: "gpt-5.4" },
				system: null,
				description: null,
				created_at: t0,
			}),
			Story.view(AgentVersionView, v2, {
				id: v2.id,
				agent_id: agent.id,
				type: "agent",
				version: 2,
				name: "Reviewer",
				model: { id: "gpt-5.4" },
				system: "Review every pull request carefully.",
				description: "Code reviewer",
				created_at: t1,
			}),
		)
	})

	it.effect("enforces optimistic concurrency, duplicate ids, and archiving immutability", () => {
		const missing = Agent.ref("agent_missing")
		const agent = Agent.ref("agent_003")
		const other = Agent.ref("agent_004")
		const v1 = AgentVersion.ref("aver_003_1")
		const v2 = AgentVersion.ref("aver_003_2")
		return story(
			Story.clock(t0),
			Story.when(
				new UpdateAgent({
					agent_id: missing.id,
					expected_version: 1,
					next_version_id: v2.id,
					changes: {
						name: "Missing",
						model: { id: "gpt-5.4" },
						system: null,
						description: null,
					},
				}),
			),
			Story.rejected(new AgentNotFound({ agent_id: missing.id })),
			Story.when(new ArchiveAgent({ agent_id: missing.id })),
			Story.rejected(new AgentNotFound({ agent_id: missing.id })),
			Story.when(
				new CreateAgent({
					agent_id: agent.id,
					version_id: v1.id,
					name: "Worker",
					model: { id: "gpt-5.4" },
					system: "Run tasks.",
					description: null,
				}),
			),
			Story.then(
				agent,
				new AgentCreated({
					version: 1,
					version_id: v1.id,
					name: "Worker",
					model: { id: "gpt-5.4" },
					system: "Run tasks.",
					description: null,
				}),
			),
			Story.then(
				v1,
				new AgentVersionMinted({
					agent_id: agent.id,
					version: 1,
					name: "Worker",
					model: { id: "gpt-5.4" },
					system: "Run tasks.",
					description: null,
				}),
			),
			Story.replied({ version: 1, version_id: v1.id }),
			Story.when(
				new CreateAgent({
					agent_id: agent.id,
					version_id: v2.id,
					name: "Duplicate",
					model: { id: "gpt-5.4" },
					system: null,
					description: null,
				}),
			),
			Story.rejected(new AgentAlreadyExists({ agent_id: agent.id })),
			Story.when(
				new CreateAgent({
					agent_id: other.id,
					version_id: v1.id,
					name: "Collision",
					model: { id: "gpt-5.4" },
					system: null,
					description: null,
				}),
			),
			Story.rejected(new AgentVersionAlreadyExists({ version_id: v1.id })),
			Story.when(
				new UpdateAgent({
					agent_id: agent.id,
					expected_version: 2,
					next_version_id: v2.id,
					changes: {
						name: "Stale",
						model: { id: "gpt-5.4" },
						system: null,
						description: null,
					},
				}),
			),
			Story.rejected(
				new AgentVersionConflict({
					agent_id: agent.id,
					expected_version: 2,
					current_version: 1,
				}),
			),
			Story.when(
				new UpdateAgent({
					agent_id: agent.id,
					expected_version: 1,
					next_version_id: v1.id,
					changes: {
						name: "Changed",
						model: { id: "gpt-5.4" },
						system: null,
						description: null,
					},
				}),
			),
			Story.rejected(new AgentVersionAlreadyExists({ version_id: v1.id })),
			Story.clock(t2),
			Story.when(new ArchiveAgent({ agent_id: agent.id })),
			Story.then(agent, new AgentArchived()),
			Story.state(agent, {
				status: "archived",
				version: 1,
				current_version_id: v1.id,
				name: "Worker",
				model_id: "gpt-5.4",
				has_system: true,
				system: "Run tasks.",
				has_description: false,
				description: "",
			}),
			Story.when(new ArchiveAgent({ agent_id: agent.id })),
			Story.then(agent),
			Story.when(
				new UpdateAgent({
					agent_id: agent.id,
					expected_version: 1,
					next_version_id: v2.id,
					changes: {
						name: "After Archive",
						model: { id: "gpt-5.4" },
						system: null,
						description: null,
					},
				}),
			),
			Story.rejected(new AgentArchivedError({ agent_id: agent.id })),
			Story.view(AgentView, agent, {
				id: agent.id,
				type: "agent",
				version: 1,
				current_version_id: v1.id,
				name: "Worker",
				model: { id: "gpt-5.4" },
				system: "Run tasks.",
				description: null,
				created_at: t0,
				updated_at: t2,
				archived_at: t2,
			}),
		)
	})

	it.effect("updates only the fields a command names and keeps the rest", () => {
		const agent = Agent.ref("agent_partial")
		const v = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => AgentVersion.ref(`aver_partial_${n}`))
		const configs = [
			{ name: "Planner", model: { id: "gpt-5.4" }, system: "Plan.", description: "Plans work" },
			{ name: "Planner II", model: { id: "gpt-5.4" }, system: "Plan.", description: "Plans work" },
			{ name: "Planner II", model: { id: "gpt-5.5" }, system: "Plan.", description: "Plans work" },
			{
				name: "Planner II",
				model: { id: "gpt-5.5" },
				system: "Plan well.",
				description: "Plans work",
			},
			{
				name: "Planner II",
				model: { id: "gpt-5.5" },
				system: "Plan well.",
				description: "Plans all",
			},
			{ name: "Planner II", model: { id: "gpt-5.5" }, system: null, description: "Plans all" },
			{ name: "Planner II", model: { id: "gpt-5.5" }, system: null, description: null },
			{ name: "Planner III", model: { id: "gpt-5.5" }, system: "", description: null },
			{ name: "Planner III", model: { id: "gpt-5.5" }, system: null, description: "" },
		] as const
		const changes = [
			{ name: "Planner II" },
			{ model: { id: "gpt-5.5" } },
			{ system: "Plan well." },
			{ description: "Plans all" },
			{ system: null },
			{ description: null },
			{ name: "Planner III", system: "" },
			{ system: null, description: "" },
		] as const
		const update = (n: number) =>
			new UpdateAgent({
				agent_id: agent.id,
				expected_version: n,
				next_version_id: v[n]!.id,
				changes: changes[n - 1]!,
			})
		const updated = (n: number) =>
			new AgentUpdated({ version: n + 1, version_id: v[n]!.id, ...configs[n]! })
		const minted = (n: number) =>
			new AgentVersionMinted({ agent_id: agent.id, version: n + 1, ...configs[n]! })
		return story(
			Story.clock(t0),
			Story.given(agent, new AgentCreated({ version: 1, version_id: v[0]!.id, ...configs[0] })),
			Story.given(v[0]!, new AgentVersionMinted({ agent_id: agent.id, version: 1, ...configs[0] })),
			Story.clock(t1),
			Story.when(update(1)),
			Story.then(agent, updated(1)),
			Story.then(v[1]!, minted(1)),
			Story.replied({ version: 2, version_id: v[1]!.id }),
			Story.when(update(2)),
			Story.then(agent, updated(2)),
			Story.then(v[2]!, minted(2)),
			Story.replied({ version: 3, version_id: v[2]!.id }),
			Story.when(update(3)),
			Story.then(agent, updated(3)),
			Story.then(v[3]!, minted(3)),
			Story.replied({ version: 4, version_id: v[3]!.id }),
			Story.when(update(4)),
			Story.then(agent, updated(4)),
			Story.then(v[4]!, minted(4)),
			Story.replied({ version: 5, version_id: v[4]!.id }),
			Story.state(agent, {
				status: "active",
				version: 5,
				current_version_id: v[4]!.id,
				name: "Planner II",
				model_id: "gpt-5.5",
				has_system: true,
				system: "Plan well.",
				has_description: true,
				description: "Plans all",
			}),
			Story.when(update(5)),
			Story.then(agent, updated(5)),
			Story.then(v[5]!, minted(5)),
			Story.replied({ version: 6, version_id: v[5]!.id }),
			Story.when(update(6)),
			Story.then(agent, updated(6)),
			Story.then(v[6]!, minted(6)),
			Story.replied({ version: 7, version_id: v[6]!.id }),
			Story.state(agent, {
				status: "active",
				version: 7,
				current_version_id: v[6]!.id,
				name: "Planner II",
				model_id: "gpt-5.5",
				has_system: false,
				system: "",
				has_description: false,
				description: "",
			}),
			Story.clock(t2),
			Story.when(update(7)),
			Story.then(agent, updated(7)),
			Story.then(v[7]!, minted(7)),
			Story.replied({ version: 8, version_id: v[7]!.id }),
			Story.when(update(8)),
			Story.then(agent, updated(8)),
			Story.then(v[8]!, minted(8)),
			Story.replied({ version: 9, version_id: v[8]!.id }),
			Story.state(agent, {
				status: "active",
				version: 9,
				current_version_id: v[8]!.id,
				name: "Planner III",
				model_id: "gpt-5.5",
				has_system: false,
				system: "",
				has_description: true,
				description: "",
			}),
			Story.view(AgentView, agent, {
				id: agent.id,
				type: "agent",
				version: 9,
				current_version_id: v[8]!.id,
				name: "Planner III",
				model: { id: "gpt-5.5" },
				system: null,
				description: "",
				created_at: t0,
				updated_at: t2,
				archived_at: null,
			}),
			Story.view(AgentVersionByNumberView, agentVersionLookupKey(agent.id, 2), {
				id: v[1]!.id,
				agent_id: agent.id,
				type: "agent",
				version: 2,
				name: "Planner II",
				model: { id: "gpt-5.4" },
				system: "Plan.",
				description: "Plans work",
				created_at: t1,
			}),
		)
	})

	it.effect("mints nothing for a partial update that leaves the head as it is", () => {
		const agent = Agent.ref("agent_partial_noop")
		const v1 = AgentVersion.ref("aver_partial_noop_1")
		const unused = AgentVersion.ref("aver_partial_noop_unused")
		const head = {
			name: "Steady",
			model: { id: "gpt-5.4" },
			system: "Hold.",
			description: null,
		}
		const noOp = (changes: UpdateAgent["changes"], next = unused) =>
			new UpdateAgent({
				agent_id: agent.id,
				expected_version: 1,
				next_version_id: next.id,
				changes,
			})
		return story(
			Story.clock(t0),
			Story.given(agent, new AgentCreated({ version: 1, version_id: v1.id, ...head })),
			Story.given(v1, new AgentVersionMinted({ agent_id: agent.id, version: 1, ...head })),
			Story.clock(t1),
			Story.when(noOp({})),
			Story.then(agent),
			Story.then(unused),
			Story.replied({ version: 1, version_id: v1.id }),
			Story.when(noOp({ name: "Steady" })),
			Story.then(agent),
			Story.then(unused),
			Story.replied({ version: 1, version_id: v1.id }),
			Story.when(noOp({ model: { id: "gpt-5.4" }, system: "Hold." })),
			Story.then(agent),
			Story.then(unused),
			Story.replied({ version: 1, version_id: v1.id }),
			Story.when(noOp({ description: null })),
			Story.then(agent),
			Story.then(unused),
			Story.replied({ version: 1, version_id: v1.id }),
			Story.when(noOp({ name: "Steady" }, v1)),
			Story.then(agent),
			Story.then(v1),
			Story.replied({ version: 1, version_id: v1.id }),
			Story.state(unused, {
				minted: false,
				agent_id: "",
				version: 0,
				name: "",
				model_id: "",
				has_system: false,
				system: "",
				has_description: false,
				description: "",
			}),
			Story.view(AgentView, agent, {
				id: agent.id,
				type: "agent",
				version: 1,
				current_version_id: v1.id,
				...head,
				created_at: t0,
				updated_at: t0,
				archived_at: null,
			}),
		)
	})

	it.effect(
		"refuses a partial update of a missing, stale or archived agent, or onto a minted version",
		() => {
			const missing = Agent.ref("agent_partial_missing")
			const agent = Agent.ref("agent_partial_refused")
			const v1 = AgentVersion.ref("aver_partial_refused_1")
			const v2 = AgentVersion.ref("aver_partial_refused_2")
			const head = {
				name: "Guarded",
				model: { id: "gpt-5.4" },
				system: null,
				description: "Kept",
			}
			return story(
				Story.clock(t0),
				Story.when(
					new UpdateAgent({
						agent_id: missing.id,
						expected_version: 1,
						next_version_id: v2.id,
						changes: { name: "Missing" },
					}),
				),
				Story.rejected(new AgentNotFound({ agent_id: missing.id })),
				Story.given(agent, new AgentCreated({ version: 1, version_id: v1.id, ...head })),
				Story.given(v1, new AgentVersionMinted({ agent_id: agent.id, version: 1, ...head })),
				Story.when(
					new UpdateAgent({
						agent_id: agent.id,
						expected_version: 2,
						next_version_id: v2.id,
						changes: { description: null },
					}),
				),
				Story.rejected(
					new AgentVersionConflict({ agent_id: agent.id, expected_version: 2, current_version: 1 }),
				),
				Story.when(
					new UpdateAgent({
						agent_id: agent.id,
						expected_version: 1,
						next_version_id: v1.id,
						changes: { system: "Changed" },
					}),
				),
				Story.rejected(new AgentVersionAlreadyExists({ version_id: v1.id })),
				Story.when(new ArchiveAgent({ agent_id: agent.id })),
				Story.then(agent, new AgentArchived()),
				Story.when(
					new UpdateAgent({
						agent_id: agent.id,
						expected_version: 2,
						next_version_id: v2.id,
						changes: { name: "Archived" },
					}),
				),
				Story.rejected(new AgentArchivedError({ agent_id: agent.id })),
				Story.state(agent, {
					status: "archived",
					version: 1,
					current_version_id: v1.id,
					name: "Guarded",
					model_id: "gpt-5.4",
					has_system: false,
					system: "",
					has_description: true,
					description: "Kept",
				}),
				Story.state(v2, { minted: false }),
			)
		},
	)
})
