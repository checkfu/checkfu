import { McpServerName, ResourceId, TextBlock, ToolRejection } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

export {
	ErrorMessage,
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
} from "@checkfu/sdk/Schemas"

export const MAX_TOOL_INPUT_JSON_LENGTH = 16_384
export const MAX_TOOL_RESULT_TEXT_LENGTH = 16_384
export const MAX_TOOL_CALLS_PER_TURN = 64
export const MAX_TURN_TOOL_TEXT_LENGTH = 131_072

export const ToolInput = Schema.String.check(Schema.isMaxLength(MAX_TOOL_INPUT_JSON_LENGTH)).pipe(
	Schema.decodeTo(Schema.Unknown, SchemaTransformation.fromJsonString()),
	Schema.decodeTo(Schema.JsonObject),
)

export const ToolUse = Schema.Struct({
	type: Schema.Literal("tool_use"),
	tool_use_id: ResourceId,
	name: ResourceId,
	input: ToolInput,
	truncated: Schema.optionalKey(Schema.Literal(true)),
	mcp_server_name: Schema.optionalKey(McpServerName),
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
	content: Schema.Array(TextBlock),
	is_error: Schema.Boolean,
	result_truncated: Schema.optionalKey(Schema.Literal(true)),
	rejected: Schema.optionalKey(ToolRejection),
})
export type ToolCall = typeof ToolCall.Type
