import { evaluateMcpPermission } from "@checkfu/domain/Mcp/McpServers"
import type { McpServerBinding } from "@checkfu/domain/Mcp/McpServers"
import { isJsonValue } from "@earendil-works/chord/json"
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable"
import * as Schema from "effect/Schema"
import type { McpCallOutcome, McpToolDescriptor } from "../Connection/McpTools.ts"
import type { McpCall, McpCallResult } from "./PiMcpStore.ts"
import { MODEL_TEXT_LIMITS, boundModelOutput } from "./PiToolText.ts"

export const MCP_EXTENSION_PREFIX = "checkfu.mcp."

// What every model provider accepts as a tool name.
const MODEL_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u

export const mcpToolName = (server: string, tool: string): string =>
	`mcp__${server}__${tool.replaceAll(/[^A-Za-z0-9_-]/gu, "_")}`

const isJsonObject = Schema.is(Schema.JsonObject)

/**
 * Pi checks arguments against the server's schema and cannot follow a
 * reference to another document, so it would refuse every call to such a
 * tool. Whatever such a reference describes is accepted as it comes; the
 * server still checks it.
 */
export const withoutRemoteReferences = (schema: Schema.Json): Schema.Json => {
	if (Array.isArray(schema)) {
		return schema.map(withoutRemoteReferences)
	}
	if (!isJsonObject(schema)) {
		return schema
	}
	const { $ref: reference, description } = schema
	if (typeof reference === "string" && !reference.startsWith("#")) {
		return typeof description === "string" ? { description } : {}
	}
	return Object.fromEntries(
		Object.entries(schema).map(([key, value]) => [key, withoutRemoteReferences(value)]),
	)
}

const withoutRemoteReferencesIn = (schema: Schema.JsonObject): Schema.JsonObject => {
	const open = withoutRemoteReferences(schema)
	return isJsonObject(open) ? open : {}
}

const imageNote = (mimeType: string) => `[${mimeType} image]`

const UNREACHABLE: McpCallOutcome = {
	ok: false,
	reason: "failed",
	message: "The MCP server's connection could not be reached.",
}

export interface McpServerTools {
	readonly binding: McpServerBinding
	/** The tools the server listed; null while it has not been reached. */
	readonly tools: ReadonlyArray<McpToolDescriptor> | null
	/** Why the server's tools are not offered, when they could not be kept. */
	readonly unavailable?: string | null
}

export interface McpCalls {
	readonly call: (
		binding: McpServerBinding,
		tool: string,
		args: Schema.JsonObject,
	) => Promise<McpCallOutcome>
	readonly began: (call: McpCall) => void
	readonly ended: (callId: string, result: McpCallResult) => void
}

const INTERRUPTED = {
	output: [{ type: "text" as const, text: "The turn was interrupted before this call ran." }],
	isError: true,
}

/**
 * Which of the servers' tools run on their own and which ask a person first,
 * by the name the model calls them. Two tools that come out under one name
 * share the first one's answer, as they share its registration.
 */
export const mcpToolPermissions = (
	servers: ReadonlyArray<McpServerTools>,
): Map<string, { readonly server: string; readonly tool: string; readonly ask: boolean }> => {
	const permissions = new Map<
		string,
		{ readonly server: string; readonly tool: string; readonly ask: boolean }
	>()
	for (const { binding, tools } of servers) {
		for (const tool of tools ?? []) {
			const name = mcpToolName(binding.name, tool.name)
			if (!permissions.has(name)) {
				permissions.set(name, {
					server: binding.name,
					tool: tool.name,
					ask:
						evaluateMcpPermission(binding.permissions, tool.name, tool.readOnly === true) === "ask",
				})
			}
		}
	}
	return permissions
}

/**
 * One server's tools as a Pi extension. Scripts find and call them by
 * namespace; the model is offered one only after tool search loads it, and
 * never one whose name a provider would refuse.
 */
export const mcpExtension = (
	{ binding, tools, unavailable }: McpServerTools,
	calls: McpCalls,
): Extension => {
	const { host } = new URL(binding.url)
	const names = new Set<string>()
	const registrations: Array<ToolRegistration> = []
	for (const tool of tools ?? []) {
		const name = mcpToolName(binding.name, tool.name)
		if (names.has(name)) {
			continue
		}
		names.add(name)
		const outputSchema =
			tool.outputSchema === undefined ? undefined : withoutRemoteReferences(tool.outputSchema)
		registrations.push({
			name,
			description: tool.description,
			parameters: withoutRemoteReferencesIn(tool.inputSchema),
			...(isJsonObject(outputSchema) ? { structuredOutputSchema: outputSchema } : {}),
			deferred: true,
			outputLimits: MODEL_TEXT_LIMITS,
			...(MODEL_TOOL_NAME.test(name) ? {} : { callers: ["tools"] as const }),
			execute: async (args, api, context) => {
				// An interrupted turn sends nothing more to the server.
				if (context.abortSignal?.aborted === true) {
					return INTERRUPTED
				}
				const input = isJsonObject(args) ? args : {}
				// A call that had to ask is already in the ledger, marked so; this leaves it as it is.
				calls.began({
					call_id: api.callId,
					server: binding.name,
					tool: tool.name,
					input,
					permission: "allow",
				})
				const outcome = await calls.call(binding, tool.name, input).catch(() => UNREACHABLE)
				if (!outcome.ok) {
					const content = [{ type: "text" as const, text: outcome.message }]
					calls.ended(api.callId, { content, is_error: true })
					return { output: content, isError: true }
				}
				// Bounded here, so Pi never cuts a JSON document part way through.
				const output = boundModelOutput(
					outcome.content.map((block) =>
						block.type === "text"
							? { type: "text" as const, text: block.text }
							: { type: "image" as const, data: block.data, mimeType: block.mimeType },
					),
					`The result of ${tool.name}`,
				)
				calls.ended(api.callId, {
					content: output.map((block) =>
						block.type === "text" ? block : { type: "text", text: imageNote(block.mimeType) },
					),
					is_error: outcome.isError,
				})
				return {
					output,
					isError: outcome.isError,
					...(isJsonObject(outputSchema) && isJsonValue(outcome.structuredContent)
						? { structuredOutput: outcome.structuredContent }
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
				unavailable !== null && unavailable !== undefined
					? `MCP server at ${host}. Its tools are not available: ${unavailable}.`
					: tools === null
						? `MCP server at ${host}. It could not be reached, so its tools are not available yet.`
						: `MCP server at ${host}.`,
		},
		tools: registrations,
	}
}

const SUPERSEDED: McpCallOutcome = {
	ok: false,
	reason: "failed",
	message: "This turn is no longer the session's current one, so the call was not sent.",
}

/**
 * A turn is abandoned without waiting for its harness to stop, so its script
 * may still be calling tools after the session moved on. Such a call is
 * answered here and never reaches the server.
 */
export const fencedMcpCall =
	(admitted: () => Promise<boolean>, call: McpCalls["call"]): McpCalls["call"] =>
	async (binding, tool, args) =>
		(await admitted()) ? call(binding, tool, args) : SUPERSEDED
