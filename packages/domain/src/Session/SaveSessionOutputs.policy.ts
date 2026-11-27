import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { SessionStatusTerminated } from "./ArchiveSession.command.ts"
import { SessionStatusIdle } from "./CommitModelReply.command.ts"
import { Harness } from "./Harness.external.ts"
import { Session } from "./Session.aggregate.ts"
import { OutputsSaver } from "./OutputsSaver.external.ts"

export class SaveSessionOutputs extends Domain.Policy("SaveSessionOutputs", {
	from: Session,
	on: [SessionStatusIdle, SessionStatusTerminated],
}) {}

export const SaveSessionOutputsLive = SaveSessionOutputs.toLayer(
	Effect.gen(function* () {
		const outputs = yield* OutputsSaver
		const harness = yield* Harness
		return Effect.fn(function* ({ source, event }) {
			if (event._tag === "session.status_terminated") {
				return yield* harness.discardWorkspace({ session_id: source.id })
			}
			const stop = event.stop_reason.type
			if (stop !== "end_turn" && stop !== "budget_reached" && stop !== "refusal") {
				return
			}
			yield* outputs.save({ session_id: source.id, turn: event.turn })
		})
	}),
)
