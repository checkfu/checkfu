import * as Domain from "@alchemy.run/domain"
import * as InMemory from "@alchemy.run/domain/InMemory"
import * as Model from "@alchemy.run/domain/Model"
import * as Verify from "@alchemy.run/domain/Verify"
import { Agent } from "@checkfu/agents/Agent/Agent.aggregate"
import { AgentId } from "@checkfu/agents/Agent/Agent.id"
import { AgentVersion } from "@checkfu/agents/Agent/AgentVersion.aggregate"
import { AgentVersionId } from "@checkfu/agents/Agent/AgentVersion.id"
import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "@checkfu/agents/Agent/AgentVersionByNumberView.view"
import { AgentVersionView } from "@checkfu/agents/Agent/AgentVersionView.view"
import { AgentView } from "@checkfu/agents/Agent/AgentView.view"
import { ArchiveAgent } from "@checkfu/agents/Agent/ArchiveAgent.command"
import { CreateAgent } from "@checkfu/agents/Agent/CreateAgent.command"
import { CreateAgentDecision } from "@checkfu/agents/Agent/CreateAgent.decision"
import { UpdateAgent } from "@checkfu/agents/Agent/UpdateAgent.command"
import { UpdateAgentDecision } from "@checkfu/agents/Agent/UpdateAgent.decision"
import { ArchiveEnvironment } from "@checkfu/environments/Environment/ArchiveEnvironment.command"
import { CreateEnvironment } from "@checkfu/environments/Environment/CreateEnvironment.command"
import { DeleteEnvironment } from "@checkfu/environments/Environment/DeleteEnvironment.command"
import { Environment } from "@checkfu/environments/Environment/Environment.aggregate"
import { EnvironmentId } from "@checkfu/environments/Environment/Environment.id"
import { EnvironmentView } from "@checkfu/environments/Environment/EnvironmentView.view"
import { ArchiveSession } from "@checkfu/sessions/Session/ArchiveSession.command"
import { ModelProvider } from "@checkfu/sessions/Session/ModelProvider.external"
import { SendUserMessage } from "@checkfu/sessions/Session/SendUserMessage.command"
import { Session } from "@checkfu/sessions/Session/Session.aggregate"
import { SessionId } from "@checkfu/sessions/Session/Session.id"
import { SessionView } from "@checkfu/sessions/Session/SessionView.view"
import { TurnInput } from "@checkfu/sessions/Session/TurnInput.view"
import { SessionsHandlersLive } from "@checkfu/sessions/Sessions.model"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
	AdmitSession,
	AdmitSessionDecision,
	BoundedAgentId,
	BoundedEnvironmentId,
	Checkfu,
	CheckfuDomainApi,
	EventBatch,
} from "../src/Checkfu.model.ts"

/**
 * Focused cross-domain exploration surface for the unified hosted model.
 * Z3 proofs always cover every aggregate, command, decision, and relation in
 * `Checkfu`; scoping BFS/walks to the cross-domain admission, turn, and
 * idempotency lifecycle keeps exploration fast while still exercising
 * `AdmitSessionDecision`, `StartTurn`, `RunTurn`, and all 6 hosted views.
 */
class CheckfuLifecycleApi extends Domain.Api("CheckfuLifecycleApi", {
	model: Checkfu,
	commands: [
		"CreateAgent",
		"CreateEnvironment",
		"AdmitSession",
		"SendUserMessage",
		"ClaimEventBatch",
	],
	views: [
		"AgentView",
		"AgentVersionView",
		"AgentVersionByNumberView",
		"EnvironmentView",
		"SessionView",
	],
}) {}

