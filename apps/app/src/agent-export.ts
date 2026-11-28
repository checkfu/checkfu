import { agentProjectFiles } from "@checkfu/authoring/document"
import type { JsonAgent } from "@checkfu/sdk/client"
import { strToU8, zipSync } from "fflate"

export const archiveProject = (project: {
	readonly stem: string
	readonly files: Readonly<Record<string, string>>
}) => {
	const files = Object.fromEntries(
		Object.entries(project.files).map(([path, text]) => [path, strToU8(text)]),
	)
	return { filename: `${project.stem}.zip`, contents: zipSync(files) }
}

export const agentProjectArchive = async (agent: JsonAgent, baseUrl: string) =>
	archiveProject(await agentProjectFiles(agent, baseUrl))

export const downloadProject = (archive: ReturnType<typeof archiveProject>): void => {
	const url = URL.createObjectURL(
		new Blob([new Uint8Array(archive.contents)], { type: "application/zip" }),
	)
	const link = document.createElement("a")
	link.href = url
	link.download = archive.filename
	try {
		link.click()
	} finally {
		URL.revokeObjectURL(url)
	}
}

export const downloadAgentProject = async (agent: JsonAgent, baseUrl: string): Promise<void> =>
	downloadProject(await agentProjectArchive(agent, baseUrl))
