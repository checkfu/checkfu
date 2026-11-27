import * as Domain from "@alchemy.run/domain"
import { SessionId } from "../Session/Session.id.ts"
import { OutputsText, PositiveInt } from "./OutputsTypes.ts"

export class SessionOutputsSaved extends Domain.Event("session_outputs.saved", {
	turn: PositiveInt,
	files: OutputsText,
	skipped: OutputsText,
}) {}

export class RecordSessionOutputs extends Domain.Command("RecordSessionOutputs", {
	input: {
		session_id: SessionId,
		turn: PositiveInt,
		files: OutputsText,
		skipped: OutputsText,
	},
	events: [SessionOutputsSaved],
}) {}
