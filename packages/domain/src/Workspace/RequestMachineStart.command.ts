import * as Domain from "@alchemy.run/domain"
import { MachineId, MachineLifecycleFields } from "./MachineLifecycle.ts"

export class MachineStartRequested extends Domain.Event(
	"machine.start_requested",
	MachineLifecycleFields,
) {}

export class RequestMachineStart extends Domain.Command("RequestMachineStart", {
	input: { machine_id: MachineId },
	events: [MachineStartRequested],
}) {}
