import { canonicalProjectJson } from "@checkfu/authoring/project"
import { normalizeAgentCreateBody } from "@checkfu/sdk/AgentInput"
import type { CreateAgentBody } from "@checkfu/sdk/Api"
import type { JsonAgent } from "@checkfu/sdk/client"
import { parseJsonObject } from "./json-boundary.ts"

type InputSchema = Extract<
	NonNullable<CreateAgentBody["tools"]>[number],
	{ readonly type: "custom" }
>["input_schema"]

export type Policy = "always_allow" | "always_ask"

export const isPolicy = (value: string): value is Policy =>
	value === "always_allow" || value === "always_ask"

type StoredToolset = Extract<JsonAgent["tools"][number], { readonly type: "mcp_toolset" }>
type StoredCustomTool = Extract<JsonAgent["tools"][number], { readonly type: "custom" }>

const schemaText = (schema: unknown): string => JSON.stringify(schema, null, 2)

export interface ToolOverride {
	readonly name: string
	readonly policy: Policy | ""
}

export interface ServerDraft {
	readonly row: string
	readonly name: string
	readonly url: string
	readonly fallback: Policy | ""
	readonly overrides: ReadonlyArray<ToolOverride>
	readonly stored: StoredToolset | undefined
	readonly savedUrl?: string
}

export interface CustomToolDraft {
	readonly name: string
	readonly description: string
	readonly schema: string
	readonly stored?: StoredCustomTool
}

export interface AgentDraft {
	readonly name: string
	readonly model: string
	readonly system: string | null
	readonly description: string | null
	readonly servers: ReadonlyArray<ServerDraft>
	readonly customTools: ReadonlyArray<CustomToolDraft>
	readonly toolOrder: ReadonlyArray<string>
	readonly savedName?: string | undefined
	readonly savedModel?: string | undefined
}

const FIELDS = ["name", "model", "system", "description", "customTools"] as const

const FIELD_LABELS: Record<(typeof FIELDS)[number], string> = {
	name: "name",
	model: "model",
	system: "system prompt",
	description: "description",
	customTools: "custom tools",
}

export const emptyDraft: AgentDraft = {
	name: "",
	model: "",
	system: null,
	description: null,
	servers: [],
	customTools: [],
	toolOrder: [],
}

const same = (a: unknown, b: unknown): boolean =>
	canonicalProjectJson(a) === canonicalProjectJson(b)

const savedRow = (name: string): string => `saved:${name}`

const toolKey = (tool: JsonAgent["tools"][number]): string =>
	tool.type === "custom" ? `custom:${tool.name}` : `mcp:${tool.mcp_server_name}`

export const newServer = (): ServerDraft => ({
	row: `new:${crypto.randomUUID()}`,
	name: "",
	url: "",
	fallback: "",
	overrides: [],
	stored: undefined,
})

const settingsOf = (toolset: StoredToolset | undefined) => ({
	fallback: toolset?.default_config?.permission_policy?.type ?? ("" as const),
	overrides: (toolset?.configs ?? []).map((config): ToolOverride => ({
		name: config.name,
		policy: config.permission_policy?.type ?? "",
	})),
})

export const withServer = (draft: AgentDraft, next: ServerDraft): AgentDraft => ({
	...draft,
	servers: draft.servers.map((server) => (server.row === next.row ? next : server)),
})

export const withoutServer = (draft: AgentDraft, row: string): AgentDraft => ({
	...draft,
	servers: draft.servers.filter((server) => server.row !== row),
})

export const draftOf = (input: CreateAgentBody): AgentDraft => {
	const agent = normalizeAgentCreateBody(input)
	return {
		name: agent.name,
		model: agent.model.id,
		savedName: agent.name,
		savedModel: agent.model.id,
		toolOrder: (agent.tools ?? []).map(toolKey),
		system: agent.system,
		description: agent.description,
		servers: (agent.mcp_servers ?? []).map(({ name, url }) => {
			const toolset = (agent.tools ?? []).flatMap((tool) =>
				tool.type === "mcp_toolset" && tool.mcp_server_name === name ? [tool] : [],
			)[0]
			return {
				row: savedRow(name),
				name,
				url,
				savedUrl: url,
				...settingsOf(toolset),
				stored: toolset,
			}
		}),
		customTools: (agent.tools ?? []).flatMap((tool) =>
			tool.type === "custom"
				? [
						{
							name: tool.name,
							description: tool.description,
							schema: schemaText(tool.input_schema),
							stored: tool,
						},
					]
				: [],
		),
	}
}

