import * as Domain from "@alchemy.run/domain"
import {
	MachineId,
	MachineLifecycle,
	initialMachine,
	machineNoticeRead,
	machineSlept,
	machineStartFailed,
	machineStartRequested,
	machineStarted,
} from "./MachineLifecycle.ts"
import { MachineNoticeRead, ReadMachineNotice } from "./ReadMachineNotice.command.ts"
import { MachineSlept, RecordMachineSlept } from "./RecordMachineSlept.command.ts"
import { MachineStartFailed, RecordMachineStartFailed } from "./RecordMachineStartFailed.command.ts"
import { MachineStarted, RecordMachineStarted } from "./RecordMachineStarted.command.ts"
import { MachineStartRequested, RequestMachineStart } from "./RequestMachineStart.command.ts"

const eventState = (_state: MachineLifecycle, event: MachineLifecycle): MachineLifecycle => ({
	phase: event.phase,
	incarnation: event.incarnation,
	notice: event.notice,
})

export class Machine extends Domain.Aggregate("Machine", {
	id: MachineId,
	state: MachineLifecycle,
	initial: initialMachine,
	commands: [
		RequestMachineStart,
		RecordMachineStarted,
		RecordMachineStartFailed,
		RecordMachineSlept,
		ReadMachineNotice,
	],
	keyOf: (command) => command.machine_id,
	invariants: {
		IdleMachinesHaveNoIncarnation: (state) =>
			(state.phase !== "local" && state.phase !== "asleep") || state.incarnation === "",
		AnAwakeMachineHasAnIncarnation: (state) => state.phase !== "awake" || state.incarnation !== "",
		ALocalMachineHasNoNotice: (state) => state.phase !== "local" || !state.notice,
	},
	transitions: {
		AStartEndsWithItsResult: ({ before, after, command }) =>
			before.phase !== "starting" ||
			(after.phase !== "starting") ===
				[command._tag === "RecordMachineStarted", command._tag === "RecordMachineStartFailed"].some(
					(ok) => ok,
				),
		AReplacementRaisesTheNotice: ({ before, after, command }) => {
			if (before.notice) {
				return true
			}
			if (command._tag === "RecordMachineStartFailed") {
				return (
					after.notice ===
					(before.phase === "starting" && before.incarnation !== "" && command.previous_lost)
				)
			}
			if (command._tag !== "RecordMachineStarted") {
				return !after.notice
			}
			return (
				after.notice ===
				[
					before.phase === "starting",
					before.incarnation !== "",
					before.incarnation !== command.incarnation,
				].every((ok) => ok)
			)
		},
		AFailedStartThatLostTheMachineLeavesItAsleep: ({ before, after, command }) =>
			command._tag !== "RecordMachineStartFailed" ||
			!command.previous_lost ||
			before.phase !== "starting" ||
			before.incarnation === "" ||
			(after.phase === "asleep" && after.incarnation === "" && after.notice),
		OnlyReadingClearsTheNotice: ({ before, after, command }) =>
			!before.notice || after.notice || command._tag === "ReadMachineNotice",
		OnlyAnAwakeMachineSleeps: ({ before, after, command }) => {
			if (command._tag !== "RecordMachineSlept") {
				return true
			}
			return before.phase === "awake"
				? after.phase === "asleep"
				: [
						after.phase === before.phase,
						after.incarnation === before.incarnation,
						after.notice === before.notice,
					].every((ok) => ok)
		},
	},
	decide: {
		RequestMachineStart: (state) =>
			state.phase === "starting" ? [] : [new MachineStartRequested(machineStartRequested(state))],
		RecordMachineStarted: (state, cmd) =>
			state.phase === "starting"
				? [new MachineStarted(machineStarted(state, cmd.incarnation))]
				: [],
		RecordMachineStartFailed: (state, cmd) =>
			state.phase === "starting"
				? [
						new MachineStartFailed(
							machineStartFailed(state, {
								hasSavedDisk: cmd.has_saved_disk,
								previousLost: cmd.previous_lost,
							}),
						),
					]
				: [],
		RecordMachineSlept: (state) =>
			state.phase === "awake" ? [new MachineSlept(machineSlept(state))] : [],
		ReadMachineNotice: (state) =>
			state.notice ? [new MachineNoticeRead(machineNoticeRead(state))] : [],
	},
	evolve: {
		"machine.start_requested": eventState,
		"machine.started": eventState,
		"machine.start_failed": eventState,
		"machine.slept": eventState,
		"machine.notice_read": eventState,
	},
}) {}
