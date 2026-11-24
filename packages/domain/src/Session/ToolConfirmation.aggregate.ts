import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import { DenyMessage, ResourceId, ToolConfirmationResult, ToolResultText } from "./SessionTypes.ts"
import { ToolConfirmationId } from "./ToolConfirmation.id.ts"

/** What a waiting call waits for: a person's allow or deny, or the result its caller's application computes. */
export const ToolCallAwaits = Schema.Literals(["confirmation", "result"])
export type ToolCallAwaits = typeof ToolCallAwaits.Type

export class ToolConfirmationRequested extends Domain.Event("tool_confirmation.requested", {
	session_id: ResourceId,
	tool_use_id: ResourceId,
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

export class ToolConfirmationCancelled extends Domain.Event("tool_confirmation.cancelled") {}

export class RequestToolConfirmation extends Domain.Command("RequestToolConfirmation", {
	input: {
		confirmation_id: ToolConfirmationId,
		session_id: ResourceId,
		tool_use_id: ResourceId,
		awaits: ToolCallAwaits,
	},
	events: [ToolConfirmationRequested],
}) {}

export class CancelToolConfirmation extends Domain.Command("CancelToolConfirmation", {
	input: {
		confirmation_id: ToolConfirmationId,
	},
	events: [ToolConfirmationCancelled],
}) {}

export const ToolConfirmationState = Schema.Struct({
	status: Schema.Literals(["", "pending", "allowed", "denied", "returned", "cancelled"]),
	session_id: Schema.String,
	tool_use_id: Schema.String,
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

/**
 * One tool call that waits: for a person to allow or deny it, or for its
 * caller's application to return its result. It is asked for once, and then
 * exactly one of an answer and a cancellation wins: whichever is recorded
 * first stands, and nothing changes it afterwards.
 */
export class ToolConfirmation extends Domain.Aggregate("ToolConfirmation", {
	id: ToolConfirmationId,
	state: ToolConfirmationStateSnapshot,
	initial: {
		status: "" as const,
		session_id: "",
		tool_use_id: "",
		awaits: "" as const,
		deny_message: "",
		result_text: "",
		result_is_error: false,
	},
	commands: [RequestToolConfirmation, CancelToolConfirmation],
	events: [ToolConfirmationAnswered, ToolResultReturned],
	keyOf: (cmd) => cmd.confirmation_id,
	invariants: {
		OnlyADenialCarriesAMessage: (s) =>
			[s.status === "denied", s.deny_message === ""].some((ok) => ok),
		OnlyAReturnedResultIsAnError: (s) =>
			[s.status === "returned", !s.result_is_error].some((ok) => ok),
	},
	transitions: {
		ASettledConfirmationNeverChanges: ({ before, after }) =>
			[
				before.status === "",
				before.status === "pending",
				[after.status === before.status, after.deny_message === before.deny_message].every(
					(ok) => ok,
				),
			].some((ok) => ok),
		AConfirmationKeepsItsCall: ({ before, after }) =>
			[
				before.status === "",
				[after.session_id === before.session_id, after.tool_use_id === before.tool_use_id].every(
					(ok) => ok,
				),
			].some((ok) => ok),
		OnlyAPendingConfirmationIsAnswered: ({ before, after }) =>
			[
				before.status === after.status,
				after.status === "pending",
				after.status === "cancelled",
				before.status === "pending",
			].some((ok) => ok),
		ACallIsAnsweredWithWhatItAwaits: ({ before, after }) =>
			before.status === after.status ||
			(((after.status !== "allowed" && after.status !== "denied") ||
				before.awaits === "confirmation") &&
				(after.status !== "returned" || before.awaits === "result")),
		ACallKeepsWhatItAwaits: ({ before, after }) =>
			[before.status === "", after.awaits === before.awaits].some((ok) => ok),
	},
	decide: {
		RequestToolConfirmation: (state, cmd) =>
			state.status === ""
				? [
						new ToolConfirmationRequested({
							session_id: cmd.session_id,
							tool_use_id: cmd.tool_use_id,
							awaits: cmd.awaits,
						}),
					]
				: [],
		CancelToolConfirmation: (state) =>
			state.status === "pending" ? [new ToolConfirmationCancelled()] : [],
	},
	evolve: {
		"tool_confirmation.requested": (state, e) =>
			state.status === ""
				? {
						...state,
						status: "pending" as const,
						session_id: e.session_id,
						tool_use_id: e.tool_use_id,
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
		"tool_confirmation.cancelled": (state) =>
			state.status === "pending" ? { ...state, status: "cancelled" as const } : state,
	},
}) {}
