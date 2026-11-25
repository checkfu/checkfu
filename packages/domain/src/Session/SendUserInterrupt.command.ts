import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SessionId } from "./Session.id.ts"
import { SessionNotFound } from "./SessionNotFound.rejection.ts"
import { SessionNotRunning } from "./SessionNotRunning.rejection.ts"
import { SessionTerminated } from "./SessionTerminated.rejection.ts"
import { PositiveInt } from "./SessionTypes.ts"

// Carries its turn, so whatever forwards it to the harness stops that turn and no later one.
// An interrupt recorded before it carried one reads as naming none.
export class UserInterrupt extends Domain.Event("user.interrupt", {
	turn: Schema.NullOr(PositiveInt).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
}) {}

export class SendUserInterrupt extends Domain.Command("SendUserInterrupt", {
	input: {
		session_id: SessionId,
	},
	events: [UserInterrupt],
	rejects: [SessionNotFound, SessionTerminated, SessionNotRunning],
}) {}
