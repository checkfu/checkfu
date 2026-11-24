import * as Domain from "@alchemy.run/domain"
import * as InMemory from "@alchemy.run/domain/InMemory"
import * as Model from "@alchemy.run/domain/Model"
import * as Verify from "@alchemy.run/domain/Verify"
import { Agent } from "../src/Agent/Agent.aggregate.ts"
import { AgentId } from "../src/Agent/Agent.id.ts"
import { AgentVersion } from "../src/Agent/AgentVersion.aggregate.ts"
import { AgentVersionId } from "../src/Agent/AgentVersion.id.ts"
import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "../src/Agent/AgentVersionByNumberView.view.ts"
import { AgentVersionView } from "../src/Agent/AgentVersionView.view.ts"
import { AgentView } from "../src/Agent/AgentView.view.ts"
import { ArchiveAgent } from "../src/Agent/ArchiveAgent.command.ts"
import { CreateAgent } from "../src/Agent/CreateAgent.command.ts"
import { CreateAgentDecision } from "../src/Agent/CreateAgent.decision.ts"
import { UpdateAgent } from "../src/Agent/UpdateAgent.command.ts"
import { UpdateAgentDecision } from "../src/Agent/UpdateAgent.decision.ts"
import { Automation } from "../src/Automation/Automation.aggregate.ts"
import { AdmitAutomation } from "../src/Automation/AdmitAutomation.command.ts"
import { AdmitAutomationDecision } from "../src/Automation/AdmitAutomation.decision.ts"
import { AUTOMATION_CAPACITY } from "../src/Automation/AutomationCapacity.id.ts"
import { RunAutomation } from "../src/Automation/RunAutomation.command.ts"
import { AutomationId, sessionIdOfNextRun } from "../src/Automation/Automation.id.ts"
import { AutomationCapacity } from "../src/Automation/AutomationCapacity.aggregate.ts"
import { AutomationRunView } from "../src/Automation/AutomationRunView.view.ts"
import { AutomationView } from "../src/Automation/AutomationView.view.ts"
import { isUsableSchedule, upcomingOccurrences } from "../src/Automation/Schedule.ts"
import { ArchiveEnvironment } from "../src/Environment/ArchiveEnvironment.command.ts"
import { CreateEnvironment } from "../src/Environment/CreateEnvironment.command.ts"
import { DeleteEnvironment } from "../src/Environment/DeleteEnvironment.command.ts"
import { Environment } from "../src/Environment/Environment.aggregate.ts"
import { EnvironmentId } from "../src/Environment/Environment.id.ts"
import { EnvironmentView } from "../src/Environment/EnvironmentView.view.ts"
import { ArchiveSession } from "../src/Session/ArchiveSession.command.ts"
import { Harness } from "../src/Session/Harness.external.ts"
import { SendUserMessage } from "../src/Session/SendUserMessage.command.ts"
import { Session } from "../src/Session/Session.aggregate.ts"
import { SessionId } from "../src/Session/Session.id.ts"
import { SessionView } from "../src/Session/SessionView.view.ts"
import { TurnInput } from "../src/Session/TurnInput.view.ts"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Checkfu, CheckfuDomainApi, CheckfuHandlersLive } from "../src/Checkfu.model.ts"
import { IdempotencyClaim } from "../src/IdempotencyClaim/IdempotencyClaim.aggregate.ts"
import {
	AdmitSession,
	BoundedAgentId,
	BoundedEnvironmentId,
} from "../src/Session/AdmitSession.command.ts"
import { AdmitSessionDecision } from "../src/Session/AdmitSession.decision.ts"

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
		"ClaimIdempotencyKey",
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
	"Environment.ConfiguredExactlyWhenCreated": "proved",
	"Environment.UpdateKeepsWhatItDoesNotName": "proved",
	"Checkfu.EnvironmentViewConfigMatchesEnvironment": "checked",
	"Environment.CreatedEnvironmentNeverReturnsToUninitialized": "proved",
	"Environment.ArchivedNeverReactivates": "proved",
	"Environment.DeletedStaysDeleted": "proved",
	"Environment.VersionGrowsByOneOrNotAtAll": "proved",
	"Session.RunningTurnIsPositive": "proved",
	"Session.IdleTurnIsNonNegative": "proved",
	"Session.ModelRequestsStartedNonNegative": "proved",
	"Session.PendingUserMessagesWithinBounds": "proved",
	"Session.OpenModelRequestRequiresStartedCount": "proved",
	"Session.GenerationIsNonNegative": "proved",
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
	"Session.GenerationNeverDecreases": "proved",
	"Session.GenerationAdvancesByAtMostOne": "proved",
	"Session.GenerationHoldsWithinTurn": "proved",
	"Session.IdleSessionStartsTurnUnderItsGeneration": "proved",
	"Session.StatusRunningCarriesStartedTurnAndGeneration": "proved",
	"Session.StatusIdleCarriesEndedTurnAndNextGeneration": "proved",
	"Session.AbandonedTurnRetiresItsGeneration": "proved",
	"Session.TruncatedReplyRetiresGeneration": "proved",
	"Session.OnlyAbandonmentOrTruncationRetiresGeneration": "proved",
	"Session.OpenModelRequestClosedBeforeLeavingRunning": "proved",
	"IdempotencyClaim.ClaimNeverReturnsToUnclaimed": "proved",
	"IdempotencyClaim.ClaimedFingerprintNeverChanges": "proved",
	"IdempotencyClaim.ClaimOnlyEmitsFromUnclaimedWithCommandFingerprint": "proved",
	"Automation.StatusIsKnown": "proved",
	"Automation.NothingRunsBeforeCreation": "proved",
	"Automation.ReportedNeverExceedsRuns": "proved",
	"Automation.CreatedAutomationNeverReturnsToUninitialized": "proved",
	"Automation.ArchivedAutomationStaysArchived": "proved",
	"Automation.ArchivedAutomationNeverFires": "proved",
	"Automation.OnlyUnpauseResumesAPausedAutomation": "proved",
	"Automation.RunsGrowByOneOrNotAtAll": "proved",
	"Automation.OnlyRunAndFireStartRuns": "proved",
	"Automation.ScheduledFiringNeedsAnActiveAutomationAndALaterInstant": "proved",
	"Automation.OnlyAResumeStartsANewActivation": "proved",
	"Automation.EveryResumeStartsANewActivation": "proved",
	"Automation.ScheduledInstantNeverGoesBack": "proved",
	"Automation.FiredCarriesTheNewRun": "proved",
	"Automation.RunsAreReportedInOrder": "proved",
	"Automation.AFailedRunPausesOnlyAnActiveAutomation": "proved",
	"AutomationCapacity.ReservedSlotsStayWithinTheLimit": "proved",
	"AutomationCapacity.SlotsChangeOneAtATime": "proved",
	"CreateAgent.NewAgentStartsAtVersionOne": "proved",
	"UpdateAgent.ChangeMintsNextVersionOrNoOps": "proved",
	"UpdateAgent.UnchangedConfigMintsNothing": "proved",
	"AdmitSession.OnlyActiveAgentAndEnvironmentAdmitSession": "proved",
	"AdmitSession.PinnedVersionWithinAgentHead": "proved",
	"AdmitSession.AdmissionLeavesAgentAndEnvironmentUnchanged": "proved",
	"AdmitAutomation.OnlyActiveAgentAndEnvironmentAdmitAutomation": "proved",
	"AdmitAutomation.PinnedVersionWithinAgentHead": "proved",
	"AdmitAutomation.AdmissionTakesOneSlotWithinTheLimit": "proved",
	"AdmitAutomation.AdmissionLeavesAgentAndEnvironmentUnchanged": "proved",
	"OpenAutomationSession.OnlyActiveAgentAndEnvironmentOpenAnAutomationSession": "proved",
	"OpenAutomationSession.AnAutomationSessionOpensOnItsFirstTurnWithNothingQueued": "proved",
	"OpenAutomationSession.AnAutomationSessionPinsAVersionWithinTheAgentHead": "proved",
	"OpenAutomationSession.OpeningAnAutomationSessionLeavesAgentAndEnvironmentUnchanged": "proved",
	"Checkfu.AMintedVersionBelongsToItsAgent": "proved",
	"Checkfu.AnAgentsHeadIsItsLatestVersion": "proved",
	"Checkfu.VersionNumbersAreDistinct": "proved",
	"Checkfu.EverySessionReferencesExistingAgentVersion": "checked",
	"Checkfu.EverySessionReferencesKnownEnvironment": "checked",
	"Checkfu.HostedViewsMatchAggregates": "checked",
	"Checkfu.TurnInputGenerationMatchesSession": "checked",
	"Checkfu.AutomationViewsMatchAutomations": "checked",
	"Checkfu.AnIdempotencyKeyIsClaimed": "reached",
	"Checkfu.ASessionIsAdmitted": "reached",
	"Checkfu.AnAdmittedSessionCompletesATurn": "reached",
	"Checkfu.EveryTurnSettles": "checked",
} as const

