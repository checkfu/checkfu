import { agentProjectFiles } from "@checkfu/authoring/document"
import type { JsonAgent } from "@checkfu/sdk/client"
import { strToU8, zipSync } from "fflate"

export const agentProjectArchive = async (agent: JsonAgent, baseUrl: string) => {
	const project = await agentProjectFiles(agent, baseUrl)
	const files = Object.fromEntries(
		Object.entries(project.files).map(([path, text]) => [path, strToU8(text)]),
	)
	return { filename: `${project.stem}.zip`, contents: zipSync(files) }
}

export const downloadAgentProject = async (agent: JsonAgent, baseUrl: string): Promise<void> => {
	const archive = await agentProjectArchive(agent, baseUrl)
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
