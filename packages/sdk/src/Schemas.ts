import * as Schema from "effect/Schema"

// ---------------------------------------------------------------------------
// Shared limits & primitive schemas
// ---------------------------------------------------------------------------

export const MAX_AGENT_NAME_LENGTH = 256
export const MAX_AGENT_DESCRIPTION_LENGTH = 2048
export const MAX_AGENT_SYSTEM_LENGTH = 100_000

export const MAX_ENVIRONMENT_NAME_LENGTH = 256
export const MAX_ENVIRONMENT_DESCRIPTION_LENGTH = 1024

export const MAX_AUTOMATION_ID_LENGTH = 128
export const MAX_AUTOMATION_NAME_LENGTH = 256
export const MAX_CRON_EXPRESSION_LENGTH = 256
export const MAX_TIMEZONE_LENGTH = 64

export const MAX_IDENTIFIER_LENGTH = 256
export const MAX_TITLE_LENGTH = 1024
export const MAX_MESSAGE_TEXT_LENGTH = 16_384
export const MAX_THINKING_TEXT_LENGTH = 16_384
export const MAX_ERROR_TYPE_LENGTH = 128
export const MAX_ERROR_MESSAGE_LENGTH = 4096

export const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const SINGLE_PATH_SEGMENT_MESSAGE =
	'must be a single non-empty path segment (not "." or "..")'

export const isSinglePathSegment = (value: string): boolean =>
	value.length > 0 &&
	value !== "." &&
	value !== ".." &&
	!value.includes("/") &&
	!value.includes("\\")

export const SinglePathSegmentCheck = Schema.isPattern(/^(?!\.\.?$)[^/\\]+$/, {
	message: SINGLE_PATH_SEGMENT_MESSAGE,
})

export const ResourceId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
)

// ---------------------------------------------------------------------------
// Branded resource IDs
// ---------------------------------------------------------------------------

export const AgentId = Schema.String.check(Schema.isMinLength(1), SinglePathSegmentCheck).pipe(
	Schema.brand("AgentId"),
)
export type AgentId = typeof AgentId.Type

export const AgentVersionId = Schema.String.check(
	Schema.isMinLength(1),
	SinglePathSegmentCheck,
).pipe(Schema.brand("AgentVersionId"))
export type AgentVersionId = typeof AgentVersionId.Type

export const EnvironmentId = Schema.String.check(
	Schema.isMinLength(1),
	SinglePathSegmentCheck,
).pipe(Schema.brand("EnvironmentId"))
export type EnvironmentId = typeof EnvironmentId.Type

export const SessionId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
	SinglePathSegmentCheck,
).pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

export const AutomationId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_AUTOMATION_ID_LENGTH),
	SinglePathSegmentCheck,
).pipe(Schema.brand("AutomationId"))
export type AutomationId = typeof AutomationId.Type

// ---------------------------------------------------------------------------
// Agent schemas
// ---------------------------------------------------------------------------

export const AgentName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_AGENT_NAME_LENGTH),
)
export const AgentDescription = Schema.String.check(
	Schema.isMaxCodePoints(MAX_AGENT_DESCRIPTION_LENGTH),
)
export const AgentSystem = Schema.String.check(Schema.isMaxCodePoints(MAX_AGENT_SYSTEM_LENGTH))

export const AgentModel = Schema.Struct({
	id: NonEmptyString,
})
export type AgentModel = typeof AgentModel.Type

export const AgentSnapshot = Schema.Struct({
	id: AgentId,
	type: Schema.Literal("agent"),
	version: PositiveInt,
	current_version_id: AgentVersionId,
	name: NonEmptyString,
	model: AgentModel,
	system: Schema.NullOr(Schema.String),
	description: Schema.NullOr(Schema.String),
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type AgentSnapshot = typeof AgentSnapshot.Type

// ---------------------------------------------------------------------------
// Environment schemas
// ---------------------------------------------------------------------------

export const EnvironmentName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_ENVIRONMENT_NAME_LENGTH),
)
export const EnvironmentDescription = Schema.String.check(
	Schema.isMaxCodePoints(MAX_ENVIRONMENT_DESCRIPTION_LENGTH),
)

export const EnvironmentNetworking = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("unrestricted"),
	}),
	Schema.Struct({
		type: Schema.Literal("limited"),
		allow_mcp_servers: Schema.Boolean,
		allow_package_managers: Schema.Boolean,
		allowed_hosts: Schema.Array(NonEmptyString),
	}),
])
export type EnvironmentNetworking = typeof EnvironmentNetworking.Type

export const EnvironmentConfig = Schema.Struct({
	type: Schema.Literal("cloud"),
	networking: EnvironmentNetworking,
})
export type EnvironmentConfig = typeof EnvironmentConfig.Type

