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
	readonly system: string
	readonly description: string
	readonly servers: ReadonlyArray<ServerDraft>
	readonly customTools: ReadonlyArray<CustomToolDraft>
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
	system: "",
	description: "",
	servers: [],
	customTools: [],
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const savedRow = (name: string): string => `saved:${name}`

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

export const draftOf = (agent: JsonAgent): AgentDraft => ({
	name: agent.name,
	model: agent.model.id,
	system: agent.system ?? "",
	description: agent.description ?? "",
	servers: agent.mcp_servers.map(({ name, url }) => {
		const toolset = agent.tools.flatMap((tool) =>
			tool.type === "mcp_toolset" && tool.mcp_server_name === name ? [tool] : [],
		)[0]
		return { row: savedRow(name), name, url, ...settingsOf(toolset), stored: toolset }
	}),
	customTools: agent.tools.flatMap((tool) =>
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
})

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

const serversOf = (draft: AgentDraft) =>
	draft.servers.map((server) => ({
		type: "url" as const,
		name: server.name.trim(),
		url: server.url.trim(),
	}))

const toolsetOf = (server: ServerDraft) => {
	const name = server.name.trim()
	const settings = { fallback: server.fallback, overrides: server.overrides }
	if (server.fallback === "" && server.overrides.length === 0) {
		return []
	}
	if (server.stored !== undefined && same(settings, settingsOf(server.stored))) {
		return [{ ...server.stored, mcp_server_name: name }]
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

const unedited = (tool: CustomToolDraft): StoredCustomTool | undefined =>
	tool.stored !== undefined &&
	tool.name === tool.stored.name &&
	tool.description === tool.stored.description &&
	tool.schema === schemaText(tool.stored.input_schema)
		? tool.stored
		: undefined

const toolsOf = (draft: AgentDraft) => [
	...draft.servers.flatMap(toolsetOf),
	...draft.customTools.map(
		(tool) =>
			unedited(tool) ?? {
				type: "custom" as const,
				name: tool.name.trim(),
				description: tool.description.trim(),
				input_schema: parseSchema(tool.schema) ?? {},
			},
	),
]

export const bodyOf = (draft: AgentDraft) => ({
	name: draft.name.trim(),
	model: draft.model.trim(),
	system: draft.system === "" ? null : draft.system,
	description: draft.description === "" ? null : draft.description,
	mcp_servers: serversOf(draft),
	tools: toolsOf(draft),
})

export const changesFrom = (from: JsonAgent, draft: AgentDraft) => {
	const before = draftOf(from)
	const body = bodyOf(draft)
	const was = bodyOf(before)
	return {
		...(draft.name === before.name ? {} : { name: body.name }),
		...(draft.model === before.model ? {} : { model: body.model }),
		...(draft.system === before.system ? {} : { system: body.system }),
		...(draft.description === before.description ? {} : { description: body.description }),
		...(same(body.mcp_servers, was.mcp_servers) && same(body.tools, was.tools)
			? {}
			: { mcp_servers: body.mcp_servers, tools: body.tools }),
	}
}

export interface Rebased {
	readonly draft: AgentDraft
	readonly overlapping: ReadonlyArray<string>
	readonly orphaned: ReadonlyArray<string>
}

const sameServer = (a: ServerDraft, b: ServerDraft): boolean =>
	same({ ...a, row: "" }, { ...b, row: "" })

export const rebase = (base: JsonAgent, draft: AgentDraft, latest: JsonAgent): Rebased => {
	const was = draftOf(base)
	const current = draftOf(latest)
	const fields = FIELDS.filter((field) => !same(draft[field], was[field]))
	const mine = new Map(draft.servers.map((server) => [server.row, server]))
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
			carried.set(server.row, my)
			if (their === undefined) {
				if (my !== undefined) {
					orphaned.push(server.name)
				}
			} else if (!sameServer(their, server) && (my === undefined || !sameServer(my, their))) {
				overlapping.push(`MCP server ${server.name}`)
			}
		}
	}
	const known = new Set(was.servers.map((server) => server.row))
	const pick = <K extends (typeof FIELDS)[number]>(field: K): AgentDraft[K] =>
		(fields.includes(field) ? draft : current)[field]
	return {
		draft: {
			name: pick("name"),
			model: pick("model"),
			system: pick("system"),
			description: pick("description"),
			servers: [
				...current.servers.flatMap((server) => {
					const kept = known.has(server.row) ? carried.get(server.row) : server
					return kept === undefined ? [] : [kept]
				}),
				...was.servers.flatMap((server) => {
					const kept = theirs.has(server.row) ? undefined : carried.get(server.row)
					return kept === undefined ? [] : [{ ...kept, row: `kept:${kept.row}` }]
				}),
				...draft.servers.filter((server) => !known.has(server.row)),
			],
			customTools: pick("customTools"),
		},
		overlapping: [
			...fields.flatMap((field) => (same(current[field], was[field]) ? [] : [FIELD_LABELS[field]])),
			...overlapping,
		],
		orphaned,
	}
}