const SERVER_NAME = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/u
const CUSTOM_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u

const parseSchema = (text: string): InputSchema | undefined => parseJsonObject<InputSchema>(text)

export interface DraftProblems {
	readonly servers: ReadonlyMap<number, string>
	readonly customTools: ReadonlyMap<number, string>
}

const duplicates = (names: ReadonlyArray<string>, index: number): boolean =>
	names.indexOf(names[index] ?? "") !== index

export const problemsOf = (draft: AgentDraft): DraftProblems => {
	const serverNames = draft.servers.map((server) => server.name.trim())
	const toolNames = draft.customTools.map((tool) => tool.name.trim())
	const servers = new Map<number, string>()
	draft.servers.forEach((server, index) => {
		const name = serverNames[index] ?? ""
		if (name.length > 32 || !SERVER_NAME.test(name)) {
			servers.set(
				index,
				"Use up to 32 letters, digits, hyphens and single underscores, not starting or ending with an underscore.",
			)
		} else if (duplicates(serverNames, index)) {
			servers.set(index, `Another server is already named ${name}.`)
		} else if (server.url.trim() === "") {
			servers.set(index, "Give the server's URL.")
		} else if (server.overrides.some((override) => override.name === "")) {
			servers.set(index, "Name each tool you set a permission for.")
		}
	})
	const customTools = new Map<number, string>()
	draft.customTools.forEach((tool, index) => {
		if (!CUSTOM_TOOL_NAME.test(toolNames[index] ?? "")) {
			customTools.set(index, "Use 1 to 64 letters, digits, underscores or hyphens.")
		} else if (duplicates(toolNames, index)) {
			customTools.set(index, `Another custom tool is already named ${toolNames[index]}.`)
		} else if (tool.description.trim() === "") {
			customTools.set(index, "Describe what the tool does; the model reads it.")
		} else if (parseSchema(tool.schema) === undefined) {
			customTools.set(index, "The input schema must be a JSON object.")
		} else if (parseSchema(tool.schema)?.["type"] !== "object") {
			customTools.set(index, 'The input schema must have "type": "object".')
		}
	})
	return { servers, customTools }
}

export const hasProblems = (problems: DraftProblems): boolean =>
	problems.servers.size > 0 || problems.customTools.size > 0

const exactOrTrimmed = (value: string, saved: string | undefined): string =>
	value === saved ? value : value.trim()

const serverOf = (server: ServerDraft, preserveSaved: boolean) => ({
	type: "url" as const,
	name: server.name.trim(),
	url: exactOrTrimmed(server.url, preserveSaved ? server.savedUrl : undefined),
})

const serversOf = (draft: AgentDraft, preserveSaved: boolean) =>
	draft.servers.map((server) => serverOf(server, preserveSaved))

const toolsetOf = (server: ServerDraft, preserveEmpty: boolean) => {
	const name = server.name.trim()
	const settings = { fallback: server.fallback, overrides: server.overrides }
	const empty = server.fallback === "" && server.overrides.length === 0
	if (
		server.stored !== undefined &&
		(preserveEmpty || !empty) &&
		same(settings, settingsOf(server.stored))
	) {
		return [{ ...server.stored, mcp_server_name: name }]
	}
	if (empty) {
		return []
	}
	return [
		{
			type: "mcp_toolset" as const,
			mcp_server_name: name,
			...(server.fallback === ""
				? {}
				: { default_config: { permission_policy: { type: server.fallback } } }),
			...(server.overrides.length === 0
				? {}
				: {
						configs: server.overrides.map((override) =>
							override.policy === ""
								? { name: override.name }
								: { name: override.name, permission_policy: { type: override.policy } },
						),
					}),
		},
	]
}

