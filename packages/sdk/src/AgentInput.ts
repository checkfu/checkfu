import type { CreateAgentBody } from "./Api.ts"
import type { AgentModel } from "./Schemas.ts"

export const normalizeAgentModel = (input: string | AgentModel): AgentModel =>
	typeof input === "string" ? { id: input } : input

export const normalizeAgentCreateBody = ({
	name,
	model,
	system,
	description,
	mcp_servers,
	tools,
}: CreateAgentBody) => ({
	name,
	model: normalizeAgentModel(model),
	system: system ?? null,
	description: description ?? null,
	...(mcp_servers?.length ? { mcp_servers } : {}),
	...(tools?.length ? { tools } : {}),
})
