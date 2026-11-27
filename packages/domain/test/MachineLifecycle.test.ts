import { expect, it } from "vitest"
import {
	machineNoticeRead,
	machineSlept,
	machineStartFailed,
	machineStartRequested,
	machineStarted,
} from "../src/Workspace/MachineLifecycle.ts"
import type { MachineLifecycle } from "../src/Workspace/MachineLifecycle.ts"

const phases: ReadonlyArray<MachineLifecycle["phase"]> = ["local", "starting", "awake", "asleep"]
const states = phases.flatMap((phase) =>
	["", "original"].flatMap((incarnation) =>
		[false, true].map((notice) => ({ phase, incarnation, notice })),
	),
)

it("keeps the previous machine and notice until a start succeeds or fails", () => {
	for (const state of states) {
		expect(machineStartRequested(state)).toEqual({ ...state, phase: "starting" })
		for (const incarnation of ["original", "replacement"]) {
			const notice = state.notice || (state.incarnation !== "" && state.incarnation !== incarnation)
			expect(machineStarted(state, incarnation)).toEqual(
				state.phase === "starting" ? { phase: "awake", incarnation, notice } : state,
			)
		}
		for (const hasSavedDisk of [false, true]) {
			const phase =
				state.incarnation !== "" ? "awake" : state.notice || hasSavedDisk ? "asleep" : "local"
			expect(machineStartFailed(state, hasSavedDisk)).toEqual(
				state.phase === "starting" ? { ...state, phase } : state,
			)
		}
	}
})

it("keeps a pending notice through sleep and clears it on read", () => {
	for (const state of states) {
		expect(machineSlept(state)).toEqual(
			state.phase === "awake" ? { phase: "asleep", incarnation: "", notice: state.notice } : state,
		)
		expect(machineNoticeRead(state)).toEqual({ ...state, notice: false })
	}
})
