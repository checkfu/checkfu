import { McpServerBinding } from "@checkfu/domain/Mcp/McpServers"
import {
	MAX_TOOL_INPUT_JSON_LENGTH,
	MAX_TOOL_RESULT_TEXT_LENGTH,
	TextBlock,
} from "@checkfu/domain/Session/SessionTypes"
import * as Schema from "effect/Schema"
import { McpToolDescriptors } from "../Connection/McpTools.ts"
import type { McpToolDescriptor } from "../Connection/McpTools.ts"
import type { ServedToolCalls } from "./PiDurableEngine.ts"
import type { SqlExecutor as SqlQueries } from "./TurnFence.ts"

export interface SqlExecutor extends SqlQueries {
	transaction(run: () => void): void
}
import { truncateText } from "@checkfu/domain/Session/TextBounds"

export interface McpCall {
	readonly call_id: string
	readonly server: string
	readonly tool: string
	readonly input: Schema.JsonObject
	/** Whether the call ran on its own or had to ask a person first. */
	readonly permission: "allow" | "ask"
}

const McpCallResult = Schema.Struct({
	content: Schema.Array(TextBlock),
	is_error: Schema.Boolean,
})
export type McpCallResult = typeof McpCallResult.Type

const ServerRow = Schema.Struct({
	binding: Schema.fromJsonString(Schema.toCodecJson(McpServerBinding)),
	tools: Schema.NullOr(Schema.fromJsonString(Schema.toCodecJson(McpToolDescriptors))),
	unavailable: Schema.NullOr(Schema.String),
})

/**
 * Bytes of one server's tool list as stored: one SQLite row, which holds at
 * most 2 MB, less room for the row's other columns.
 */
export const MAX_MCP_TOOL_LIST_BYTES = 1_500_000

const CallRow = Schema.Struct({
	call_id: Schema.String,
	parent_id: Schema.NullOr(Schema.String),
	server: Schema.String,
	tool: Schema.String,
	input: Schema.fromJsonString(Schema.JsonObject),
	truncated: Schema.Finite,
	permission: Schema.Literals(["allow", "ask"]),
	result: Schema.NullOr(Schema.fromJsonString(Schema.toCodecJson(McpCallResult))),
})

const DirectRow = Schema.Struct({
	call_id: Schema.String,
	server: Schema.String,
	tool: Schema.String,
	permission: Schema.Literals(["allow", "ask"]),
})

const decodeServerRow = Schema.decodeUnknownSync(ServerRow)
const decodeDirectRow = Schema.decodeUnknownSync(DirectRow)
const decodeCallRow = Schema.decodeUnknownSync(CallRow)
const encodeBinding = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(McpServerBinding)))
const encodeTools = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(McpToolDescriptors)))
const encodeResult = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(McpCallResult)))

const INTERRUPTED: McpCallResult = {
	content: [
		{
			type: "text",
			text: "The call was interrupted before its result was recorded. It may or may not have completed.",
		},
	],
	is_error: true,
}

const NESTED_CALL = /^(.+)\/c\d+$/u

/** A script's call is `<script call id>/c<n>`; any other call was made by the model. */
export const parentCallId = (callId: string): string | null => NESTED_CALL.exec(callId)?.[1] ?? null

/**
 * What one session object remembers about its MCP servers: which servers the
 * session bound, the tools each listed when the conversation first reached it,
 * and every MCP call of the turn being run. A script's calls never enter Pi's
 * transcript, so this ledger is the only record of them.
 */
export class PiMcpStore {
	readonly #sql: SqlExecutor
	#initialized = false

	constructor(sql: SqlExecutor) {
		this.#sql = sql
	}

