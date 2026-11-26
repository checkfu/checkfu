import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { SessionStatusIdle } from "./CommitModelReply.command.ts"
import { Session } from "./Session.aggregate.ts"
import { SessionOutputs } from "./SessionOutputs.external.ts"

export class PublishSessionOutputs extends Domain.Policy("PublishSessionOutputs", {
	from: Session,
	on: [SessionStatusIdle],
}) {}

export const PublishSessionOutputsLive = PublishSessionOutputs.toLayer(
	Effect.gen(function* () {
		const outputs = yield* SessionOutputs
		return Effect.fn(function* ({ source, event }) {
			const stop = event.stop_reason.type
			if (stop !== "end_turn" && stop !== "budget_reached" && stop !== "refusal") {
				return
			}
			yield* outputs.publish({ session_id: source.id, turn: event.turn })
		})
	}),
)