const STANDING = {
	"Agent.StatusIsKnown": "proved",
	"Agent.CreatedExactlyWhenVersioned": "proved",
	"Agent.CreatedAgentNeverReturnsToUninitialized": "proved",
	"Agent.ArchivedAgentStaysArchived": "proved",
	"Agent.VersionGrowsByOneOrNotAtAll": "proved",
	"AgentVersion.MintedExactlyWhenNumbered": "proved",
	"AgentVersion.MintedVersionNeverChanges": "proved",
	"Environment.StatusIsKnown": "proved",
	"Environment.CreatedExactlyWhenVersioned": "proved",
	"Environment.CreatedEnvironmentNeverReturnsToUninitialized": "proved",
	"Environment.ArchivedNeverReactivates": "proved",
	"Environment.DeletedStaysDeleted": "proved",
	"Environment.VersionGrowsByOneOrNotAtAll": "proved",
	"Session.RunningTurnIsPositive": "proved",
	"Session.IdleTurnIsNonNegative": "proved",
	"Session.ModelRequestsStartedNonNegative": "proved",
	"Session.PendingUserMessagesWithinBounds": "proved",
	"Session.OpenModelRequestRequiresStartedCount": "proved",
	"Session.TerminatedSessionStaysTerminated": "proved",
	"Session.ArchivedSessionStaysArchived": "proved",
	"Session.CreatedSessionNeverReturnsToUninitialized": "proved",
	"Session.TurnNeverDecreases": "proved",
	"Session.TurnAdvancesByAtMostOne": "proved",
	"Session.ModelRequestsStartedNeverDecreasesWithinTurn": "proved",
	"Session.ModelRequestsStartedGrowsByAtMostOneWithinTurn": "proved",
	"Session.PendingUserMessagesGrowsByAtMostOneWithinTurn": "proved",
	"Session.OnlySendUserMessageAddsPendingMessages": "proved",
	"Session.OnlyArchiveSessionSetsArchivedFlag": "proved",
	"Session.OpenModelRequestClosedBeforeLeavingRunning": "proved",
	"EventBatch.ClaimedBatchNeverReturnsToUnclaimed": "proved",
	"EventBatch.ClaimedFingerprintNeverChanges": "proved",
	"EventBatch.ClaimOnlyEmitsFromUnclaimedWithCommandFingerprint": "proved",
	"CreateAgent.NewAgentStartsAtVersionOne": "proved",
	"UpdateAgent.ChangeMintsNextVersionOrNoOps": "proved",
	"UpdateAgent.UnchangedConfigMintsNothing": "proved",
	"AdmitSession.OnlyActiveAgentAndEnvironmentAdmitSession": "proved",
	"AdmitSession.PinnedVersionWithinAgentHead": "proved",
	"AdmitSession.AdmissionLeavesAgentAndEnvironmentUnchanged": "proved",
	"Checkfu.AMintedVersionBelongsToItsAgent": "proved",
	"Checkfu.AnAgentsHeadIsItsLatestVersion": "proved",
	"Checkfu.VersionNumbersAreDistinct": "proved",
	"Checkfu.EverySessionReferencesExistingAgentVersion": "checked",
	"Checkfu.EverySessionReferencesKnownEnvironment": "checked",
	"Checkfu.HostedViewsMatchAggregates": "checked",
	"Checkfu.AnEventBatchIsClaimed": "reached",
	"Checkfu.ASessionIsAdmitted": "reached",
	"Checkfu.AnAdmittedSessionCompletesATurn": "reached",
	"Checkfu.EveryTurnSettles": "checked",
} as const

const PROVED = Object.entries(STANDING)
	.filter(([, standing]) => standing === "proved")
	.map(([name]) => name)

const ModelProviderStubLayer = ModelProvider.toLayer(
	Effect.succeed({
		interrupt: () => Effect.void,
		generate: () =>
			Effect.succeed({
				thinking: null,
				text: "ok",
				input_tokens: 12,
				output_tokens: 6,
				stop_reason: { type: "end_turn" as const },
			}),
	}),
)

const trackKey = (store: Map<string, Set<string>>, entity: string, key: string): void => {
	let keys = store.get(entity)
	if (keys === undefined) {
		keys = new Set()
		store.set(entity, keys)
	}
	keys.add(key)
}

const evaluateCheckfuInvariants = (world: unknown): Record<string, boolean> =>
	Object.fromEntries(
		Object.entries(Checkfu.invariants).map(([name, check]) => [name, check(world as never)]),
	)

