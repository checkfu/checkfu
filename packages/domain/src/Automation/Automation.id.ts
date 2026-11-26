import { AutomationId } from "@checkfu/sdk/Schemas"
import { SessionId } from "../Session/Session.id.ts"

export { AutomationId }

export const automationRunId = (automationId: string, run: number): string =>
	`arun_${automationId}_${run}`

export const sessionIdOfNextRun = (automation_id: AutomationId, runs: number): SessionId =>
	SessionId.make(`sess_${automation_id}_${runs + 1}`)
