import { automationProjectFiles } from "@checkfu/authoring/document"
import { archiveProject, downloadProject } from "./agent-export.ts"
import { ApiError, checkfu, deploymentApiUrl } from "./api.ts"

const requireExportDependency = <T>(read: Promise<T>, unavailable: string) =>
	read.catch((error: unknown) => {
		if (error instanceof ApiError && error.status === 404) {
			throw new Error(unavailable)
		}
		throw error
	})

export const exportSavedAutomation = async (id: string): Promise<void> => {
	const [automation, apiUrl] = await Promise.all([
		checkfu.automations.retrieve(id),
		deploymentApiUrl(),
	])
	if (automation.archived_at !== null) {
		throw new Error("Archived automations cannot be exported.")
	}
	const pin = automation.agent
	const agentMessage = `Agent ${pin.id} version ${pin.version} is unavailable.`
	const environmentMessage = `Environment ${automation.environment_id} is unavailable.`
	const [agent, environment] = await Promise.all([
		requireExportDependency(
			checkfu.agents.retrieve(pin.id, { version: pin.version }),
			agentMessage,
		),
		requireExportDependency(
			checkfu.environments.retrieve(automation.environment_id),
			environmentMessage,
		),
	])
	if (agent.id !== pin.id || agent.version !== pin.version || agent.archived_at !== null) {
		throw new Error(agentMessage)
	}
	if (environment.id !== automation.environment_id || environment.archived_at !== null) {
		throw new Error(environmentMessage)
	}
	downloadProject(archiveProject(await automationProjectFiles(automation, apiUrl)))
}
