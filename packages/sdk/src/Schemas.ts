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
			"The tool calls waiting for an answer, by tool_use_id. Send a user.tool_confirmation for each agent.mcp_tool_use or agent.api_tool_use and a user.custom_tool_result for each agent.custom_tool_use.",
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
	"user.custom_tool_result": {
		custom_tool_use_id: ResourceId,
		content: Schema.Array(TextBlock),
		is_error: Schema.optionalKey(Schema.Boolean),
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
	"agent.custom_tool_use": {
		tool_use_id: ResourceId,
		name: ResourceId,
		input: Schema.JsonObject,
		truncated: Schema.optionalKey(Schema.Literal(true)),
	},
	"agent.api_tool_use": {
		tool_use_id: ResourceId,
		api_server_name: ResourceId,
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
	"agent.api_tool_result": {
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

export const MAX_OAUTH_CLIENT_ID_LENGTH = 1024
export const MAX_OAUTH_SCOPE_LENGTH = 2048

export const OAuthTokenEndpoint = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_MCP_SERVER_URL_LENGTH),
)
export const OAuthClientId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_OAUTH_CLIENT_ID_LENGTH),
)
export const OAuthScope = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_OAUTH_SCOPE_LENGTH),
)
export const TokenEndpointAuthMethod = Schema.Literals([
	"none",
	"client_secret_basic",
	"client_secret_post",
])
export type TokenEndpointAuthMethod = typeof TokenEndpointAuthMethod.Type

// How the token is refreshed. The refresh token and any client secret are not part of it.
export const McpOAuthRefresh = Schema.Struct({
	token_endpoint: OAuthTokenEndpoint,
	client_id: OAuthClientId,
	scope: Schema.NullOr(OAuthScope),
	token_endpoint_auth: Schema.Struct({ type: TokenEndpointAuthMethod }),
})
export type McpOAuthRefresh = typeof McpOAuthRefresh.Type

export const McpOAuthAuth = Schema.Struct({
	type: Schema.Literal("mcp_oauth"),
	mcp_server_url: McpServerUrl,
	expires_at: Schema.NullOr(Schema.DateTimeUtc),
	refresh: Schema.NullOr(McpOAuthRefresh),
})

export const MAX_API_KEY_PLACEMENT_NAME_LENGTH = 128
export const MAX_API_KEY_PREFIX_LENGTH = 64

/** Where an API key goes in a request: a header, optionally after a prefix, or a query parameter. */
export const ApiKeyPlacement = Schema.Union([
	Schema.Struct({
		in: Schema.Literal("header"),
		name: Schema.String.check(
			Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u, {
				expected: "an HTTP header name",
			}),
		),
		prefix: Schema.optionalKey(
			Schema.String.check(
				Schema.isPattern(/^[\u0020-\u007E]{1,64}$/u, {
					expected: "1-64 printable ASCII characters",
				}),
			),
		),
	}),
	Schema.Struct({
		in: Schema.Literal("query"),
		name: Schema.String.check(
			Schema.isMinLength(1),
			Schema.isMaxLength(MAX_API_KEY_PLACEMENT_NAME_LENGTH),
		),
	}),
])
export type ApiKeyPlacement = typeof ApiKeyPlacement.Type

export const ApiKeyAuth = Schema.Struct({
	type: Schema.Literal("api_key"),
	base_url: McpServerUrl,
	placement: ApiKeyPlacement,
})

// What a credential authenticates against. The secret is never part of it.
export const CredentialAuth = Schema.Union([StaticBearerAuth, McpOAuthAuth, ApiKeyAuth])
export type CredentialAuth = typeof CredentialAuth.Type

// Held only by the credential's connection object: no command, event or view carries it.
export const CredentialSecret = Schema.Redacted(
	Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CREDENTIAL_SECRET_LENGTH)),
)
export type CredentialSecret = typeof CredentialSecret.Type

const TokenEndpointClientAuth = Schema.Union([
	Schema.Struct({ type: Schema.Literal("none") }),
	Schema.Struct({ type: Schema.Literal("client_secret_basic"), client_secret: CredentialSecret }),
	Schema.Struct({ type: Schema.Literal("client_secret_post"), client_secret: CredentialSecret }),
])

