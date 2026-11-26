import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { SessionId } from "./Session.id.ts"
import { PositiveInt } from "./SessionTypes.ts"

export class SessionOutputs extends Domain.ExternalSystem("SessionOutputs", {
	publish: {
		args: { session_id: SessionId, turn: PositiveInt },
	},
}) {}

export const SessionOutputsUnpublished = SessionOutputs.toLayer(
	Effect.succeed({ publish: () => Effect.void }),
)
