import { CustomTool } from "@checkfu/domain/Mcp/CustomTools"
import { MAX_CUSTOM_TOOL_INPUT_JSON_LENGTH } from "@checkfu/domain/Session/SessionTypes"
import { defineSignal } from "@earendil-works/pi-durable"
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable"
import { arr, bool, compile, lit, obj, str } from "@earendil-works/pi-schema"
import * as Schema from "effect/Schema"
import type { ServedToolCalls } from "./PiDurableEngine.ts"
import type { SqlExecutor } from "./PiMcpStore.ts"

export const CUSTOM_TOOLS_EXTENSION = "checkfu.custom-tools"

/** A custom tool's result, delivered to the call that waits for it. */
export const CustomToolResult = defineSignal({
	name: "checkfu.custom-tool-result",
	version: 1,
	schema: obj({ content: arr(obj({ type: lit("text"), text: str() })), is_error: bool() }),
})
export const CUSTOM_TOOL_RESULT_KEY = "result"

export const SCRIPT_NOTE =
	"Call this tool directly. The user's application runs it, so it is not available inside codemode scripts."

/**
 * Whether Pi can check a call's arguments against this schema, exactly as given, as it does
 * before every call. A reference Pi cannot resolve makes it uncheckable: weakening it would offer
 * the model and Pi's check a different schema from the one the agent declares.
 */
export const isCheckableInputSchema = (schema: Schema.JsonObject): boolean => {
	try {
		compile(schema)
		return true
	} catch {
		return false
	}
}

export const requestTooLargeMessage = (size: number): string =>
	`This call's arguments are ${size} characters of JSON; the application can receive at most ${MAX_CUSTOM_TOOL_INPUT_JSON_LENGTH}. It did not run. Call it again with smaller arguments.`

const isJsonObject = Schema.is(Schema.JsonObject)

const toolCodec = Schema.fromJsonString(Schema.toCodecJson(CustomTool))
const encodeTool = Schema.encodeSync(toolCodec)
const ToolRow = Schema.Struct({ tool: toolCodec })
const decodeToolRow = Schema.decodeUnknownSync(ToolRow)
const inputCodec = Schema.fromJsonString(Schema.JsonObject)
const encodeInput = Schema.encodeSync(inputCodec)
const RequestRow = Schema.Struct({ tool_use_id: Schema.String, input: inputCodec })
const decodeRequestRow = Schema.decodeUnknownSync(RequestRow)

/**
 * The custom tools a session object offers. They are kept here so a call that
 * waits for its result still finds its tool when the object is opened again.
 */
export class PiCustomToolStore {
	readonly #sql: SqlExecutor
	#initialized = false

	constructor(sql: SqlExecutor) {
		this.#sql = sql
	}

