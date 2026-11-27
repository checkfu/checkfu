import { decodeSystemMessage } from "../src/Session/SendSystemMessage.command.ts"
import * as Verify from "@alchemy.run/domain/Verify"
import {
	decodeAgentTools,
	decodeMcpServerCredentials,
	decodeMcpServers,
} from "../src/Mcp/McpServers.ts"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { addToolUseId, removeToolUseId } from "../src/Session/SessionTypes.ts"
import { Sessions, SessionsApi } from "../src/Sessions.model.ts"
import { PROVED, SESSIONS_PROOF_DEADLINE_MS, STANDING } from "./Sessions.verify.standing.ts"

const RERUN_WALKS = 100

describe("Sessions Z3 formal verification", () => {
	it.live(
		"proves every Session invariant and transition in Z3 and checks step reruns in seeded turn sequences",
		() =>
			Effect.gen(function* () {
				const report = yield* Verify.model(Sessions, {
					apis: [SessionsApi],
					instances: 1,
					// Replay exhausts depth two without step reruns. The longer walks exercise reruns.
					depth: 1,
					budget: 30_000,
					faults: { redeliver: true, reorder: true, rerun: true },
					walks: { count: RERUN_WALKS, seed: 1 },
					opaque: [
						decodeMcpServers,
						decodeMcpServerCredentials,
						decodeAgentTools,
						addToolUseId,
						removeToolUseId,
						decodeSystemMessage,
					],
					lock: "./Sessions.verify.lock.json",
					require: { proved: PROVED },
				})
				expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
					STANDING,
				)
				expect(report.undone).toEqual([])
				yield* Effect.logInfo(Verify.render(report))
				expect(report.explored.followed.toSorted()).toEqual([
					"EnsureTurnStopped",
					"SaveSessionOutputs",
					"StartTurn",
				])
				expect(report.explored.idle).toEqual([])
				expect(report.explored.sagas).toEqual(["RunTurn"])
				expect(report.explored.unstarted).toEqual([])
				expect(report.explored.skipped.map((skipped) => skipped.policy)).toEqual([])
				expect(report.explored.aside).toEqual([
					{
						kind: "view",
						name: "SessionTurnCompletion",
						reason: "no rule reads it and no policy reacts to it",
					},
				])
				expect(report.explored.truncated).toBe(false)
				expect(report.explored.complete).toBe(1)
				expect(report.explored.walks.count).toBe(RERUN_WALKS)
				expect(report.explored.walks.longest).toBeGreaterThanOrEqual(3)
				expect(report.explored.repeated).toContain(
					"Harness.runTurn, by RunTurn in its step run-harness-turn",
				)
				expect(report.explored.disagreements).toEqual([])
				expect(report.explored.agreement.compared).toBeGreaterThan(0)
			}).pipe(Effect.provide(NodeServices.layer)),
		SESSIONS_PROOF_DEADLINE_MS,
	)
})