const customToolOf = (tool: CustomToolDraft): StoredCustomTool => ({
	type: "custom",
	name: tool.name === tool.stored?.name ? tool.name : tool.name.trim(),
	description:
		tool.description === tool.stored?.description ? tool.description : tool.description.trim(),
	input_schema: parseSchema(tool.schema) ?? {},
})

const toolsOf = (draft: AgentDraft, preserveSaved: boolean) => {
	const candidates = [
		...draft.servers.flatMap((server) =>
			toolsetOf(server, preserveSaved).map((tool) => ({ tool, saved: server.stored })),
		),
		...draft.customTools.map((custom) => ({ tool: customToolOf(custom), saved: custom.stored })),
	]
	if (preserveSaved) {
		const positions = new Map(draft.toolOrder.map((key, index) => [key, index]))
		const position = ({ tool, saved }: (typeof candidates)[number]): number =>
			positions.get(toolKey(saved ?? tool)) ?? draft.toolOrder.length
		candidates.sort((a, b) => position(a) - position(b))
	}
	return candidates.map(({ tool }) => tool)
}

export const bodyOf = (draft: AgentDraft) => ({
	name: draft.name.trim(),
	model: draft.model.trim(),
	system: draft.system,
	description: draft.description,
	mcp_servers: serversOf(draft, false),
	tools: toolsOf(draft, false),
})

export const editSourceBody = (draft: AgentDraft): CreateAgentBody => ({
	name: exactOrTrimmed(draft.name, draft.savedName),
	model: exactOrTrimmed(draft.model, draft.savedModel),
	system: draft.system,
	description: draft.description,
	mcp_servers: serversOf(draft, true),
	tools: toolsOf(draft, true),
})

export const changesFrom = (base: JsonAgent, draft: AgentDraft) =>
	changesFromSource(base, editSourceBody(draft))

export const changesFromSource = (from: JsonAgent, source: CreateAgentBody) => {
	const body = normalizeAgentCreateBody(source)
	const servers = body.mcp_servers ?? []
	const tools = body.tools ?? []
	return {
		...(body.name === from.name ? {} : { name: body.name }),
		...(body.model.id === from.model.id ? {} : { model: body.model }),
		...(body.system === from.system ? {} : { system: body.system }),
		...(body.description === from.description ? {} : { description: body.description }),
		...(same(servers, from.mcp_servers) && same(tools, from.tools)
			? {}
			: { mcp_servers: servers, tools }),
	}
}

export interface Rebased {
	readonly draft: AgentDraft
	readonly overlapping: ReadonlyArray<string>
	readonly orphaned: ReadonlyArray<string>
}

const sameServer = (a: ServerDraft, b: ServerDraft): boolean =>
	same(serverOf(a, true), serverOf(b, true)) && same(toolsetOf(a, true), toolsetOf(b, true))

const customToolsByName = (draft: AgentDraft) =>
	draft.customTools.map(customToolOf).sort((a, b) => a.name.localeCompare(b.name))

const sameField = (a: AgentDraft, b: AgentDraft, field: (typeof FIELDS)[number]): boolean => {
	switch (field) {
		case "customTools":
			return same(customToolsByName(a), customToolsByName(b))
		case "name":
			return exactOrTrimmed(a.name, a.savedName) === exactOrTrimmed(b.name, b.savedName)
		case "model":
			return exactOrTrimmed(a.model, a.savedModel) === exactOrTrimmed(b.model, b.savedModel)
		default:
			return a[field] === b[field]
	}
}

const sameRelativeOrder = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => {
	const inA = new Set(a)
	const inB = new Set(b)
	return same(
		a.filter((key) => inB.has(key)),
		b.filter((key) => inA.has(key)),
	)
}

const reconcileOrder = (
	base: ReadonlyArray<string>,
	mine: ReadonlyArray<string>,
	theirs: ReadonlyArray<string>,
) => {
	const reordered = !sameRelativeOrder(mine, base)
	const chosen = [...(reordered ? mine : theirs)]
	const other = reordered ? theirs : mine
	let next = chosen.length
	for (const key of [...other].reverse()) {
		const existing = chosen.indexOf(key)
		if (existing === -1) {
			chosen.splice(next, 0, key)
		} else {
			next = existing
		}
	}
	return {
		chosen,
		reordered,
		conflicted: reordered && !sameRelativeOrder(theirs, base) && !sameRelativeOrder(mine, theirs),
	}
}

