import { decodeSystemMessage } from "../../src/Session/SendSystemMessage.command.ts"
import * as Verify from "@alchemy.run/domain/Verify"
import {
	decodeAgentTools,
	decodeMcpServerCredentials,
	decodeMcpServers,
} from "../../src/Mcp/McpServers.ts"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { addToolUseId, removeToolUseId } from "../../src/Session/SessionTypes.ts"
import { Sessions, SessionsApi } from "../../src/Sessions.model.ts"
import { PROVED, SESSIONS_PROOF_DEADLINE_MS, STANDING } from "../Sessions.verify.standing.ts"

describe("Sessions Z3 formal verification", () => {
	it.live(
		"proves every Session invariant and transition in Z3 and verifies turn execution with step reruns",
		() =>
			Effect.gen(function* () {
				const report = yield* Verify.report(Sessions, {
					apis: [SessionsApi],
					instances: 1,
					depth: 2,
					budget: 500_000,
					faults: { redeliver: true, reorder: true, rerun: true },
					walks: { count: 25 },
					opaque: [
						decodeMcpServers,
						decodeMcpServerCredentials,
						decodeAgentTools,
						addToolUseId,
						removeToolUseId,
						decodeSystemMessage,
					],
					lock: "../Sessions.verify.lock.json",
					require: { proved: PROVED },
				})
				console.error(
					`[PROBE] sessions sequences=${report.explored.sequences} complete=${report.explored.complete} truncated=${report.explored.truncated} undone=${JSON.stringify(report.undone)} followed=${JSON.stringify(report.explored.followed)} idle=${JSON.stringify(report.explored.idle)}`,
				)
			}).pipe(Effect.provide(NodeServices.layer)),
		5_400_000,
	)
})