export const EnvironmentSnapshot = Schema.Struct({
	id: EnvironmentId,
	type: Schema.Literal("environment"),
	version: PositiveInt,
	name: NonEmptyString,
	description: Schema.NullOr(Schema.String),
	config: EnvironmentConfig,
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type EnvironmentSnapshot = typeof EnvironmentSnapshot.Type

// ---------------------------------------------------------------------------
// Session schemas
// ---------------------------------------------------------------------------

export const SessionTitle = Schema.String.check(Schema.isMaxLength(MAX_TITLE_LENGTH))
export const MessageText = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_MESSAGE_TEXT_LENGTH),
)
export const ThinkingText = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_THINKING_TEXT_LENGTH),
)
export const ErrorType = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ERROR_TYPE_LENGTH),
)
export const ErrorMessage = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ERROR_MESSAGE_LENGTH),
)

export const TextBlock = Schema.Struct({
	type: Schema.Literal("text"),
	text: Schema.String,
})
export type TextBlock = typeof TextBlock.Type

export const TextBlocks = Schema.Array(TextBlock).check(Schema.isMinLength(1))
export type TextBlocks = typeof TextBlocks.Type

export const StopReason = Schema.Struct({
	type: Schema.Literals([
		"end_turn",
		"interrupted",
		"retries_exhausted",
		"budget_reached",
		"refusal",
	]),
})
export type StopReason = typeof StopReason.Type

/** Why a paused session waits: the tool calls a person must allow or deny first. */
export const RequiresActionStopReason = Schema.Struct({
	type: Schema.Literal("requires_action"),
	event_ids: Schema.Array(Schema.String).annotate({
		description:
			"The tool calls waiting for an answer, by tool_use_id. Send a user.tool_confirmation for each.",
	}),
})
export type RequiresActionStopReason = typeof RequiresActionStopReason.Type

export const MAX_DENY_MESSAGE_LENGTH = 4096

/** How a tool call was let through: on its own, or only after a person was asked. */
export const EvaluatedPermission = Schema.Literals(["allow", "ask"])
export type EvaluatedPermission = typeof EvaluatedPermission.Type

export const ToolConfirmationResult = Schema.Literals(["allow", "deny"])
export type ToolConfirmationResult = typeof ToolConfirmationResult.Type

/** Why a call was denied, as the model is told; empty when no reason was given. */
export const DenyMessage = Schema.String.check(Schema.isMaxLength(MAX_DENY_MESSAGE_LENGTH))

export const RetryStatus = Schema.Struct({
	type: Schema.Literals(["retrying", "exhausted", "terminal"]),
})
export type RetryStatus = typeof RetryStatus.Type

export const SessionErrorBody = Schema.Struct({
	type: Schema.String,
	message: Schema.String,
	retry_status: RetryStatus,
})
export type SessionErrorBody = typeof SessionErrorBody.Type

export const ModelUsage = Schema.Struct({
	input_tokens: NonNegativeInt,
	output_tokens: NonNegativeInt,
})
export type ModelUsage = typeof ModelUsage.Type

export const SessionStatus = Schema.Literals(["idle", "running", "terminated"])
export type SessionStatus = typeof SessionStatus.Type

/**
 * Canonical payload field definitions for every public session event, shared
 * between `@checkfu/domain` event classes and the wire `SessionEvent` union.
 */
export const SessionEventFields = {
	"user.message": {
		content: TextBlocks,
	},
	"user.interrupt": {},
	"user.tool_confirmation": {
		tool_use_id: ResourceId,
		result: ToolConfirmationResult,
		deny_message: Schema.optionalKey(DenyMessage),
	},
	"session.status_running": {
		turn: PositiveInt,
	},
	"span.model_request_start": {
		model_request_start_id: NonEmptyString,
	},
	"agent.tool_use": {
		tool_use_id: ResourceId,
		name: ResourceId,
		input: Schema.JsonObject,
		truncated: Schema.optionalKey(Schema.Literal(true)),
	},
	"agent.tool_result": {
		tool_use_id: ResourceId,
		content: Schema.Array(TextBlock),
		is_error: Schema.Boolean,
		truncated: Schema.optionalKey(Schema.Literal(true)),
	},
	"agent.mcp_tool_use": {
		tool_use_id: ResourceId,
		mcp_server_name: ResourceId,
		name: ResourceId,
		input: Schema.JsonObject,
		evaluated_permission: Schema.optionalKey(
			EvaluatedPermission.annotate({
				description: "allow: the call ran without asking. ask: it waited for a confirmation.",
			}),
		),
		parent_tool_use_id: Schema.optionalKey(ResourceId),
		truncated: Schema.optionalKey(Schema.Literal(true)),
	},
	"agent.mcp_tool_result": {
		tool_use_id: ResourceId,
		content: Schema.Array(TextBlock),
		is_error: Schema.Boolean,
		truncated: Schema.optionalKey(Schema.Literal(true)),
	},
	"agent.thinking": {
		thinking: Schema.String,
	},
	"agent.message": {
		content: TextBlocks,
		truncated: Schema.optionalKey(Schema.Literal(true)),
	},
	"span.model_request_end": {
		model_request_start_id: NonEmptyString,
		model_usage: ModelUsage,
		is_error: Schema.NullOr(Schema.Boolean),
	},
	"session.status_idle": {
		stop_reason: Schema.Union([StopReason, RequiresActionStopReason]),
		turn: PositiveInt,
	},
	"session.error": {
		error: SessionErrorBody,
	},
	"session.status_terminated": {},
	"session.archived": {},
} as const

