import * as Domain from "@alchemy.run/domain"
import { MachineId, MachineLifecycleFields } from "./MachineLifecycle.ts"

export class MachineNoticeRead extends Domain.Event(
	"machine.notice_read",
	MachineLifecycleFields,
) {}

export class ReadMachineNotice extends Domain.Command("ReadMachineNotice", {
	input: { machine_id: MachineId },
	events: [MachineNoticeRead],
}) {}
