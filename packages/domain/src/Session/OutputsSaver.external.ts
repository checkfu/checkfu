import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { SessionId } from "./Session.id.ts"
import { PositiveInt } from "./SessionTypes.ts"

export class OutputsSaver extends Domain.ExternalSystem("OutputsSaver", {
	save: {
		args: { session_id: SessionId, turn: PositiveInt },
	},
}) {}

export const OutputsUnsaved = OutputsSaver.toLayer(Effect.succeed({ save: () => Effect.void }))
