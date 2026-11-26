import * as Explore from "@alchemy.run/domain/Explore"
import { Story } from "@alchemy.run/domain/Story"
import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
	decodeAgentTools,
	decodeMcpServerCredentials,
	decodeMcpServers,
} from "../src/Mcp/McpServers.ts"
import { Harness } from "../src/Session/Harness.external.ts"
import { systemMessageText } from "../src/Session/SendSystemMessage.command.ts"
import { addToolUseId, removeToolUseId } from "../src/Session/SessionTypes.ts"
import { Sessions, SessionsApi, SessionsHandlersLive } from "../src/Sessions.model.ts"
import {
	PROVED,
	REQUIRED_REPLAY_OUTCOMES,
	REQUIRED_REPLAY_RULES,
	STANDING,
} from "./Sessions.verify.standing.ts"

const story = Story.make(Sessions, {
	layer: SessionsHandlersLive,
	stub: [Harness],
})

describe("Sessions Z3 formal verification, replayed", () => {
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
					opaque: [
						decodeMcpServers,
						decodeMcpServerCredentials,
						decodeAgentTools,
						addToolUseId,
						removeToolUseId,
						systemMessageText,
					],
					require: { proved: PROVED },
				})
				expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
					STANDING,
				)
				expect(report.undone).toEqual([])
				expect(report.explored.aside).toEqual([
					{
						kind: "view",
						name: "SessionTurnCompletion",
						reason: "no rule reads it and no policy reacts to it",
					},
				])
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
		600_000,
	)
})
