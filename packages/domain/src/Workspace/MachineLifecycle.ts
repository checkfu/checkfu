import * as Schema from "effect/Schema"

export const MachineId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))

const Incarnation = Schema.String.check(Schema.isMaxLength(128))
export const ActiveIncarnation = Incarnation.check(Schema.isMinLength(1))

export const MachineLifecycleFields = {
	phase: Schema.Literals(["local", "starting", "awake", "asleep"]),
	incarnation: Incarnation,
	notice: Schema.Boolean,
}

export const MachineLifecycle = Schema.Struct(MachineLifecycleFields)
export type MachineLifecycle = typeof MachineLifecycle.Type

export const initialMachine: MachineLifecycle = { phase: "local", incarnation: "", notice: false }

export const machineStartRequested = (state: MachineLifecycle): MachineLifecycle =>
	state.phase === "starting" ? state : { ...state, phase: "starting" }

export const machineStarted = (state: MachineLifecycle, incarnation: string): MachineLifecycle => {
	if (state.phase !== "starting") {
		return state
	}
	return {
		phase: "awake",
		incarnation,
		notice: state.notice || (state.incarnation !== "" && state.incarnation !== incarnation),
	}
}

export const machineStartFailed = (
	state: MachineLifecycle,
	hasSavedDisk: boolean,
): MachineLifecycle => {
	if (state.phase !== "starting") {
		return state
	}
	if (state.incarnation !== "") {
		return { ...state, phase: "awake" }
	}
	return state.notice || hasSavedDisk ? { ...state, phase: "asleep" } : initialMachine
}

export const machineSlept = (state: MachineLifecycle): MachineLifecycle =>
	state.phase === "awake" ? { ...state, phase: "asleep", incarnation: "" } : state

export const machineNoticeRead = (state: MachineLifecycle): MachineLifecycle =>
	state.notice ? { ...state, notice: false } : state
