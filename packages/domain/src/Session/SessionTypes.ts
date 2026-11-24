import { EvaluatedPermission, ResourceId, StopReason, TextBlock } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

export {
	DenyMessage,
	ErrorMessage,
	ErrorType,
	EvaluatedPermission,
	MAX_DENY_MESSAGE_LENGTH,
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
	SessionTitle,
	StopReason,
	TextBlock,
	TextBlocks,
	ThinkingText,
	ToolConfirmationResult,
} from "@checkfu/sdk/Schemas"

export const MAX_TOOL_INPUT_JSON_LENGTH = 16_384
export const MAX_TOOL_RESULT_TEXT_LENGTH = 16_384
export const MAX_TOOL_CALLS_PER_TURN = 64
export const MAX_TURN_TOOL_TEXT_LENGTH = 131_072
export const MAX_WAITING_TOOL_USES = 64
export const MAX_TOOL_USE_IDS_TEXT_LENGTH = 32_768

// Stored as bounded JSON text; read as the object.
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
})
export type ToolUse = typeof ToolUse.Type

export const ToolResult = Schema.Struct({
	type: Schema.Literal("tool_result"),
	tool_use_id: ResourceId,
	content: Schema.Array(TextBlock),
	is_error: Schema.Boolean,
	truncated: Schema.optionalKey(Schema.Literal(true)),
})
export type ToolResult = typeof ToolResult.Type

export const McpToolUse = Schema.Struct({
	type: Schema.Literal("mcp_tool_use"),
	tool_use_id: ResourceId,
	mcp_server_name: ResourceId,
	name: ResourceId,
	input: ToolInput,
	evaluated_permission: Schema.optionalKey(EvaluatedPermission),
	// The script call that made this one, when a script did.
	parent_tool_use_id: Schema.optionalKey(ResourceId),
	truncated: Schema.optionalKey(Schema.Literal(true)),
})
export type McpToolUse = typeof McpToolUse.Type

export const McpToolResult = Schema.Struct({
	type: Schema.Literal("mcp_tool_result"),
	tool_use_id: ResourceId,
	content: Schema.Array(TextBlock),
	is_error: Schema.Boolean,
	truncated: Schema.optionalKey(Schema.Literal(true)),
})
export type McpToolResult = typeof McpToolResult.Type

export const ToolEvent = Schema.Union([ToolUse, ToolResult, McpToolUse, McpToolResult])
export type ToolEvent = typeof ToolEvent.Type

// One call as the session log records it: its use and result together; the use alone when the
// transcript holds no result for it yet; or the result alone when an earlier turn, which paused
// on the call, published its use.
export const ToolCall = Schema.Union([
	Schema.TaggedStruct("pair", {
		use: Schema.Union([ToolUse, McpToolUse]),
		result: Schema.Union([ToolResult, McpToolResult]),
	}),
	Schema.TaggedStruct("use", { use: Schema.Union([ToolUse, McpToolUse]) }),
	Schema.TaggedStruct("result", { result: Schema.Union([ToolResult, McpToolResult]) }),
])
export type ToolCall = typeof ToolCall.Type

/**
 * The tool calls a paused session waits on, as the model carries them: JSON
 * text it copies and never looks inside, so its rules stay provable.
 */
export const ToolUseIdsText = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_TOOL_USE_IDS_TEXT_LENGTH),
)

const toolUseIdsCodec = Schema.fromJsonString(
	Schema.toCodecJson(
		Schema.Array(ResourceId).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(MAX_WAITING_TOOL_USES),
		),
	),
)
export const ToolUseIds = {
	encode: Schema.encodeSync(toolUseIdsCodec),
	decode: Schema.decodeUnknownSync(toolUseIdsCodec),
}

/** Why a session went idle. Only a pause names the calls it waits on. */
export const IdleStopReason = Schema.Struct({
	type: Schema.Literals([...StopReason.fields.type.literals, "requires_action"]),
})
export type IdleStopReason = typeof IdleStopReason.Type
