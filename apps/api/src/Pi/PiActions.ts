import type { AgentTool, CustomTool } from "@checkfu/domain/Mcp/McpServers"
import { toolUseId, toolUseOf, turnCalls } from "@checkfu/domain/Session/ToolEventBounds"
import type { TurnCalls } from "@checkfu/domain/Session/ToolEventBounds"
import {
	MAX_ACTION_INPUT_JSON_LENGTH,
	MAX_TOOL_CALLS_PER_TURN,
	ResourceId,
} from "@checkfu/domain/Session/SessionTypes"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { isJsonValue } from "@earendil-works/chord/json"
import { ToolTask, defineExtension, defineSignal, hook } from "@earendil-works/pi-durable"
import type {
	Extension,
	Harness,
	JsonObject,
	SignalResult,
	SignalToken,
	TaskId,
	ToolHookCall,
	ToolRegistration,
} from "@earendil-works/pi-durable"
import { bool, obj, str } from "@earendil-works/pi-schema"
import * as Schema from "effect/Schema"
import { blockAtGate } from "./PiRejection.ts"

export const ToolConfirmationSignal = defineSignal({
	name: "checkfu.tool_confirmation",
	version: 1,
	schema: obj({ allow: bool(), deny_message: str() }),
})

export const CustomToolResultSignal = defineSignal({
	name: "checkfu.custom_tool_result",
	version: 1,
	schema: obj({ text: str(), is_error: bool() }),
})

const ANSWER = "answer"

export const ACTION_MEMO = "checkfu.action"

export const ActionMemo = Schema.Struct({
	awaits: Schema.Literals(["confirmation", "result"]),
	name: Schema.String,
	mcp_server_name: Schema.String,
	input: Schema.JsonObject,
})
export type ActionMemo = typeof ActionMemo.Type
const readMemo = Schema.decodeUnknownOption(ActionMemo)

export type Permission = "allow" | "ask"

export const mcpPermission = (
	tools: ReadonlyArray<AgentTool>,
	server: string,
	tool: { readonly name: string; readonly annotations?: { readonly readOnlyHint?: boolean } },
): Permission => {
	const toolset = tools.find(
		(declared) => declared.type === "mcp_toolset" && declared.mcp_server_name === server,
	)
	const named =
		toolset?.type === "mcp_toolset"
			? (toolset.configs?.find((config) => config.name === tool.name)?.permission_policy?.type ??
				toolset.default_config?.permission_policy?.type)
			: undefined
	return named === "always_allow" ? "allow" : "ask"
}

const publishable = Schema.is(ResourceId)

export type GateDecision =
	| { readonly kind: "run" }
	| { readonly kind: "ask"; readonly server: string; readonly tool: string }
	| { readonly kind: "refuse"; readonly message: string }

export const gateDecision = (
	call: Pick<ToolHookCall, "name" | "parent">,
	toolOf: (
		name: string,
	) =>
		| { readonly server: string; readonly tool: string; readonly permission?: Permission }
		| undefined,
	unattended = false,
): GateDecision => {
	const mcp = toolOf(call.name)
	if (mcp === undefined || mcp.permission !== "ask") {
		return { kind: "run" }
	}
	if (unattended) {
		return {
			kind: "refuse",
			message: `${mcp.tool} needs a person's approval. This session was started by an automation. Continue without the tool and explain what you could not do.`,
		}
	}
	if (call.parent !== undefined) {
		return {
			kind: "refuse",
			message: `${mcp.tool} needs a person's approval, which a script cannot wait for. Call it directly.`,
		}
	}
	if (!publishable(mcp.tool)) {
		return {
			kind: "refuse",
			message: `This tool of ${mcp.server} has a name too long to ask a person about, so it cannot be called.`,
		}
	}
	return { kind: "ask", server: mcp.server, tool: mcp.tool }
}

const jsonObjectOf = (value: unknown): JsonObject | undefined =>
	isJsonValue(value) && typeof value === "object" && value !== null && !Array.isArray(value)
		? value
		: undefined

const fitsAnAction = (input: JsonObject): boolean =>
	JSON.stringify(input).length <= MAX_ACTION_INPUT_JSON_LENGTH

const tooLarge = (name: string) =>
	`The arguments of ${name} are more than ${MAX_ACTION_INPUT_JSON_LENGTH} characters of JSON, too large to wait on an answer. Call it with smaller arguments.`

const denial = (message: string) =>
	message.length === 0 ? "The user denied this call." : `The user denied this call: ${message}`

const NOBODY_ANSWERS =
	"This tool needs a result from the owner's application. This session was started by an automation. Continue without the tool and explain what you could not do."

const TURN_FULL = `This turn has recorded ${MAX_TOOL_CALLS_PER_TURN} tool calls, its limit, so a call that waits for an answer cannot start in it. Finish the turn; the call can be made in the next one.`

