import type { AgentTool, McpServerBinding } from "@checkfu/domain/Mcp/McpServers"
import type { McpToolOf } from "@checkfu/domain/Session/ToolEventBounds"
import { isJsonValue } from "@earendil-works/chord/json"
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"
import { McpToolDescriptors } from "./PiMcpTypes.ts"
import type { McpCallOutcome, McpListOutcome, McpToolDescriptor } from "./PiMcpTypes.ts"
import { mcpPermission } from "./PiActions.ts"
import type { Permission } from "./PiActions.ts"
import { assignToolNames } from "./PiToolNames.ts"
import type { ToolNames } from "./PiToolNames.ts"
import { MODEL_TEXT_LIMITS, boundModelOutput } from "./PiToolText.ts"
import { schemaFault } from "./PiSchemaFault.ts"

export const MCP_EXTENSION_PREFIX = "checkfu.mcp."

export const MAX_TOOL_LIST_BYTES = 256 * 1024

export const mcpToolPrefix = (server: string): string => `mcp__${server}__`

export type McpServerTools =
	| { readonly status: "listed"; readonly tools: ReadonlyArray<McpToolDescriptor> }
	| { readonly status: "unavailable"; readonly reason: string }

const toolsJson = Schema.fromJsonString(McpToolDescriptors)
const encodeTools = Schema.encodeSync(toolsJson)
const decodeTools = Schema.decodeUnknownOption(toolsJson)

export const cacheableTools = (
	listed: McpListOutcome,
): { readonly text: string } | { readonly unavailable: string; readonly retry: boolean } => {
	if (!listed.ok) {
		return listed.tooLarge === true
			? {
					unavailable: `its tool list is more than the ${MAX_TOOL_LIST_BYTES} bytes or the pages a session reads`,
					retry: false,
				}
			: { unavailable: `it could not be reached (${listed.message})`, retry: true }
	}
	if (listed.tools === undefined) {
		return { unavailable: "its tool list could not be read", retry: false }
	}
	const text = encodeTools(listed.tools)
	const bytes = new TextEncoder().encode(text).byteLength
	return bytes <= MAX_TOOL_LIST_BYTES
		? { text }
		: {
				unavailable: `its tool list is ${bytes} bytes, more than the ${MAX_TOOL_LIST_BYTES} a session keeps`,
				retry: false,
			}
}

export const cachedTools = (text: string): McpServerTools =>
	Option.match(decodeTools(text), {
		onSome: (tools) => ({ status: "listed", tools }),
		onNone: () => ({ status: "unavailable", reason: "its stored tool list could not be read" }),
	})

export interface McpRegistered {
	readonly binding: McpServerBinding
	readonly tool: McpToolDescriptor
	readonly names: ToolNames
	readonly permission: Permission
}

export const mcpRegistry = (
	servers: ReadonlyArray<{ readonly binding: McpServerBinding; readonly tools: McpServerTools }>,
	agentTools: ReadonlyArray<AgentTool> = [],
) => {
	const offered = servers.flatMap(({ binding, tools }) =>
		tools.status === "listed"
			? tools.tools.map((tool) => ({ binding, tool, prefix: mcpToolPrefix(binding.name) }))
			: [],
	)
	const offeredAs = new Map<string, Map<string, (typeof offered)[number]>>()
	for (const entry of offered) {
		const ofServer = offeredAs.get(entry.prefix) ?? new Map<string, (typeof offered)[number]>()
		offeredAs.set(entry.prefix, ofServer)
		if (!ofServer.has(entry.tool.name)) {
			ofServer.set(entry.tool.name, entry)
		}
	}
	const byName = new Map<string, McpRegistered>()
	for (const names of assignToolNames([
		...offered.map(({ prefix, tool }) => ({ prefix, name: tool.name })),
		...agentTools.flatMap((tool) =>
			tool.type === "custom" ? [{ prefix: "", name: tool.name, kept: true }] : [],
		),
	])) {
		const entry = offeredAs.get(names.prefix)?.get(names.name)
		if (entry !== undefined) {
			byName.set(names.model, {
				binding: entry.binding,
				tool: entry.tool,
				names,
				permission: mcpPermission(agentTools, entry.binding.name, entry.tool),
			})
		}
	}
	const toolOf: McpToolOf = (name) => {
		const registered = byName.get(name)
		return registered === undefined
			? undefined
			: {
					server: registered.binding.name,
					tool: registered.names.public,
					permission: registered.permission,
				}
	}
	return { byName, toolOf }
}

export type McpRegistry = ReturnType<typeof mcpRegistry>

const isJsonObject = Schema.is(Schema.JsonObject)

const OPEN_INPUT: Schema.JsonObject = { type: "object" }
const UNCHECKED =
	"The input schema this tool's server published could not be used, so arguments are sent to it unchecked."

export type McpDispatch = (
	binding: McpServerBinding,
	tool: McpToolDescriptor,
	args: Schema.JsonObject,
	signal: AbortSignal | undefined,
) => Promise<McpCallOutcome>

export const mcpExtension = (
	binding: McpServerBinding,
	tools: McpServerTools,
	registry: McpRegistry,
	dispatch: McpDispatch,
): Extension => {
	const { host } = new URL(binding.url)
	const registrations: Array<ToolRegistration> = []
	for (const [name, { binding: owner, tool }] of registry.byName) {
		if (owner.name !== binding.name) {
			continue
		}
		const checked = schemaFault(tool.inputSchema) === null
		const outputSchema =
			tool.outputSchema !== undefined && schemaFault(tool.outputSchema) === null
				? tool.outputSchema
				: undefined
		registrations.push({
			name,
			description: checked ? tool.description : `${tool.description} ${UNCHECKED}`.trim(),
			parameters: checked ? tool.inputSchema : OPEN_INPUT,
			...(outputSchema === undefined ? {} : { structuredOutputSchema: outputSchema }),
			deferred: true,
			outputLimits: MODEL_TEXT_LIMITS,
			execute: async (args, _api, context) => {
				const outcome = await dispatch(
					binding,
					tool,
					isJsonObject(args) ? args : {},
					context.abortSignal,
				)
				if (!outcome.ok) {
					return { output: [{ type: "text" as const, text: outcome.message }], isError: true }
				}
				const structured = isJsonValue(outcome.structuredContent)
					? outcome.structuredContent
					: undefined
				const blocks = outcome.content.map((block) =>
					block.type === "text"
						? { type: "text" as const, text: block.text }
						: { type: "image" as const, data: block.data, mimeType: block.mimeType },
				)
				return {
					output: boundModelOutput(
						blocks.length === 0 && structured !== undefined
							? [{ type: "text" as const, text: JSON.stringify(structured) }]
							: blocks,
						`The result of ${tool.name}`,
					),
					isError: outcome.isError,
					...(outputSchema !== undefined && structured !== undefined
						? { structuredOutput: structured }
						: {}),
				}
			},
		})
	}
	return {
		name: `${MCP_EXTENSION_PREFIX}${binding.name}`,
		namespace: {
			name: binding.name,
			description:
				tools.status === "listed"
					? `MCP server at ${host}.`
					: `MCP server at ${host}. Its tools are not available: ${tools.reason}.`,
		},
		tools: registrations,
	}
}
