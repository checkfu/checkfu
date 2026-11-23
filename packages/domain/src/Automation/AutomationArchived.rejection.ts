import * as Domain from "@alchemy.run/domain"
import { AutomationId } from "./Automation.id.ts"

export class AutomationArchivedError extends Domain.Rejection(
	"AutomationArchivedError",
	{ automation_id: AutomationId },
	{ httpApiStatus: 409, description: "Automation is archived and cannot be modified." },
) {}
