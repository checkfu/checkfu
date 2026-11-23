import * as Domain from "@alchemy.run/domain"
import { AutomationId } from "./Automation.id.ts"

export class AutomationNotFound extends Domain.Rejection(
	"AutomationNotFound",
	{ automation_id: AutomationId },
	{ httpApiStatus: 404, description: "Automation not found." },
) {}
