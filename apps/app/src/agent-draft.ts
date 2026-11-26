import type { CreateAgentBody } from "@checkfu/sdk/Api"
import { canonicalProjectJson } from "@checkfu/authoring/project"
import { normalizeAgentCreateBody } from "@checkfu/sdk/AgentInput"
import type { JsonAgent } from "@checkfu/sdk/client"

export interface AgentDraft extends Pick<CreateAgentBody, "mcp_servers" | "tools"> {
	readonly name: string
	readonly model: string
	readonly system: string | null
	readonly description: string | null
}

export const FIELD_LABELS: Record<keyof AgentDraft, string> = {
	name: "name",
	model: "model",
	system: "system prompt",
	description: "description",
	mcp_servers: "MCP servers",
	tools: "tools",
}

const FIELDS = ["name", "model", "system", "description", "mcp_servers", "tools"] as const

export const emptyDraft: AgentDraft = { name: "", model: "", system: null, description: null }

export const draftOf = (input: CreateAgentBody): AgentDraft => {
	const { model, ...agent } = normalizeAgentCreateBody(input)
	return { ...agent, model: model.id }
}

export const bodyOf = (draft: AgentDraft) => ({
	...draft,
	name: draft.name.trim(),
	model: draft.model.trim(),
})

const sameField = (left: unknown, right: unknown) =>
	left === right || canonicalProjectJson(left) === canonicalProjectJson(right)

const edited = (base: AgentDraft, draft: AgentDraft): ReadonlyArray<keyof AgentDraft> =>
	FIELDS.filter((field) => !sameField(draft[field], base[field]))

const declarationChanges = (before: AgentDraft, draft: AgentDraft) => {
	const mcpServers = draft.mcp_servers ?? []
	const tools = draft.tools ?? []
	return {
		...(sameField(before.mcp_servers ?? [], mcpServers) ? {} : { mcp_servers: mcpServers }),
		...(sameField(before.tools ?? [], tools) ? {} : { tools }),
	}
}

export const changesFrom = (from: JsonAgent, draft: AgentDraft) => {
	const before = draftOf(from)
	const body = bodyOf(draft)
	return {
		...(draft.name === before.name ? {} : { name: body.name }),
		...(draft.model === before.model ? {} : { model: body.model }),
		...(draft.system === before.system ? {} : { system: body.system }),
		...(draft.description === before.description ? {} : { description: body.description }),
		...declarationChanges(before, draft),
	}
}

export const changesFromSource = (from: JsonAgent, source: CreateAgentBody) => {
	const body = normalizeAgentCreateBody(source)
	return {
		...(body.name === from.name ? {} : { name: body.name }),
		...(body.model.id === from.model.id ? {} : { model: body.model }),
		...(body.system === from.system ? {} : { system: body.system }),
		...(body.description === from.description ? {} : { description: body.description }),
		...declarationChanges(draftOf(from), draftOf(body)),
	}
}

export interface Rebased {
	readonly draft: AgentDraft
	readonly overlapping: ReadonlyArray<keyof AgentDraft>
}

export const rebase = (base: JsonAgent, draft: AgentDraft, latest: JsonAgent): Rebased => {
	const mine = new Set(edited(draftOf(base), draft))
	const theirs = new Set(edited(draftOf(base), draftOf(latest)))
	const current = draftOf(latest)
	const pick = <Field extends keyof AgentDraft>(field: Field): AgentDraft[Field] =>
		(mine.has(field) ? draft : current)[field]
	const mcp_servers = pick("mcp_servers")
	const tools = pick("tools")
	return {
		draft: {
			name: pick("name"),
			model: pick("model"),
			system: pick("system"),
			description: pick("description"),
			...(mcp_servers === undefined ? {} : { mcp_servers }),
			...(tools === undefined ? {} : { tools }),
		},
		overlapping: [...mine].filter((field) => theirs.has(field)),
	}
}