describe("Checkfu unified hosted model Z3 formal verification", () => {
	// Omit `story` replay on walks for the same reason as Sessions.verify.test.ts:
	// StopModelRequest intentionally retries HarnessUnavailable via Effect.orDie during walk replay.
	it("proves every aggregate, decision, and relation in Z3 and checks cross-domain admission and turns", async () => {
		const hostedCommands = CheckfuDomainApi.commands.map((command) => command.tag)
		expect(hostedCommands).toEqual([
			"CreateAgent",
			"UpdateAgent",
			"ArchiveAgent",
			"CreateEnvironment",
			"UpdateEnvironment",
			"ArchiveEnvironment",
			"DeleteEnvironment",
			"AdmitSession",
			"SendUserMessage",
			"SendUserInterrupt",
			"ArchiveSession",
			"ClaimEventBatch",
		])
		expect(hostedCommands).not.toContain("CreateSession")
		expect(
			CheckfuDomainApi.serves.flatMap((entry) => (entry.kind === "View" ? [entry.viewName] : [])),
		).toEqual([
			"AgentView",
			"AgentVersionView",
			"AgentVersionByNumberView",
			"EnvironmentView",
			"SessionView",
		])
		const report = await Effect.runPromise(
			Verify.model(Checkfu, {
				source: new URL("./Checkfu.verify.source.ts", import.meta.url),
				apis: [CheckfuLifecycleApi],
				instances: 1,
				depth: 3,
				budget: 12_000,
				faults: { redeliver: false, reorder: false, rerun: false },
				walks: { count: 120, length: 8 },
				lock: "./Checkfu.verify.lock.json",
				require: { proved: PROVED },
			}).pipe(Effect.provide(NodeServices.layer)),
		)
		expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
			STANDING,
		)
		expect(report.undone).toEqual([])
		expect(report.explored.aside).toEqual([])
		expect(report.explored.truncated).toBe(false)
		expect(report.explored.complete).toBe(3)
		expect(report.explored.disagreements).toEqual([])
		expect(report.explored.agreement.compared).toBeGreaterThan(0)
		expect(report.explored.decisions).toContain("AdmitSession")
		const exploredOutcomes = report.explored.outcomes.map(
			(outcome) =>
				`${outcome.aggregate === undefined ? "" : `${outcome.aggregate}.`}${outcome.command} ${outcome.kind === "records" ? "→" : "✗"} ${outcome.tag}`,
		)
		expect(exploredOutcomes).toContain("EventBatch.ClaimEventBatch → event_batch.claimed")
		expect(exploredOutcomes).toContain("EventBatch.ClaimEventBatch ✗ IdempotencyKeyConflict")
	}, 240_000)

	it("preserves all cross-domain Checkfu invariants after post-admission UpdateAgent, ArchiveAgent, ArchiveEnvironment, DeleteEnvironment, and ArchiveSession mutations", async () => {
		const platform = InMemory.make({ manual: true })
		const observedAggregateIds = new Map<string, Set<string>>()
		const observedViewKeys = new Map<string, Set<string>>()
		const layer = Checkfu.layer(
			SessionsHandlersLive.pipe(Layer.provide(ModelProviderStubLayer)),
		).pipe(
			Layer.updateService(Domain.Platform, (base) =>
				Domain.Platform.of({
					model: (hosted) =>
						Effect.map(base.model(hosted), (host) => ({
							...host,
							aggregate: (aggregate, kit) => {
								const handle = kit.handle
								const record = kit.record
								const seed = kit.seed
								const trackedKit = Object.assign(kit, {
									handle: (input: Parameters<typeof handle>[0]) => {
										trackKey(observedAggregateIds, aggregate.aggregateName, input.id)
										return handle(input)
									},
									record: (input: Parameters<typeof record>[0]) => {
										trackKey(observedAggregateIds, aggregate.aggregateName, input.id)
										return record(input)
									},
									seed: (input: Parameters<typeof seed>[0]) => {
										trackKey(observedAggregateIds, aggregate.aggregateName, input.id)
										return seed(input)
									},
								})
								return host.aggregate(aggregate, trackedKit)
							},
							view: (view, kit) => {
								const apply = kit.apply
								const trackedKit = Object.assign(kit, {
									apply: (
										key: Parameters<typeof apply>[0],
										snapshot: Parameters<typeof apply>[1],
										deliveries: Parameters<typeof apply>[2],
									) => {
										trackKey(observedViewKeys, view.viewName, key)
										return apply(key, snapshot, deliveries)
									},
								})
								return Effect.map(host.view(view, trackedKit), (store) => ({
									...store,
									receive: (key, deliveries) => {
										trackKey(observedViewKeys, view.viewName, key)
										return store.receive(key, deliveries)
									},
								}))
							},
						})),
				}),
			),
			Layer.provide(platform.layer),
		)

		const results = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const internals = yield* Model.Internals
					const agents = yield* Agent
					const environments = yield* Environment
					const sessions = yield* Session
					const createAgent = yield* CreateAgentDecision
					const updateAgent = yield* UpdateAgentDecision
					const admitSession = yield* AdmitSessionDecision

					const agentRef = Agent.ref(AgentId.make("agent_post_1"))
					const v1Ref = AgentVersion.ref(AgentVersionId.make("aver_post_1"))
					const v2Ref = AgentVersion.ref(AgentVersionId.make("aver_post_2"))
					const vNoopRef = AgentVersion.ref(AgentVersionId.make("aver_post_noop"))
					const envRef = Environment.ref(EnvironmentId.make("env_post_1"))
					const sessionV1Ref = Session.ref(SessionId.make("sess_post_v1"))
					const sessionV2Ref = Session.ref(SessionId.make("sess_post_v2"))

					const settlePlatform = Effect.gen(function* () {
						for (let i = 0; i < 1000; i++) {
							yield* platform.control.drain
							yield* Effect.yieldNow
							if (yield* platform.control.idle) {
								yield* Effect.yieldNow
								yield* platform.control.drain
								if (yield* platform.control.idle) {
									return
								}
							}
						}
						return yield* Effect.die(new Error("InMemory platform did not settle"))
					})

					const readAggregate = <A extends Domain.Aggregate.Any>(
						aggregate: A,
						probeIds: ReadonlyArray<string> = [],
					): Effect.Effect<
						ReadonlyArray<{
							readonly id: Domain.Aggregate.IdOf<A>
							readonly state: Domain.Aggregate.StateOf<A>
							readonly events: ReadonlyArray<Domain.Aggregate.EventOf<A>>
						}>
					> =>
						Effect.gen(function* () {
							const store = internals.aggregates.get(aggregate.aggregateName)
							if (store === undefined) {
								return yield* Effect.die(
									new Error(`Missing aggregate store for ${aggregate.aggregateName}`),
								)
							}
							const readEvents = store.events
							if (readEvents === undefined) {
								return yield* Effect.die(
									new Error(`Aggregate store ${aggregate.aggregateName} does not expose events`),
								)
							}
							const ids = new Set<string>(probeIds)
							for (const id of observedAggregateIds.get(aggregate.aggregateName) ?? []) {
								ids.add(id)
							}
							for (const commit of platform.control.commits) {
								if (commit.aggregate === aggregate.aggregateName) {
									ids.add(commit.id)
								}
							}
							return yield* Effect.forEach([...ids], (id) =>
								Effect.gen(function* () {
									const storedState = yield* store.state(id)
									const storedEvents = yield* readEvents(id)
									const events = yield* Effect.forEach(storedEvents, (entry) =>
										internals.kernel.decodeEvent(entry.event),
									)
									return {
										id,
										state: internals.kernel.decodeState(aggregate, storedState.state),
										events: events as ReadonlyArray<Domain.Aggregate.EventOf<A>>,
									}
								}),
							)
						})

					const readView = <V extends Domain.View.Any>(
						view: V,
					): Effect.Effect<
						ReadonlyArray<{
							readonly id: string
							readonly state: Exclude<Domain.View.StateOf<V>, null>
						}>
					> =>
						Effect.gen(function* () {
							const store = internals.views.get(view.viewName)
							if (store === undefined) {
								return yield* Effect.die(new Error(`Missing view store for ${view.viewName}`))
							}
							const keys = [...(observedViewKeys.get(view.viewName) ?? [])]
							const rows = yield* Effect.forEach(keys, (key) =>
								store.read(key).pipe(
									Effect.map((snapshot) => {
										if (snapshot.state === null) {
											return []
										}
										const state = internals.kernel.decodeViewState(view, snapshot.state)
										return state === null
											? []
											: [{ id: key, state: state as Exclude<Domain.View.StateOf<V>, null> }]
									}),
								),
							)
							return rows.flat()
						})

					const snapshotWorld = Effect.gen(function* () {
						yield* settlePlatform
						return {
							Agent: yield* readAggregate(Agent),
							AgentVersion: yield* readAggregate(AgentVersion, [vNoopRef.id]),
							Environment: yield* readAggregate(Environment),
							Session: yield* readAggregate(Session),
							EventBatch: yield* readAggregate(EventBatch),
							AgentView: yield* readView(AgentView),
							AgentVersionView: yield* readView(AgentVersionView),
							AgentVersionByNumberView: yield* readView(AgentVersionByNumberView),
							EnvironmentView: yield* readView(EnvironmentView),
							SessionView: yield* readView(SessionView),
							TurnInput: yield* readView(TurnInput),
						}
					})

					const stepChecks: Array<{
						readonly step: string
						readonly invariants: Record<string, boolean>
					}> = []
					const recordStep = (step: string) =>
						snapshotWorld.pipe(
							Effect.map((world) => {
								stepChecks.push({ step, invariants: evaluateCheckfuInvariants(world) })
								return world
							}),
						)

					// 1. Create Agent v1 + Environment and admit sessionV1 pinned to v1.
					yield* recordStep("initial")
					yield* createAgent.send(
						new CreateAgent({
							agent_id: agentRef.id,
							version_id: v1Ref.id,
							name: "Post-Admission Agent v1",
							model: { id: "gpt-4o-mini" },
							system: "Initial system prompt",
							description: "Initial description",
						}),
					)
					yield* environments.send(
						new CreateEnvironment({
							environment_id: envRef.id,
							name: "Post-Admission Env",
							description: "Cloud sandbox",
							config: { type: "cloud", networking: { type: "unrestricted" } },
						}),
					)
					yield* admitSession.send(
						new AdmitSession({
							session_id: sessionV1Ref.id,
							agent_id: BoundedAgentId.make(agentRef.id),
							agent_version: 1,
							environment_id: BoundedEnvironmentId.make(envRef.id),
							title: "Pinned v1",
						}),
					)
					yield* recordStep("admitted-v1")

					// 2. Advance the agent head v1 -> v2 AFTER sessionV1 was admitted, then no-op update.
					yield* updateAgent.send(
						new UpdateAgent({
							agent_id: agentRef.id,
							expected_version: 1,
							next_version_id: v2Ref.id,
							name: "Post-Admission Agent v2",
							model: { id: "gpt-5.4" },
							system: null,
							description: null,
						}),
					)
					yield* recordStep("updated-agent-to-v2-after-admission")
					yield* updateAgent.send(
						new UpdateAgent({
							agent_id: agentRef.id,
							expected_version: 2,
							next_version_id: vNoopRef.id,
							name: "Post-Admission Agent v2",
							model: { id: "gpt-5.4" },
							system: null,
							description: null,
						}),
					)
					yield* recordStep("noop-update-agent-at-v2")

					// 3. Admit a second session at head v2, then send two back-to-back messages on
					// sessionV1 so the second message queues while turn 1 runs and RunTurn itself
					// commits turn 2's session.status_running event during CommitModelReply.
					yield* admitSession.send(
						new AdmitSession({
							session_id: sessionV2Ref.id,
							agent_id: BoundedAgentId.make(agentRef.id),
							agent_version: null,
							environment_id: BoundedEnvironmentId.make(envRef.id),
							title: "Head v2",
						}),
					)
					yield* recordStep("admitted-v2-alongside-v1")
					yield* sessions.send(
						new SendUserMessage({ session_id: sessionV1Ref.id, text: "Run on v1" }),
					)
					const queuedSendReceipt = yield* sessions.send(
						new SendUserMessage({ session_id: sessionV1Ref.id, text: "Queued follow-up on v1" }),
					)
					const completedTurnWorld = yield* recordStep("completed-two-turns-on-v1-while-head-is-v2")

					// 4. Archive Agent, Archive Environment, Delete Environment, and Archive Session post-admission.
					yield* agents.send(new ArchiveAgent({ agent_id: agentRef.id }))
					yield* recordStep("archived-agent-after-admission")
					yield* environments.send(new ArchiveEnvironment({ environment_id: envRef.id }))
					const archivedEnvWorld = yield* recordStep("archived-env-after-admission")
					yield* environments.send(new DeleteEnvironment({ environment_id: envRef.id }))
					yield* recordStep("deleted-env-after-admission")
					yield* sessions.send(new ArchiveSession({ session_id: sessionV1Ref.id }))
					const finalWorld = yield* recordStep("archived-session-after-env-deletion")

					return {
						stepChecks,
						queuedSendEventTags: queuedSendReceipt.events.map((event) => event._tag),
						completedTurnWorld,
						archivedEnvWorld,
						finalWorld,
						failures: platform.control.failures,
						deaths: platform.control.deaths,
					}
				}).pipe(Effect.provide(layer)),
			),
		)

		expect(results.failures).toEqual([])
		expect(results.deaths).toEqual([])
		expect(results.stepChecks.length).toBe(10)
		for (const check of results.stepChecks) {
			expect(check.invariants, `invariants failed at step '${check.step}'`).toEqual({
				EverySessionReferencesExistingAgentVersion: true,
				EverySessionReferencesKnownEnvironment: true,
				HostedViewsMatchAggregates: true,
			})
		}

		// Confirm the queued message did not directly emit session.status_running — turn 2
		// was started by RunTurn's CommitModelReply and read from the committed session log.
		expect(results.queuedSendEventTags).toEqual(["user.message"])
		const completedSessionV1 = results.completedTurnWorld.Session.find(
			(row) => row.id === "sess_post_v1",
		)
		expect(completedSessionV1?.state).toEqual({ _tag: "Idle", turn: 2 })
		expect(
			completedSessionV1?.events.filter((event) => event._tag === "session.status_running").length,
		).toBe(2)
		const completedSessionV1View = results.completedTurnWorld.SessionView.find(
			(row) => row.id === "sess_post_v1",
		)
		const completedSessionV1Input = results.completedTurnWorld.TurnInput.find(
			(row) => row.id === "sess_post_v1",
		)
		expect(completedSessionV1View?.state.status).toBe("idle")
		expect(completedSessionV1View?.state.turn).toBe(2)
		expect(completedSessionV1Input?.state.turn).toBe(2)
		expect(completedSessionV1Input?.state.input).toEqual([])
		expect(completedSessionV1Input?.state.unsent).toEqual([])

		// Confirm post-admission ArchiveEnvironment took effect before DeleteEnvironment masked it.
		expect(results.archivedEnvWorld.Environment[0]?.state.status).toBe("archived")
		expect(results.archivedEnvWorld.EnvironmentView[0]?.state.archived_at).not.toBeNull()

		// Confirm final state actually contains both v1 & v2 sessions, archived Agent v2,
		// unminted no-op candidate, exact enumerated lookup keys (no orphans), deleted
		// Environment with no EnvironmentView row, and terminated+archived sessionV1 retaining turn 2.
		expect(results.finalWorld.Agent[0]?.state.status).toBe("archived")
		expect(results.finalWorld.Agent[0]?.state.version).toBe(2)
		expect(results.finalWorld.AgentView.map((row) => row.id)).toEqual(["agent_post_1"])
		expect(results.finalWorld.AgentVersionView.map((row) => row.id)).toEqual([
			"aver_post_1",
			"aver_post_2",
		])
		expect(
			results.finalWorld.AgentVersion.find((row) => row.id === "aver_post_noop")?.state.minted,
		).toBe(false)
		expect(results.finalWorld.AgentVersionByNumberView.map((row) => row.id)).toEqual([
			agentVersionLookupKey(AgentId.make("agent_post_1"), 1),
			agentVersionLookupKey(AgentId.make("agent_post_1"), 2),
		])
		expect(results.finalWorld.Environment[0]?.state.status).toBe("deleted")
		expect(results.finalWorld.EnvironmentView).toEqual([])
		const finalSessionV1 = results.finalWorld.Session.find((row) => row.id === "sess_post_v1")
		const finalSessionV1View = results.finalWorld.SessionView.find(
			(row) => row.id === "sess_post_v1",
		)
		expect(finalSessionV1?.state).toEqual({ _tag: "Terminated", archived: true })
		expect(finalSessionV1View?.state.status).toBe("terminated")
		expect(finalSessionV1View?.state.archived_at).not.toBeNull()
		expect(results.finalWorld.SessionView.map((row) => row.state.agent_version)).toEqual([1, 2])
		expect(results.finalWorld.TurnInput.map((row) => row.state.turn)).toEqual([2, 0])

		// Negative controls: verify each invariant fails on real projection/reference corruption,
		// including:
		// 1. Both SessionView and TurnInput drifting together from admitted v1 to v2.
		// 2. Missing an AgentVersionByNumberView row for v1.
		// 3. An extra orphaned AgentVersionByNumberView lookup row alongside the valid rows.
		// 4. Missing the referenced Environment aggregate.
		// 5. Both SessionView and TurnInput reporting turn 1 (or 0) when committed history ran 2 turns.
		expect(
			evaluateCheckfuInvariants({
				...results.finalWorld,
				SessionView: results.finalWorld.SessionView.map((row) =>
					row.id === "sess_post_v1" ? { ...row, state: { ...row.state, agent_version: 2 } } : row,
				),
				TurnInput: results.finalWorld.TurnInput.map((row) =>
					row.id === "sess_post_v1" ? { ...row, state: { ...row.state, agent_version: 2 } } : row,
				),
			}),
		).toEqual({
			EverySessionReferencesExistingAgentVersion: true,
			EverySessionReferencesKnownEnvironment: true,
			HostedViewsMatchAggregates: false,
		})
		expect(
			evaluateCheckfuInvariants({
				...results.finalWorld,
				AgentVersionByNumberView: results.finalWorld.AgentVersionByNumberView.filter(
					(row) => row.state.version !== 1,
				),
			}),
		).toEqual({
			EverySessionReferencesExistingAgentVersion: false,
			EverySessionReferencesKnownEnvironment: true,
			HostedViewsMatchAggregates: false,
		})
		const v2LookupRow = results.finalWorld.AgentVersionByNumberView.find(
			(row) => row.state.version === 2,
		)!
		expect(
			evaluateCheckfuInvariants({
				...results.finalWorld,
				AgentVersionByNumberView: [
					...results.finalWorld.AgentVersionByNumberView,
					{
						id: agentVersionLookupKey(AgentId.make("agent_post_1"), 99),
						state: { ...v2LookupRow.state, version: 99 },
					},
				],
			}),
		).toEqual({
			EverySessionReferencesExistingAgentVersion: true,
			EverySessionReferencesKnownEnvironment: true,
			HostedViewsMatchAggregates: false,
		})
		expect(
			evaluateCheckfuInvariants({
				...results.finalWorld,
				Environment: [],
			}),
		).toEqual({
			EverySessionReferencesExistingAgentVersion: true,
			EverySessionReferencesKnownEnvironment: false,
			HostedViewsMatchAggregates: true,
		})
		expect(
			evaluateCheckfuInvariants({
				...results.finalWorld,
				SessionView: results.finalWorld.SessionView.map((row) =>
					row.id === "sess_post_v1" ? { ...row, state: { ...row.state, turn: 1 } } : row,
				),
				TurnInput: results.finalWorld.TurnInput.map((row) =>
					row.id === "sess_post_v1" ? { ...row, state: { ...row.state, turn: 1 } } : row,
				),
			}),
		).toEqual({
			EverySessionReferencesExistingAgentVersion: true,
			EverySessionReferencesKnownEnvironment: true,
			HostedViewsMatchAggregates: false,
		})
	})
})