	#exec(query: string, ...bindings: ReadonlyArray<unknown>): Array<object> {
		if (!this.#initialized) {
			this.#sql.exec(
				"CREATE TABLE IF NOT EXISTS checkfu_custom_tools (position INTEGER PRIMARY KEY, tool TEXT NOT NULL)",
			)
			this.#sql.exec(
				"CREATE TABLE IF NOT EXISTS checkfu_custom_requests (tool_use_id TEXT PRIMARY KEY, input TEXT NOT NULL)",
			)
			this.#initialized = true
		}
		return [...this.#sql.exec(query, ...bindings)]
	}

	/**
	 * A call that parked to wait for the application: the arguments Pi checked and coerced, which
	 * are the ones the tool ran with and the ones the application is asked to run.
	 */
	requested(toolUseId: string, input: Schema.JsonObject): void {
		this.#exec(
			"INSERT OR REPLACE INTO checkfu_custom_requests (tool_use_id, input) VALUES (?, ?)",
			toolUseId,
			encodeInput(input),
		)
	}

	/** The session's custom tools, each recording its request here as it parks. */
	extension(
		park: (call: { readonly tool_use_id: string; readonly task_id: number }) => void,
	): Extension {
		return customToolsExtension(this.tools(), ({ input, ...call }) => {
			this.requested(call.tool_use_id, input)
			park(call)
		})
	}

	/** A new Pi operation starts: requests of an earlier one were published with it. */
	forgetRequests(): void {
		this.#exec("DELETE FROM checkfu_custom_requests")
	}

	#requests(): Map<string, Schema.JsonObject> {
		return new Map(
			this.#exec("SELECT tool_use_id, input FROM checkfu_custom_requests").map((row) => {
				const request = decodeRequestRow(row)
				return [request.tool_use_id, request.input] as const
			}),
		)
	}

	tools(): Array<CustomTool> {
		return this.#exec("SELECT tool FROM checkfu_custom_tools ORDER BY position").map(
			(row) => decodeToolRow(row).tool,
		)
	}

	/** Records the agent version's tools. Returns whether they differ from what was recorded. */
	bind(tools: ReadonlyArray<CustomTool>): boolean {
		const next = tools.map((tool) => encodeTool(tool))
		const current = this.tools().map((tool) => encodeTool(tool))
		if (current.length === next.length && current.every((tool, i) => tool === next[i])) {
			return false
		}
		this.#sql.transaction(() => {
			this.#exec("DELETE FROM checkfu_custom_tools")
			for (const [position, tool] of next.entries()) {
				this.#exec(
					"INSERT INTO checkfu_custom_tools (position, tool) VALUES (?, ?)",
					position,
					tool,
				)
			}
		})
		return true
	}

	/**
	 * How custom tool calls join a turn's tool events. Only a call that parked is a request to the
	 * application: it is published with the arguments it ran with, and its result is left out,
	 * since the application's own event is the record of it. A call Pi refused before it ran, or
	 * one too large to send, stays an ordinary call with its error.
	 */
	served(): ServedToolCalls {
		const requests = this.#requests()
		return {
			named: (event) => {
				const input = requests.get(event.tool_use_id)
				if (input === undefined) {
					return event
				}
				return event.type === "tool_use"
					? { type: "custom_tool_use", tool_use_id: event.tool_use_id, name: event.name, input }
					: event.type === "tool_result"
						? undefined
						: event
			},
			nested: () => [],
			// A request is published whatever the audit bounds left out before it.
			readToEnd: requests.size > 0,
		}
	}
}

/**
 * The agent's custom tools as a Pi extension. A call parks until the
 * application that runs the tool returns its result, holding no process. Only
 * the model may call one: a script waits in memory, so it cannot wait for an
 * answer from outside.
 */
export const customToolsExtension = (
	tools: ReadonlyArray<CustomTool>,
	park: (call: {
		readonly tool_use_id: string
		readonly task_id: number
		readonly input: Schema.JsonObject
	}) => void,
): Extension => ({
	name: CUSTOM_TOOLS_EXTENSION,
	tools: tools.map((tool): ToolRegistration => ({
		name: tool.name,
		description: `${tool.description}\n\n${SCRIPT_NOTE}`,
		parameters: tool.input_schema,
		callers: ["model"],
		// A call cut off before it parked runs again and parks; it has done nothing else.
		replay: "safe",
		execute: async (args, api, context) => {
			const result = await api.readSignal(CustomToolResult, CUSTOM_TOOL_RESULT_KEY, context)
			if (result === undefined) {
				const input = isJsonObject(args) ? args : {}
				const size = JSON.stringify(input).length
				if (size > MAX_CUSTOM_TOOL_INPUT_JSON_LENGTH) {
					return { output: [{ type: "text", text: requestTooLargeMessage(size) }], isError: true }
				}
				park({ tool_use_id: api.callId, task_id: api.taskId, input })
				return { sleep: { signals: [CustomToolResult.key(CUSTOM_TOOL_RESULT_KEY)] } }
			}
			return "value" in result
				? {
						output: result.value.content.map((block) => ({ type: "text", text: block.text })),
						isError: result.value.is_error,
					}
				: {
						output: [{ type: "text", text: "No result arrived for this tool call." }],
						isError: true,
					}
		},
	})),
})