// Everything secret about a credential, as it is handed to custody and nowhere else.
export const CredentialSecretMaterial = Schema.Union([
	Schema.Struct({ type: Schema.Literal("static_bearer"), token: CredentialSecret }),
	Schema.Struct({
		type: Schema.Literal("mcp_oauth"),
		access_token: CredentialSecret,
		expires_at: Schema.NullOr(Schema.DateTimeUtc),
		refresh: Schema.NullOr(
			Schema.Struct({
				token_endpoint: OAuthTokenEndpoint,
				client_id: OAuthClientId,
				scope: Schema.NullOr(OAuthScope),
				token_endpoint_auth: TokenEndpointClientAuth,
				refresh_token: CredentialSecret,
			}),
		),
	}),
	Schema.Struct({
		type: Schema.Literal("api_key"),
		token: CredentialSecret,
		placement: ApiKeyPlacement,
	}),
])
export type CredentialSecretMaterial = typeof CredentialSecretMaterial.Type

// What replaces a held secret. Where it is sent, and how it is refreshed, cannot change.
export const CredentialSecretReplacement = Schema.Union([
	Schema.Struct({ type: Schema.Literal("static_bearer"), token: CredentialSecret }),
	Schema.Struct({
		type: Schema.Literal("mcp_oauth"),
		access_token: CredentialSecret,
		expires_at: Schema.NullOr(Schema.DateTimeUtc),
		refresh_token: Schema.NullOr(CredentialSecret),
	}),
	Schema.Struct({ type: Schema.Literal("api_key"), token: CredentialSecret }),
])
export type CredentialSecretReplacement = typeof CredentialSecretReplacement.Type

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
	// When the authorization server last refused to refresh the token; new tokens clear it.
	refresh_failed_at: Schema.NullOr(Schema.DateTimeUtc),
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

export const MAX_CUSTOM_TOOLS = 64
export const MAX_CUSTOM_TOOL_DESCRIPTION_LENGTH = 4096
export const MAX_CUSTOM_TOOL_INPUT_SCHEMA_LENGTH = 16_384

/** A name every model provider accepts for a tool. */
export const CustomToolName = Schema.String.check(
	Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u, {
		expected: "1-64 letters, digits, underscores or hyphens",
	}),
)

/** A tool the caller's own application runs: the agent asks, the application answers. */
export const CustomTool = Schema.Struct({
	type: Schema.Literal("custom"),
	name: CustomToolName,
	description: NonEmptyString.check(Schema.isMaxLength(MAX_CUSTOM_TOOL_DESCRIPTION_LENGTH)),
	input_schema: Schema.JsonObject,
})
export type CustomTool = typeof CustomTool.Type

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

// ---------------------------------------------------------------------------
// API server schemas
// ---------------------------------------------------------------------------

export const MAX_API_SERVERS = 4
export const MAX_API_SPEC_JSON_BYTES = 2 * 1024 * 1024
export const MAX_API_SERVER_OPERATIONS = 256
// One server's tools are cached by a session as one row, which holds 2 MB.
export const MAX_API_SERVER_DESCRIPTORS_JSON_BYTES = 1024 * 1024
export const MAX_API_SELECTION_ENTRIES = 256

export const ApiServerName = McpServerName

const ApiSelectionEntries = Schema.Array(
	Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
).check(Schema.isMaxLength(MAX_API_SELECTION_ENTRIES))

/** Operations of an OpenAPI document, picked by operation name or by tag. */
export const ApiSelection = Schema.Struct({
	names: Schema.optionalKey(ApiSelectionEntries),
	tags: Schema.optionalKey(ApiSelectionEntries),
})
export type ApiSelection = typeof ApiSelection.Type

/** What is kept of a server's OpenAPI document in answers: enough to tell which document it was. */
export const ApiSpecSummary = Schema.Struct({
	title: Schema.String,
	version: Schema.String,
	operations: NonNegativeInt,
	digest: Schema.String,
})
export type ApiSpecSummary = typeof ApiSpecSummary.Type

/** An agent's API server, as one session uses it: with the credential it was bound to, or none. */
export const ApiServerBinding = Schema.Struct({
	name: ApiServerName,
	base_url: McpServerUrl,
	credential_id: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
})
export type ApiServerBinding = typeof ApiServerBinding.Type
