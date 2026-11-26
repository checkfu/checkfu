import { McpServerName, ResourceId, TextBlock, ToolRejection } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

export {
	DenyMessage,
	ErrorMessage,
	EvaluatedPermission,
	IdleStopReason,
	MAX_AGENT_SYSTEM_LENGTH,
	MAX_CUSTOM_TOOL_RESULT_LENGTH,
	MAX_DENY_MESSAGE_LENGTH,
	ErrorType,
	MAX_ERROR_MESSAGE_LENGTH,
	MAX_ERROR_TYPE_LENGTH,
	MAX_IDENTIFIER_LENGTH,
	MAX_MESSAGE_TEXT_LENGTH,
	MAX_THINKING_TEXT_LENGTH,
	MAX_TITLE_LENGTH,
	MessageText,
	ModelUsage,
	NonEmptyString,
	NonNegativeInt,
	PositiveInt,
	ResourceId,
	RetryStatus,
	SessionErrorBody,
	SessionEventFields,
	SessionStatus,
	ToolRejection,
	SessionTitle,
	StopReason,
	TextBlock,
	TextBlocks,
	ThinkingText,
	ToolConfirmationResult,
} from "@checkfu/sdk/Schemas"

export const MAX_TOOL_INPUT_JSON_LENGTH = 16_384
export const MAX_ACTION_INPUT_JSON_LENGTH = 65_536
export const MAX_TOOL_RESULT_TEXT_LENGTH = 16_384
export const MAX_TOOL_CALLS_PER_TURN = 64
export const MAX_TURN_TOOL_TEXT_LENGTH = 131_072

export const ToolInput = Schema.String.check(Schema.isMaxLength(MAX_TOOL_INPUT_JSON_LENGTH)).pipe(
	Schema.decodeTo(Schema.Unknown, SchemaTransformation.fromJsonString()),
	Schema.decodeTo(Schema.JsonObject),
)

export const ActionInput = Schema.String.check(
	Schema.isMaxLength(MAX_ACTION_INPUT_JSON_LENGTH),
).pipe(
	Schema.decodeTo(Schema.Unknown, SchemaTransformation.fromJsonString()),
	Schema.decodeTo(Schema.JsonObject),
)

export const MAX_TOOL_USE_IDS_TEXT_LENGTH = 65_536
export const ToolUseIdsText = Schema.String.check(Schema.isMaxLength(MAX_TOOL_USE_IDS_TEXT_LENGTH))
const toolUseIdsJson = Schema.fromJsonString(Schema.Array(Schema.String))
export const encodeToolUseIds = Schema.encodeSync(toolUseIdsJson)
const readToolUseIds = Schema.decodeUnknownOption(toolUseIdsJson)
export const decodeToolUseIds = (text: string): ReadonlyArray<string> => {
	const read = readToolUseIds(text)
	return read._tag === "Some" ? read.value : []
}
export const NO_TOOL_USE_IDS = "[]"
export const addToolUseId = (text: string, id: string): string => {
	const ids = decodeToolUseIds(text)
	return ids.includes(id) ? text : encodeToolUseIds([...ids, id])
}
export const removeToolUseId = (text: string, id: string): string =>
	encodeToolUseIds(decodeToolUseIds(text).filter((kept) => kept !== id))

export const ToolResultText = Schema.String.check(Schema.isMaxLength(16_384))

export const ToolUse = Schema.Struct({
	type: Schema.Literal("tool_use"),
	tool_use_id: ResourceId,
	name: ResourceId,
	input: ToolInput,
	truncated: Schema.optionalKey(Schema.Literal(true)),
	mcp_server_name: Schema.optionalKey(McpServerName),
	evaluated_permission: Schema.optionalKey(Schema.Literal("allow")),
})
export type ToolUse = typeof ToolUse.Type

export const ToolResult = Schema.Struct({
	type: Schema.Literal("tool_result"),
	tool_use_id: ResourceId,
	content: Schema.Array(TextBlock),
	is_error: Schema.Boolean,
	truncated: Schema.optionalKey(Schema.Literal(true)),
	rejected: Schema.optionalKey(ToolRejection),
	mcp: Schema.optionalKey(Schema.Literal(true)),
})
export type ToolResult = typeof ToolResult.Type

export const ToolEvent = Schema.Union([ToolUse, ToolResult])
export type ToolEvent = typeof ToolEvent.Type

export const ToolCall = Schema.Struct({
	tool_use_id: ResourceId,
	name: ResourceId,
	input: ToolInput,
	input_truncated: Schema.optionalKey(Schema.Literal(true)),
	mcp_server_name: Schema.optionalKey(McpServerName),
	evaluated_permission: Schema.optionalKey(Schema.Literal("allow")),
	content: Schema.Array(TextBlock),
	is_error: Schema.Boolean,
	result_truncated: Schema.optionalKey(Schema.Literal(true)),
	rejected: Schema.optionalKey(ToolRejection),
})
export type ToolCall = typeof ToolCall.Type
