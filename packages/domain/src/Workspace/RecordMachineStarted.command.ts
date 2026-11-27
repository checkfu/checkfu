import * as Domain from "@alchemy.run/domain"
import { ActiveIncarnation, MachineId, MachineLifecycleFields } from "./MachineLifecycle.ts"

export class MachineStarted extends Domain.Event("machine.started", MachineLifecycleFields) {}

export class RecordMachineStarted extends Domain.Command("RecordMachineStarted", {
	input: { machine_id: MachineId, incarnation: ActiveIncarnation },
	events: [MachineStarted],
}) {}
