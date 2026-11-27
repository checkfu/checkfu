import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { SessionId } from "../Session/Session.id.ts"
import { NonNegativeInt } from "./OutputsTypes.ts"
import { RecordSessionOutputs, SessionOutputsSaved } from "./RecordSessionOutputs.command.ts"
import { SessionOutputsSkipped, SkipSessionOutputs } from "./SkipSessionOutputs.command.ts"

export const SessionOutputsState = Schema.Struct({
	turn: NonNegativeInt,
	outcome: Schema.Literals(["", "saved", "skipped"]),
	reason: Schema.String,
	files: Schema.String,
	skipped: Schema.String,
	recorded_at: NonNegativeInt,
})
export type SessionOutputsState = typeof SessionOutputsState.Type

export class SessionOutputs extends Domain.Aggregate("SessionOutputs", {
	id: SessionId,
	state: versionedSnapshot({ current: 1, schema: SessionOutputsState }),
	initial: { turn: 0, outcome: "", reason: "", files: "", skipped: "", recorded_at: 0 },
	commands: [RecordSessionOutputs, SkipSessionOutputs],
	keyOf: (cmd) => cmd.session_id,
	invariants: {
		OutcomeIsKnown: (s) =>
			[s.outcome === "", s.outcome === "saved", s.outcome === "skipped"].some((ok) => ok),
		AnOutcomeIsRecordedExactlyWhenATurnIs: (s) =>
			[
				[s.turn === 0, s.outcome === "", s.files === "", s.skipped === ""].every((ok) => ok),
				[s.turn >= 1, s.outcome !== ""].every((ok) => ok),
			].some((ok) => ok),
		AReasonIsGivenExactlyWhenTheTurnWasSkipped: (s) =>
			[
				[s.outcome === "skipped", s.reason !== ""].every((ok) => ok),
				[s.outcome !== "skipped", s.reason === ""].every((ok) => ok),
			].some((ok) => ok),
	},
	transitions: {
		TheRecordedTurnNeverGoesBack: ({ before, after }) => after.turn >= before.turn,
		ATurnIsRecordedAtMostOnce: ({ before, after, command, events }) =>
			[
				[events.length === 0, command.turn <= before.turn].every((ok) => ok),
				[events.length === 1, command.turn > before.turn, after.turn === command.turn].every(
					(ok) => ok,
				),
			].some((ok) => ok),
		ASkippedTurnKeepsTheFilesSavedBefore: ({ before, after, command }) =>
			[command._tag !== "SkipSessionOutputs", after.files === before.files].some((ok) => ok),
		ASavedTurnReplacesTheFiles: ({ after, command, events }) => {
			if (command._tag !== "RecordSessionOutputs") {
				return true
			}
			return [
				events.length === 0,
				[after.files === command.files, after.skipped === command.skipped].every((ok) => ok),
			].some((ok) => ok)
		},
		NothingChangesWithoutARecord: ({ before, after, events }) =>
			[
				events.length !== 0,
				[
					after.turn === before.turn,
					after.outcome === before.outcome,
					after.files === before.files,
				].every((ok) => ok),
			].some((ok) => ok),
	},
	decide: {
		RecordSessionOutputs: (state, cmd) =>
			cmd.turn <= state.turn
				? []
				: [new SessionOutputsSaved({ turn: cmd.turn, files: cmd.files, skipped: cmd.skipped })],
		SkipSessionOutputs: (state, cmd) =>
			cmd.turn <= state.turn
				? []
				: [new SessionOutputsSkipped({ turn: cmd.turn, reason: cmd.reason })],
	},
	evolve: {
		"session_outputs.saved": (state, e, envelope) =>
			e.turn <= state.turn
				? state
				: {
						turn: e.turn,
						outcome: "saved" as const,
						reason: "",
						files: e.files,
						skipped: e.skipped,
						recorded_at: DateTime.toEpochMillis(envelope.at),
					},
		"session_outputs.skipped": (state, e, envelope) =>
			e.turn <= state.turn
				? state
				: {
						...state,
						turn: e.turn,
						outcome: "skipped" as const,
						reason: e.reason,
						skipped: "",
						recorded_at: DateTime.toEpochMillis(envelope.at),
					},
	},
}) {}
