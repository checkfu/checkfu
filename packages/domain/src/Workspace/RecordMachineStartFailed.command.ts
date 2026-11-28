import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { MachineId, MachineLifecycleFields } from "./MachineLifecycle.ts"

export class MachineStartFailed extends Domain.Event(
	"machine.start_failed",
	MachineLifecycleFields,
) {}

export class RecordMachineStartFailed extends Domain.Command("RecordMachineStartFailed", {
	input: { machine_id: MachineId, has_saved_disk: Schema.Boolean, previous_lost: Schema.Boolean },
	events: [MachineStartFailed],
}) {}
