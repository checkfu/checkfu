import * as Domain from "@alchemy.run/domain"
import { MachineId, MachineLifecycleFields } from "./MachineLifecycle.ts"

export class MachineSlept extends Domain.Event("machine.slept", MachineLifecycleFields) {}

export class RecordMachineSlept extends Domain.Command("RecordMachineSlept", {
	input: { machine_id: MachineId },
	events: [MachineSlept],
}) {}