export const rebase = (base: JsonAgent, draft: AgentDraft, latest: JsonAgent): Rebased => {
	const was = draftOf(base)
	const current = draftOf(latest)
	const tools = reconcileOrder(was.toolOrder, draft.toolOrder, current.toolOrder)
	const known = new Set(was.servers.map((server) => server.row))
	const newServerRows = new Map(
		current.servers.filter(({ row }) => !known.has(row)).map(({ name, row }) => [name, row]),
	)
	const newNames = draft.servers.filter(({ row }) => !known.has(row)).map(({ name }) => name.trim())
	const editedServers = draft.servers.map((server) => {
		const name = server.name.trim()
		const row = newServerRows.get(name)
		return row === undefined ||
			known.has(server.row) ||
			newNames.indexOf(name) !== newNames.lastIndexOf(name)
			? server
			: { ...server, row }
	})
	const rows = (servers: AgentDraft["servers"]) => servers.map(({ row }) => row)
	const serverOrder = reconcileOrder(rows(was.servers), rows(editedServers), rows(current.servers))
	const fields = FIELDS.filter(
		(field) => !sameField(draft, was, field) && !sameField(draft, current, field),
	)
	const mine = new Map(editedServers.map((server) => [server.row, server]))
	const theirs = new Map(current.servers.map((server) => [server.row, server]))
	const carried = new Map<string, ServerDraft | undefined>()
	const overlapping: Array<string> = []
	const orphaned: Array<string> = []
	for (const server of was.servers) {
		const my = mine.get(server.row)
		const their = theirs.get(server.row)
		if (my !== undefined && sameServer(my, server)) {
			carried.set(server.row, their)
		} else {
			carried.set(
				server.row,
				my !== undefined && their !== undefined && sameServer(my, their) ? their : my,
			)
			if (their === undefined) {
				if (my !== undefined) {
					orphaned.push(server.name)
				}
			} else if (!sameServer(their, server) && (my === undefined || !sameServer(my, their))) {
				overlapping.push(`MCP server ${server.name}`)
			}
		}
	}
	for (const server of editedServers) {
		if (!known.has(server.row)) {
			const their = theirs.get(server.row)
			if (their !== undefined && !sameServer(server, their)) {
				overlapping.push(`MCP server ${server.name}`)
			}
		}
	}
	const changedDraft = (field: (typeof FIELDS)[number]): AgentDraft =>
		fields.includes(field) ? draft : current
	return {
		draft: {
			name: changedDraft("name").name,
			savedName: changedDraft("name").savedName,
			model: changedDraft("model").model,
			savedModel: changedDraft("model").savedModel,
			system: changedDraft("system").system,
			description: changedDraft("description").description,
			servers: [
				...serverOrder.chosen.flatMap((row) => {
					const kept = known.has(row) ? carried.get(row) : (mine.get(row) ?? theirs.get(row))
					if (kept === undefined) {
						return []
					}
					return known.has(row) && !theirs.has(row)
						? serverOrder.reordered
							? [{ ...kept, row: `kept:${row}` }]
							: []
						: [kept]
				}),
				...(serverOrder.reordered
					? []
					: was.servers.flatMap((server) => {
							const kept = theirs.has(server.row) ? undefined : carried.get(server.row)
							return kept === undefined ? [] : [{ ...kept, row: `kept:${kept.row}` }]
						})),
			],
			customTools: changedDraft("customTools").customTools,
			toolOrder: tools.chosen,
		},
		overlapping: [
			...fields.flatMap((field) => (sameField(current, was, field) ? [] : [FIELD_LABELS[field]])),
			...(tools.conflicted ? ["tool order"] : []),
			...(serverOrder.conflicted ? ["MCP server order"] : []),
			...overlapping,
		],
		orphaned,
	}
}