export const actionsExtension = (
	toolOf: Parameters<typeof gateDecision>[1],
	calls: Pick<TurnCalls, "admit"> = turnCalls(),
	waitsForAResult: (name: string) => boolean = () => false,
	unattended: () => boolean = () => false,
): Extension =>
	defineExtension({
		name: "checkfu.actions",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context) => {
					const placed = () =>
						(call.parent === undefined || calls.admit(call.parent.taskId)) &&
						calls.admit(api.taskId)
					const isUnattended = unattended()
					const decision = gateDecision(call, toolOf, isUnattended)
					if (decision.kind === "run") {
						if (!waitsForAResult(call.name)) {
							return undefined
						}
						if (isUnattended) {
							return blockAtGate(api, NOBODY_ANSWERS, context)
						}
						return placed() ? undefined : blockAtGate(api, TURN_FULL, context)
					}
					if (decision.kind === "refuse") {
						return blockAtGate(api, decision.message, context)
					}
					const input = jsonObjectOf(call.arguments) ?? {}
					if (!fitsAnAction(input)) {
						return blockAtGate(api, tooLarge(decision.tool), context)
					}
					if (!placed()) {
						return blockAtGate(api, TURN_FULL, context)
					}
					await api.memo(
						ACTION_MEMO,
						{
							awaits: "confirmation",
							name: decision.tool,
							mcp_server_name: decision.server,
							input,
						},
						context,
					)
					const answer = await api.readSignal(ToolConfirmationSignal, ANSWER, context)
					if (answer === undefined) {
						return { sleep: { signals: [ToolConfirmationSignal.key(ANSWER)] } }
					}
					return answer.kind === "value" && answer.value.allow
						? undefined
						: blockAtGate(
								api,
								answer.kind === "value" ? denial(answer.value.deny_message) : denial(""),
								context,
							)
				},
				afterTool: async (_call, result, api, context) => {
					if ((await api.memo(ACTION_MEMO, context)) === undefined) {
						return undefined
					}
					const details =
						typeof result.details === "object" &&
						result.details !== null &&
						!Array.isArray(result.details)
							? result.details
							: {}
					return { ...result, details: { ...details, checkfu_action: true } }
				},
			}),
		],
	})

export const waitedOnAnAnswer = (details: unknown): boolean =>
	typeof details === "object" &&
	details !== null &&
	(details as { readonly checkfu_action?: unknown }).checkfu_action === true

export const customToolsExtension = (tools: ReadonlyArray<CustomTool>): Extension =>
	defineExtension({
		name: "checkfu.custom-tools",
		tools: tools.map((tool): ToolRegistration => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.input_schema,
			callers: ["model"],
			replay: "safe",
			execute: async (args, api, context) => {
				const answer = await api.readSignal(CustomToolResultSignal, ANSWER, context)
				if (answer !== undefined) {
					return answer.kind === "value"
						? {
								output: [{ type: "text", text: answer.value.text }],
								isError: answer.value.is_error,
							}
						: { output: [{ type: "text", text: "No result arrived." }], isError: true }
				}
				const input = jsonObjectOf(args) ?? {}
				if (!fitsAnAction(input)) {
					return { output: [{ type: "text", text: tooLarge(tool.name) }], isError: true }
				}
				await api.memo(
					ACTION_MEMO,
					{ awaits: "result", name: tool.name, mcp_server_name: "", input },
					context,
				)
				return { kind: "sleep", signals: [CustomToolResultSignal.key(ANSWER)], checkpoint: input }
			},
		})),
	})

export interface ParkedAction extends ActionMemo {
	readonly tool_use_id: string
}

export const parkedActions = async (
	pi: Harness,
	turn: number,
): Promise<ReadonlyArray<ParkedAction> | undefined> => {
	const inspection = await pi.inspect(BACKGROUND_CONTEXT)
	const parked: Array<ParkedAction> = []
	for (const task of inspection.tasks) {
		if (task.record.kind === "pi.generation" && task.state.kind === "running") {
			return undefined
		}
		if (task.record.kind !== "pi.tool") {
			continue
		}
		const memo = readMemo(task.record.memos?.[ACTION_MEMO])
		if (task.state.kind !== "sleeping" || memo._tag === "None") {
			return undefined
		}
		parked.push({ tool_use_id: toolUseId(turn, task.record.id), ...memo.value })
	}
	return parked.length === 0
		? undefined
		: parked.toSorted((a, b) => a.tool_use_id.localeCompare(b.tool_use_id))
}

export type ActionAnswer =
	| { readonly type: "confirmation"; readonly allow: boolean; readonly deny_message: string }
	| { readonly type: "result"; readonly text: string; readonly is_error: boolean }

export const deliverAnswer = async (
	pi: Harness,
	signal: <T>(
		taskId: TaskId,
		token: SignalToken<T>,
		key: string,
		value: T,
	) => Promise<SignalResult>,
	tool_use_id: string,
	answer: ActionAnswer,
): Promise<"delivered" | "gone"> => {
	const call = toolUseOf(tool_use_id)
	if (call === undefined) {
		return "gone"
	}
	const inspection = await pi.inspect(BACKGROUND_CONTEXT)
	const task = inspection.tasks.find(
		(live) => live.record.kind === "pi.tool" && live.record.id === call.task_id,
	)?.record.id
	if (task === undefined) {
		return "gone"
	}
	const delivered =
		answer.type === "confirmation"
			? signal(task, ToolConfirmationSignal, ANSWER, {
					allow: answer.allow,
					deny_message: answer.deny_message,
				})
			: signal(task, CustomToolResultSignal, ANSWER, {
					text: answer.text,
					is_error: answer.is_error,
				})
	return delivered.then((result) =>
		result === "delivered" || result === "duplicate" ? "delivered" : "gone",
	)
}
