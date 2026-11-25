import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import {
	DenyMessage,
	PositiveInt,
	ResourceId,
	ToolConfirmationResult,
	ToolResultText,
} from "./SessionTypes.ts"
import { ToolConfirmationId } from "./ToolConfirmation.id.ts"

export const ToolCallAwaits = Schema.Literals(["confirmation", "result"])
export type ToolCallAwaits = typeof ToolCallAwaits.Type

export class ToolConfirmationRequested extends Domain.Event("tool_confirmation.requested", {
	session_id: ResourceId,
	tool_use_id: ResourceId,
	turn: PositiveInt,
	awaits: ToolCallAwaits,
}) {}

export class ToolConfirmationAnswered extends Domain.Event("tool_confirmation.answered", {
	result: ToolConfirmationResult,
	deny_message: DenyMessage,
}) {}

export class ToolResultReturned extends Domain.Event("tool_confirmation.returned", {
	text: ToolResultText,
	is_error: Schema.Boolean,
}) {}

export const ToolConfirmationState = Schema.Struct({
	status: Schema.Literals(["", "pending", "allowed", "denied", "returned"]),
	session_id: Schema.String,
	tool_use_id: Schema.String,
	turn: Schema.Int,
	awaits: Schema.Literals(["", "confirmation", "result"]),
	deny_message: Schema.String,
	result_text: Schema.String,
	result_is_error: Schema.Boolean,
})
export type ToolConfirmationState = typeof ToolConfirmationState.Type

export const ToolConfirmationStateSnapshot = versionedSnapshot({
	current: 1,
	schema: ToolConfirmationState,
})

export class ToolConfirmation extends Domain.Aggregate("ToolConfirmation", {
	id: ToolConfirmationId,
	state: ToolConfirmationStateSnapshot,
	initial: {
		status: "" as const,
		session_id: "",
		tool_use_id: "",
		turn: 0,
		awaits: "" as const,
		deny_message: "",
		result_text: "",
		result_is_error: false,
	},
	events: [ToolConfirmationRequested, ToolConfirmationAnswered, ToolResultReturned],
	invariants: {
		OnlyADenialCarriesAMessage: (s) =>
			[s.status === "denied", s.deny_message === ""].some((ok) => ok),
		OnlyAReturnedResultIsAnError: (s) =>
			[s.status === "returned", !s.result_is_error].some((ok) => ok),
		ARequestedCallHasATurn: (s) => [s.status === "", s.turn >= 1].some((ok) => ok),
	},
	transitions: {
		ASettledCallNeverChanges: ({ before, after }) =>
			[
				before.status === "",
				before.status === "pending",
				[
					after.status === before.status,
					after.deny_message === before.deny_message,
					after.result_text === before.result_text,
				].every((ok) => ok),
			].some((ok) => ok),
		ACallKeepsItsSessionTurnAndKind: ({ before, after }) =>
			[
				before.status === "",
				[
					after.session_id === before.session_id,
					after.tool_use_id === before.tool_use_id,
					after.turn === before.turn,
					after.awaits === before.awaits,
				].every((ok) => ok),
			].some((ok) => ok),
		ACallIsAnsweredWithWhatItAwaits: ({ before, after }) =>
			before.status === after.status ||
			after.status === "pending" ||
			(((after.status !== "allowed" && after.status !== "denied") ||
				before.awaits === "confirmation") &&
				(after.status !== "returned" || before.awaits === "result")),
	},
	evolve: {
		"tool_confirmation.requested": (state, e) =>
			state.status === ""
				? {
						...state,
						status: "pending" as const,
						session_id: e.session_id,
						tool_use_id: e.tool_use_id,
						turn: e.turn,
						awaits: e.awaits,
					}
				: state,
		"tool_confirmation.answered": (state, e) =>
			state.status === "pending" && state.awaits === "confirmation"
				? {
						...state,
						status: e.result === "allow" ? ("allowed" as const) : ("denied" as const),
						deny_message: e.result === "allow" ? "" : e.deny_message,
					}
				: state,
		"tool_confirmation.returned": (state, e) =>
			state.status === "pending" && state.awaits === "result"
				? {
						...state,
						status: "returned" as const,
						result_text: e.text,
						result_is_error: e.is_error,
					}
				: state,
	},
}) {}