	#rows(query: string, ...bindings: ReadonlyArray<unknown>): Iterable<object> {
		if (!this.#initialized) {
			this.#sql.transaction(() => {
				this.#sql.exec(
					"CREATE TABLE IF NOT EXISTS checkfu_mcp_servers (name TEXT PRIMARY KEY, position INTEGER NOT NULL, binding TEXT NOT NULL, tools TEXT, unavailable TEXT)",
				)
				this.#sql.exec(
					"CREATE TABLE IF NOT EXISTS checkfu_mcp_tool_calls (seq INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL UNIQUE, parent_id TEXT, server TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL, truncated INTEGER NOT NULL, permission TEXT NOT NULL, result TEXT)",
				)
			})
			this.#initialized = true
		}
		return this.#sql.exec(query, ...bindings)
	}

	#exec(query: string, ...bindings: ReadonlyArray<unknown>): Array<object> {
		return [...this.#rows(query, ...bindings)]
	}

	servers(): Array<{
		readonly binding: McpServerBinding
		readonly tools: ReadonlyArray<McpToolDescriptor> | null
		readonly unavailable: string | null
	}> {
		return this.#exec(
			"SELECT binding, tools, unavailable FROM checkfu_mcp_servers ORDER BY position",
		).map((row) => decodeServerRow(row))
	}

	/** Records the session's servers. Returns whether they differ from what was recorded. */
	bind(bindings: ReadonlyArray<McpServerBinding>): boolean {
		const next = bindings.map((binding) => encodeBinding(binding))
		const current = this.servers().map(({ binding }) => encodeBinding(binding))
		if (current.length === next.length && current.every((binding, i) => binding === next[i])) {
			return false
		}
		this.#sql.transaction(() => {
			this.#exec("DELETE FROM checkfu_mcp_servers")
			for (const [position, binding] of bindings.entries()) {
				this.#exec(
					"INSERT INTO checkfu_mcp_servers (name, position, binding) VALUES (?, ?, ?)",
					binding.name,
					position,
					next[position],
				)
			}
		})
		return true
	}

	/**
	 * Records the tools a server listed. A list too large to store leaves the
	 * server without tools and says why, so the turn runs without them.
	 */
	listed(server: string, tools: ReadonlyArray<McpToolDescriptor>): void {
		const encoded = encodeTools(tools)
		const bytes = new TextEncoder().encode(encoded).byteLength
		if (bytes <= MAX_MCP_TOOL_LIST_BYTES) {
			this.#exec(
				"UPDATE checkfu_mcp_servers SET tools = ?, unavailable = NULL WHERE name = ?",
				encoded,
				server,
			)
			return
		}
		this.#exec(
			"UPDATE checkfu_mcp_servers SET tools = '[]', unavailable = ? WHERE name = ?",
			`its tool list is ${bytes} bytes, more than the ${MAX_MCP_TOOL_LIST_BYTES} a session can keep`,
			server,
		)
	}

	began(call: McpCall): void {
		const input = JSON.stringify(call.input)
		const fits = input.length <= MAX_TOOL_INPUT_JSON_LENGTH
		this.#exec(
			"INSERT OR IGNORE INTO checkfu_mcp_tool_calls (call_id, parent_id, server, tool, input, truncated, permission) VALUES (?, ?, ?, ?, ?, ?, ?)",
			call.call_id,
			parentCallId(call.call_id),
			call.server,
			call.tool,
			fits ? input : "{}",
			fits ? 0 : 1,
			call.permission,
		)
	}

	ended(callId: string, result: McpCallResult): void {
		let room = MAX_TOOL_RESULT_TEXT_LENGTH
		const content = result.content.map((block) => {
			const kept = truncateText(block.text, room)
			room -= kept.length
			return { type: "text" as const, text: kept }
		})
		this.#exec(
			"UPDATE checkfu_mcp_tool_calls SET result = ? WHERE call_id = ?",
			encodeResult({ content, is_error: result.is_error }),
			callId,
		)
	}

	/** Forgets the calls of earlier turns: a turn's calls are published before the next turn starts. */
	forgetCalls(): void {
		this.#exec("DELETE FROM checkfu_mcp_tool_calls")
	}

	/**
	 * How this turn's MCP calls join its tool events: a call the model made to an MCP tool
	 * is named as one, and each script's MCP calls follow the script call that made them,
	 * read from the ledger one at a time, in the order they were made.
	 */
	served(): ServedToolCalls {
		const direct = new Map(
			this.#exec(
				"SELECT call_id, server, tool, permission FROM checkfu_mcp_tool_calls WHERE parent_id IS NULL",
			).map((row) => {
				const call = decodeDirectRow(row)
				return [call.call_id, call] as const
			}),
		)
		const rows = (scriptCallId: string) =>
			this.#rows(
				"SELECT call_id, parent_id, server, tool, input, truncated, permission, result FROM checkfu_mcp_tool_calls WHERE parent_id = ? ORDER BY seq",
				scriptCallId,
			)
		return {
			named: (event) => {
				const call = direct.get(event.tool_use_id)
				if (
					call === undefined ||
					event.type === "mcp_tool_use" ||
					event.type === "mcp_tool_result"
				) {
					return event
				}
				return event.type === "tool_result"
					? { ...event, type: "mcp_tool_result" }
					: {
							type: "mcp_tool_use",
							tool_use_id: event.tool_use_id,
							mcp_server_name: call.server,
							name: call.tool,
							input: event.input,
							evaluated_permission: call.permission,
							...(event.truncated === true ? { truncated: true as const } : {}),
						}
			},
			*nested(scriptCallId) {
				for (const row of rows(scriptCallId)) {
					const nested = decodeCallRow(row)
					const result = nested.result ?? INTERRUPTED
					yield {
						type: "mcp_tool_use",
						tool_use_id: nested.call_id,
						mcp_server_name: nested.server,
						name: nested.tool,
						input: nested.input,
						evaluated_permission: nested.permission,
						parent_tool_use_id: scriptCallId,
						...(nested.truncated === 1 ? { truncated: true as const } : {}),
					}
					yield {
						type: "mcp_tool_result",
						tool_use_id: nested.call_id,
						content: result.content,
						is_error: result.is_error,
					}
				}
			},
		}
	}
}
