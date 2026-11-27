import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { initialOwnerMarks, ownerTransition } from "../src/Bytes/ByteOwnership.ts"
import { DecideOwnership, OwnerDecided, ownerStateFields } from "./DecideOwnership.command.ts"

export class ByteOwnership extends Domain.Aggregate("ByteOwnership", {
	id: Schema.String,
	state: Schema.Struct(ownerStateFields),
	initial: { ...initialOwnerMarks, action: "permit" },
	commands: [DecideOwnership],
	keyOf: (cmd) => cmd.id,
	transitions: {
		PurgeIsTerminal: ({ before, after }) => !before.purged || after.purged,
		PurgedOwnersRefuseWrites: ({ before, after, command }) => {
			if (!before.purged || command.operation === "release" || command.operation === "purge") {
				return true
			}
			return after.action === "purged"
		},
		WatermarksNeverDecrease: ({ before, after }) =>
			[after.staged >= before.staged, after.released >= before.released].every((ok) => ok),
		NewStageAdvancesItsFence: ({ before, after, command }) => {
			if (
				before.purged ||
				command.operation !== "stage" ||
				command.reservation <= before.staged ||
				command.reservation <= before.released
			) {
				return true
			}
			return [after.action === "stage", after.staged === command.reservation].every((ok) => ok)
		},
		CheckOnlyLeavesTheStageFence: ({ before, after, command }) =>
			command.operation !== "check" || after.staged === before.staged,
		StaleReservationsCannotWrite: ({ before, after, command }) => {
			if (before.purged || command.operation === "release" || command.operation === "purge") {
				return true
			}
			if (command.reservation > before.released && command.reservation >= before.staged) {
				return true
			}
			return after.action === "stale"
		},
		LateReleaseKeepsNewerBytes: ({ before, after, command }) => {
			if (
				before.purged ||
				command.operation !== "release" ||
				command.reservation <= before.released ||
				command.reservation >= before.staged
			) {
				return true
			}
			return [after.action === "release", after.released === command.reservation].every((ok) => ok)
		},
		CurrentReleaseRemovesBytes: ({ before, after, command }) => {
			if (
				before.purged ||
				command.operation !== "release" ||
				command.reservation <= before.released ||
				command.reservation < before.staged
			) {
				return true
			}
			return [after.action === "removeThenRelease", after.released === command.reservation].every(
				(ok) => ok,
			)
		},
		PurgeAlwaysCleansUp: ({ before, after, command }) => {
			if (command.operation !== "purge") {
				return true
			}
			return [
				after.purged,
				after.action === (before.purged ? "removeAgain" : "markThenRemove"),
			].every((ok) => ok)
		},
	},
	decide: {
		DecideOwnership: (state, cmd) => {
			const next = ownerTransition(state, cmd.operation, cmd.reservation)
			return [new OwnerDecided({ ...next.marks, action: next.action })]
		},
	},
	evolve: {
		"owner.decided": (_state, ev) => ({
			purged: ev.purged,
			staged: ev.staged,
			released: ev.released,
			action: ev.action,
		}),
	},
}) {}
