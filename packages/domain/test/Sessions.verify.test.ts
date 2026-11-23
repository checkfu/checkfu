import * as Explore from "@alchemy.run/domain/Explore"
import { Story } from "@alchemy.run/domain/Story"
import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { ModelProvider } from "../src/Session/ModelProvider.external.ts"
import { Sessions, SessionsApi, SessionsHandlersLive } from "../src/Sessions.model.ts"

const story = Story.make(Sessions, {
	layer: SessionsHandlersLive,
	stub: [ModelProvider],
})

const STANDING = {
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
	"Sessions.SessionViewMatchesSession": "checked",
	"Sessions.TurnInputMatchesSession": "checked",
	"Sessions.ASessionCompletesATurn": "reached",
	"Sessions.ASessionTerminates": "reached",
	"Sessions.ASessionIsArchived": "reached",
	"Sessions.EveryTurnSettles": "checked",
} as const

const PROVED = Object.entries(STANDING)
	.filter(([, standing]) => standing === "proved")
	.map(([name]) => name)

const REQUIRED_REPLAY_RULES = [
	"Sessions.ASessionCompletesATurn",
	"Sessions.ASessionTerminates",
	"Sessions.ASessionIsArchived",
] as const

const REQUIRED_REPLAY_OUTCOMES = [
	"Session.CreateSession → session.created",
	"Session.CreateSession ✗ SessionAlreadyExists",
	"Session.SendUserMessage → user.message",
	"Session.SendUserMessage → session.status_running",
	"Session.SendUserMessage ✗ SessionNotFound",
	"Session.SendUserInterrupt ✗ SessionNotFound",
	"Session.SendUserInterrupt ✗ SessionNotRunning",
	"Session.RecordModelRequestStart → span.model_request_start",
	"Session.CommitModelReply → agent.message",
	"Session.CommitModelReply → span.model_request_end",
	"Session.CommitModelReply → session.status_idle",
	"Session.FailModelRequest → span.model_request_end",
	"Session.FailModelRequest → session.error",
	"Session.FailModelRequest → turn.abandoned",
	"Session.FailModelRequest → session.status_idle",
	"Session.FailModelRequest → session.status_terminated",
	"Session.InterruptModelRequest → span.model_request_end",
	"Session.InterruptModelRequest → session.status_idle",
	"Session.ArchiveSession → session.status_terminated",
	"Session.ArchiveSession → session.archived",
	"Session.ArchiveSession ✗ SessionNotFound",
] as const

describe("Sessions Z3 formal verification", () => {
	// Split into two untruncated checks until @alchemy.run/domain fixes rerun story replay
	// for external-call-only saga steps (ModelSearch.ts drops call.again when no command
	// entry has again: true, and Script.redelivers ignores step.asked) and walk replay for
	// StopModelRequest's intentional Effect.orDie retry on HarnessUnavailable.
	it.live(
		"proves every Session invariant and transition in Z3 and verifies turn execution with step reruns",
		() =>
			Effect.gen(function* () {
				const report = yield* Verify.model(Sessions, {
					apis: [SessionsApi],
					instances: 1,
					depth: 2,
					budget: 20_000,
					faults: { redeliver: true, reorder: true, rerun: true },
					walks: { count: 25 },
					lock: "./Sessions.verify.lock.json",
					require: { proved: PROVED },
				})
				expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
					STANDING,
				)
				expect(report.undone).toEqual([])
				expect(report.explored.aside).toEqual([])
				expect(report.explored.truncated).toBe(false)
				expect(report.explored.complete).toBe(2)
				expect(report.explored.repeated).toContain(
					"ModelProvider.generate, by RunTurn in its step generate-model-reply",
				)
				expect(report.explored.disagreements).toEqual([])
				expect(report.explored.agreement.compared).toBeGreaterThan(0)
			}).pipe(Effect.provide(NodeServices.layer)),
		240_000,
	)

	it.live(
		"replays representative depth-2 witnesses against the real in-memory model",
		() =>
			Effect.gen(function* () {
				const report = yield* Verify.model(Sessions, {
					apis: [SessionsApi],
					story,
					instances: 1,
					depth: 2,
					budget: 2000,
					faults: { redeliver: true, reorder: true, rerun: false },
					walks: { count: 0 },
					lock: "./Sessions.verify.lock.json",
					require: { proved: PROVED },
				})
				expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
					STANDING,
				)
				expect(report.undone).toEqual([])
				expect(report.explored.aside).toEqual([])
				expect(report.explored.truncated).toBe(false)
				expect(report.explored.complete).toBe(2)
				expect(report.unrun).toBe(0)
				const replayedScripts = new Set(
					report.runs
						.filter((run) => run.failure === undefined)
						.map((run) => Explore.script(run.story)),
				)
				const ruleWitnesses = new Map(report.rules.map((rule) => [rule.name, rule.story]))
				const outcomeWitnesses = new Map(
					report.explored.outcomes.map((outcome) => [
						`${outcome.aggregate === undefined ? "" : `${outcome.aggregate}.`}${outcome.command} ${outcome.kind === "records" ? "→" : "✗"} ${outcome.tag}`,
						outcome.story,
					]),
				)
				const missingRules = REQUIRED_REPLAY_RULES.filter((name) => {
					const witness = ruleWitnesses.get(name)
					return witness === undefined || !replayedScripts.has(Explore.script(witness))
				})
				const missingOutcomes = REQUIRED_REPLAY_OUTCOMES.filter((name) => {
					const witness = outcomeWitnesses.get(name)
					return witness === undefined || !replayedScripts.has(Explore.script(witness))
				})
				expect(missingRules).toEqual([])
				expect(missingOutcomes).toEqual([])
				expect(report.explored.disagreements).toEqual([])
				expect(report.explored.agreement.compared).toBeGreaterThan(0)
			}).pipe(Effect.provide(NodeServices.layer)),
		120_000,
	)
})
