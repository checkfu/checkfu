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
} from "../../src/Mcp/McpServers.ts"
import { Harness } from "../../src/Session/Harness.external.ts"
import { OutputsSaver } from "../../src/Session/OutputsSaver.external.ts"
import { decodeSystemMessage } from "../../src/Session/SendSystemMessage.command.ts"
import { addToolUseId, removeToolUseId } from "../../src/Session/SessionTypes.ts"
import { Sessions, SessionsApi, SessionsHandlersLive } from "../../src/Sessions.model.ts"
import {
	PROVED,
	REQUIRED_REPLAY_OUTCOMES,
	REQUIRED_REPLAY_RULES,
	SESSIONS_PROOF_DEADLINE_MS,
	STANDING,
} from "../Sessions.verify.standing.ts"

const story = Story.make(Sessions, {
	layer: SessionsHandlersLive,
	stub: [Harness, OutputsSaver],
})

describe("Sessions Z3 formal verification, replayed", () => {
	it.live(
		"replays representative depth-2 witnesses against the real in-memory model",
		() =>
			Effect.gen(function* () {
				const report = yield* Verify.report(Sessions, {
					apis: [SessionsApi],
					story,
					instances: 1,
					depth: 2,
					budget: 500_000,
					faults: { redeliver: true, reorder: true, rerun: false },
					walks: { count: 0 },
					opaque: [
						decodeMcpServers,
						decodeMcpServerCredentials,
						decodeAgentTools,
						addToolUseId,
						removeToolUseId,
						decodeSystemMessage,
					],
					require: { proved: PROVED },
				})
				console.error(
					`[PROBE] replay sequences=${report.explored.sequences} complete=${report.explored.complete} truncated=${report.explored.truncated} undone=${JSON.stringify(report.undone)} followed=${JSON.stringify(report.explored.followed)} idle=${JSON.stringify(report.explored.idle)}`,
				)
			}).pipe(Effect.provide(NodeServices.layer)),
		5_400_000,
	)
})
