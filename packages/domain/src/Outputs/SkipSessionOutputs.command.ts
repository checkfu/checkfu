import * as Domain from "@alchemy.run/domain"
import { SessionId } from "../Session/Session.id.ts"
import { OutputReason, PositiveInt } from "./OutputsTypes.ts"

export class SessionOutputsSkipped extends Domain.Event("session_outputs.skipped", {
	turn: PositiveInt,
	reason: OutputReason,
}) {}

export class SkipSessionOutputs extends Domain.Command("SkipSessionOutputs", {
	input: { session_id: SessionId, turn: PositiveInt, reason: OutputReason },
	events: [SessionOutputsSkipped],
}) {}