const PROVED = Object.entries(STANDING)
	.filter(([, standing]) => standing === "proved")
	.map(([name]) => name)

const automationRef = Automation.ref(AutomationId.make("auto_post_1"))

const HarnessStubLayer = Harness.toLayer(
	Effect.succeed({
		interrupt: () => Effect.void,
		runTurn: () =>
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
			"ClaimIdempotencyKey",
			"AdmitAutomation",
			"PauseAutomation",
			"UnpauseAutomation",
			"ArchiveAutomation",
			"RunAutomation",
		])
		expect(hostedCommands).not.toContain("CreateSession")
		expect(hostedCommands).not.toContain("CreateAutomation")
		expect(
			CheckfuDomainApi.serves.flatMap((entry) => (entry.kind === "View" ? [entry.viewName] : [])),
		).toEqual([
			"AgentView",
			"AgentVersionView",
			"AgentVersionByNumberView",
			"EnvironmentView",
			"SessionView",
			"AutomationView",
			"AutomationRunView",
		])
		const report = await Effect.runPromise(
			Verify.model(Checkfu, {
				apis: [CheckfuLifecycleApi],
				instances: 1,
				depth: 3,
				budget: 12_000,
				faults: { redeliver: false, reorder: false, rerun: false },
				walks: { count: 120, length: 8 },
				opaque: [sessionIdOfNextRun, isUsableSchedule, upcomingOccurrences],
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
		expect(exploredOutcomes).toContain(
			"IdempotencyClaim.ClaimIdempotencyKey → idempotency_key.claimed",
		)
		expect(exploredOutcomes).toContain(
			"IdempotencyClaim.ClaimIdempotencyKey ✗ IdempotencyKeyConflict",
		)
	}, 600_000)

	it("preserves all cross-domain Checkfu invariants after post-admission UpdateAgent, ArchiveAgent, ArchiveEnvironment, DeleteEnvironment, and ArchiveSession mutations", async () => {
		const platform = InMemory.make({ manual: true })
		const observedAggregateIds = new Map<string, Set<string>>()
		const observedViewKeys = new Map<string, Set<string>>()
		const layer = Checkfu.layer(CheckfuHandlersLive.pipe(Layer.provide(HarnessStubLayer))).pipe(
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
					const admitAutomation = yield* AdmitAutomationDecision
					const automations = yield* Automation

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
							IdempotencyClaim: yield* readAggregate(IdempotencyClaim),
							AgentView: yield* readView(AgentView),
							AgentVersionView: yield* readView(AgentVersionView),
							AgentVersionByNumberView: yield* readView(AgentVersionByNumberView),
							EnvironmentView: yield* readView(EnvironmentView),
							SessionView: yield* readView(SessionView),
							TurnInput: yield* readView(TurnInput),
							Automation: yield* readAggregate(Automation),
							AutomationCapacity: yield* readAggregate(AutomationCapacity),
							AutomationView: yield* readView(AutomationView),
							AutomationRunView: yield* readView(AutomationRunView),
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
							changes: {
								name: "Post-Admission Agent v2",
								model: { id: "gpt-5.4" },
								system: null,
								description: null,
							},
						}),
					)
					yield* recordStep("updated-agent-to-v2-after-admission")
					yield* updateAgent.send(
						new UpdateAgent({
							agent_id: agentRef.id,
							expected_version: 2,
							next_version_id: vNoopRef.id,
							changes: {
								name: "Post-Admission Agent v2",
								model: { id: "gpt-5.4" },
								system: null,
								description: null,
							},
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

					// 3b. Admit an automation and run it once: the run opens its own session with the
					// automation's message and completes a turn.
					yield* admitAutomation.send(
						new AdmitAutomation({
							automation_id: automationRef.id,
							capacity_id: AUTOMATION_CAPACITY,
							name: "Post-Admission Automation",
							agent_id: BoundedAgentId.make(agentRef.id),
							agent_version: null,
							environment_id: BoundedEnvironmentId.make(envRef.id),
							text: "Run the automation",
							schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
						}),
					)
					yield* automations.send(new RunAutomation({ automation_id: automationRef.id }))
					const automationWorld = yield* recordStep("automation-admitted-and-run")

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
						automationWorld,
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
		expect(results.stepChecks.length).toBe(11)
		for (const check of results.stepChecks) {
			expect(check.invariants, `invariants failed at step '${check.step}'`).toEqual({
				EverySessionReferencesExistingAgentVersion: true,
				EverySessionReferencesKnownEnvironment: true,
				HostedViewsMatchAggregates: true,
				TurnInputGenerationMatchesSession: true,
				EnvironmentViewConfigMatchesEnvironment: true,
				AutomationViewsMatchAutomations: true,
			})
		}

		// Confirm the queued message did not directly emit session.status_running — turn 2
		// was started by RunTurn's CommitModelReply and read from the committed session log.
		expect(results.queuedSendEventTags).toEqual(["user.message"])
		const completedSessionV1 = results.completedTurnWorld.Session.find(
			(row) => row.id === "sess_post_v1",
		)
		expect(completedSessionV1?.state).toEqual({ _tag: "Idle", turn: 2, generation: 0 })
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

		// Confirm the automation step produced nonempty automation state that the invariants judged.
		const automationWorld = results.automationWorld
		expect(automationWorld.Automation.map((row) => [row.id, row.state])).toEqual([
			[
				automationRef.id,
				{ status: "active", runs: 1, reported: 1, last_scheduled_at: 0, activation: 0 },
			],
		])
		expect(automationWorld.AutomationCapacity.map((row) => row.state)).toEqual([{ reserved: 1 }])
		expect(automationWorld.AutomationView.map((row) => [row.state.status, row.state.runs])).toEqual(
			[["active", 1]],
		)
		expect(automationWorld.AutomationRunView.map((row) => row.state)).toEqual([{ recorded: 1 }])
		const runSession = automationWorld.Session.find(
			(row) => row.id === `sess_${automationRef.id}_1`,
		)
		expect(runSession?.state).toEqual({ _tag: "Idle", turn: 1, generation: 0 })
		expect(runSession?.events.map((event) => event._tag).slice(0, 3)).toEqual([
			"session.created",
			"user.message",
			"session.status_running",
		])
		expect(
			evaluateCheckfuInvariants({
				...automationWorld,
				AutomationView: automationWorld.AutomationView.map((row) => ({
					...row,
					state: { ...row.state, status: "paused" },
				})),
			}).AutomationViewsMatchAutomations,
		).toBe(false)
		expect(
			evaluateCheckfuInvariants({
				...automationWorld,
				AutomationRunView: automationWorld.AutomationRunView.map((row) => ({
					...row,
					state: { recorded: 0 },
				})),
			}).AutomationViewsMatchAutomations,
		).toBe(false)

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
		expect(results.finalWorld.SessionView.map((row) => [row.id, row.state.agent_version])).toEqual([
			["sess_post_v1", 1],
			["sess_post_v2", 2],
			[`sess_${automationRef.id}_1`, 2],
		])
		expect(results.finalWorld.TurnInput.map((row) => [row.id, row.state.turn])).toEqual([
			["sess_post_v1", 2],
			["sess_post_v2", 0],
			[`sess_${automationRef.id}_1`, 1],
		])

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
			TurnInputGenerationMatchesSession: true,
			EnvironmentViewConfigMatchesEnvironment: true,
			AutomationViewsMatchAutomations: true,
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
			TurnInputGenerationMatchesSession: true,
			EnvironmentViewConfigMatchesEnvironment: true,
			AutomationViewsMatchAutomations: true,
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
			TurnInputGenerationMatchesSession: true,
			EnvironmentViewConfigMatchesEnvironment: true,
			AutomationViewsMatchAutomations: true,
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
			TurnInputGenerationMatchesSession: true,
			EnvironmentViewConfigMatchesEnvironment: true,
			AutomationViewsMatchAutomations: true,
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
			TurnInputGenerationMatchesSession: true,
			EnvironmentViewConfigMatchesEnvironment: true,
			AutomationViewsMatchAutomations: true,
		})
		expect(
			evaluateCheckfuInvariants({
				...results.finalWorld,
				TurnInput: results.finalWorld.TurnInput.map((row) =>
					row.id === "sess_post_v2"
						? { ...row, state: { ...row.state, harness_generation: 1 } }
						: row,
				),
			}),
		).toEqual({
			EverySessionReferencesExistingAgentVersion: true,
			EverySessionReferencesKnownEnvironment: true,
			HostedViewsMatchAggregates: true,
			TurnInputGenerationMatchesSession: false,
			EnvironmentViewConfigMatchesEnvironment: true,
			AutomationViewsMatchAutomations: true,
		})
	})
})