export type SessionEventType = keyof typeof SessionEventFields

export const SessionSnapshot = Schema.Struct({
	id: SessionId,
	type: Schema.Literal("session"),
	status: SessionStatus,
	agent_id: Schema.String,
	agent_version: PositiveInt,
	environment_id: Schema.String,
	title: Schema.NullOr(Schema.String),
	turn: NonNegativeInt,
	usage: ModelUsage,
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type SessionSnapshot = typeof SessionSnapshot.Type

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

export const AutomationName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_AUTOMATION_NAME_LENGTH),
)

export const CronExpression = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_CRON_EXPRESSION_LENGTH),
)
export const Timezone = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_TIMEZONE_LENGTH),
)

export const AutomationSchedule = Schema.Struct({
	type: Schema.Literal("cron"),
	expression: CronExpression,
	timezone: Timezone,
})
export type AutomationSchedule = typeof AutomationSchedule.Type

export const AutomationTrigger = Schema.Literals(["schedule", "manual"])
export type AutomationTrigger = typeof AutomationTrigger.Type

export const AutomationRunError = Schema.Struct({
	type: Schema.String,
	message: Schema.String,
})
export type AutomationRunError = typeof AutomationRunError.Type

export const AutomationSnapshot = Schema.Struct({
	id: AutomationId,
	type: Schema.Literal("automation"),
	name: AutomationName,
	agent_id: ResourceId,
	agent_version: Schema.NullOr(PositiveInt),
	environment_id: ResourceId,
	text: MessageText,
	schedule: AutomationSchedule,
	status: Schema.Literals(["active", "paused", "archived"]),
	pause_reason: Schema.NullOr(Schema.String),
	runs: NonNegativeInt,
	activation: NonNegativeInt,
	upcoming: Schema.Array(NonNegativeInt),
	last_run_at: Schema.NullOr(Schema.DateTimeUtc),
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type AutomationSnapshot = typeof AutomationSnapshot.Type

// ---------------------------------------------------------------------------
// Vault schemas
// ---------------------------------------------------------------------------

export const MAX_VAULT_DISPLAY_NAME_LENGTH = 255
export const MAX_CREDENTIAL_DISPLAY_NAME_LENGTH = 255
export const MAX_MCP_SERVER_URL_LENGTH = 2048
export const MAX_CREDENTIAL_SECRET_LENGTH = 16_384
export const MAX_VAULT_CREDENTIALS = 20

export const VaultId = Schema.String.check(Schema.isMinLength(1), SinglePathSegmentCheck).pipe(
	Schema.brand("VaultId"),
)
export type VaultId = typeof VaultId.Type

export const CredentialId = Schema.String.check(Schema.isMinLength(1), SinglePathSegmentCheck).pipe(
	Schema.brand("CredentialId"),
)
export type CredentialId = typeof CredentialId.Type

export const VaultDisplayName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_VAULT_DISPLAY_NAME_LENGTH),
)
export const CredentialDisplayName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_CREDENTIAL_DISPLAY_NAME_LENGTH),
)
export const McpServerUrl = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_MCP_SERVER_URL_LENGTH),
)

export const StaticBearerAuth = Schema.Struct({
	type: Schema.Literal("static_bearer"),
	mcp_server_url: McpServerUrl,
})

// What a credential authenticates against. The secret is never part of it.
export const CredentialAuth = Schema.Union([StaticBearerAuth])
export type CredentialAuth = typeof CredentialAuth.Type

// Held only by the credential's connection object: no command, event or view carries it.
export const CredentialSecret = Schema.Redacted(
	Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CREDENTIAL_SECRET_LENGTH)),
)
export type CredentialSecret = typeof CredentialSecret.Type

export const VaultSnapshot = Schema.Struct({
	id: VaultId,
	type: Schema.Literal("vault"),
	display_name: NonEmptyString,
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type VaultSnapshot = typeof VaultSnapshot.Type

export const CredentialSnapshot = Schema.Struct({
	id: CredentialId,
	type: Schema.Literal("vault_credential"),
	vault_id: VaultId,
	auth: CredentialAuth,
	display_name: Schema.NullOr(Schema.String),
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type CredentialSnapshot = typeof CredentialSnapshot.Type

// ---------------------------------------------------------------------------
// MCP server schemas
// ---------------------------------------------------------------------------

export const MAX_MCP_SERVERS = 20
export const MAX_MCP_TOOL_POLICIES = 128

export const PermissionPolicy = Schema.Literals(["always_allow", "always_ask"])
export type PermissionPolicy = typeof PermissionPolicy.Type

export const McpServerName = Schema.String.check(
	Schema.isPattern(/^[A-Za-z0-9_-]{1,32}$/u, {
		expected: "1-32 letters, digits, underscores or hyphens",
	}),
)

/** An agent's server, as one session uses it: with the credential it was bound to, or none. */
export const McpServerBinding = Schema.Struct({
	name: McpServerName,
	url: McpServerUrl,
	credential_id: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
})
export type McpServerBinding = typeof McpServerBinding.Type
