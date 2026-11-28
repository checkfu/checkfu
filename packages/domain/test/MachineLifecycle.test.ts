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

it("tracks the previous machine and notice through a start, failure or loss", () => {
	for (const state of states) {
		expect(machineStartRequested(state)).toEqual({ ...state, phase: "starting" })
		for (const incarnation of ["original", "replacement"]) {
			const notice = state.notice || (state.incarnation !== "" && state.incarnation !== incarnation)
			expect(machineStarted(state, incarnation)).toEqual(
				state.phase === "starting" ? { phase: "awake", incarnation, notice } : state,
			)
		}
		for (const hasSavedDisk of [false, true]) {
			for (const previousLost of [false, true]) {
				const phase =
					state.incarnation !== "" ? "awake" : state.notice || hasSavedDisk ? "asleep" : "local"
				const expected =
					previousLost && state.incarnation !== ""
						? { phase: "asleep", incarnation: "", notice: true }
						: { ...state, phase }
				expect(machineStartFailed(state, { hasSavedDisk, previousLost })).toEqual(
					state.phase === "starting" ? expected : state,
				)
			}
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
