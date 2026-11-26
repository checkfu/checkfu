import * as Schema from "effect/Schema"

export const MAX_AGENT_NAME_LENGTH = 256
export const MAX_AGENT_DESCRIPTION_LENGTH = 2048
export const MAX_AGENT_SYSTEM_LENGTH = 100_000

export const MAX_ENVIRONMENT_NAME_LENGTH = 256
export const MAX_ENVIRONMENT_DESCRIPTION_LENGTH = 1024

export const MAX_AUTOMATION_ID_LENGTH = 128
export const MAX_AUTOMATION_NAME_LENGTH = 256
export const MAX_AUTOMATION_DESCRIPTION_LENGTH = 2048
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

import { SINGLE_PATH_SEGMENT_MESSAGE } from "./PathSegment.ts"

export { SINGLE_PATH_SEGMENT_MESSAGE, isSinglePathSegment } from "./PathSegment.ts"

export const SinglePathSegmentCheck = Schema.isPattern(/^(?!\.\.?$)[^/\\]+$/, {
	message: SINGLE_PATH_SEGMENT_MESSAGE,
})

export const ResourceId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_IDENTIFIER_LENGTH),
)

export const ResourceListCursor = Schema.String.check(
	Schema.isPattern(/^\d{1,15}:[^/\\]+$/u),
).annotate({
	description:
		"Opaque cursor from a previous page's next_cursor; the page continues after it in the selected order",
})

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

export const MAX_MCP_SERVER_URL_LENGTH = 2048
export const MAX_MCP_SERVERS = 20
export const MAX_MCP_SERVER_NAME_LENGTH = 32

export const McpServerUrl = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_MCP_SERVER_URL_LENGTH),
)

export const McpServerName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_MCP_SERVER_NAME_LENGTH),
	Schema.isPattern(/^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/u, {
		expected:
			"letters, digits, hyphens and single underscores, not starting or ending with an underscore",
	}),
)
export const McpServer = Schema.Struct({
	type: Schema.Literal("url"),
	name: McpServerName,
	url: McpServerUrl,
})
export type McpServer = typeof McpServer.Type

export const McpServers = Schema.Array(McpServer).check(Schema.isMaxLength(MAX_MCP_SERVERS))

export const McpServerCredential = Schema.Struct({
	mcp_server_name: McpServerName,
	credential_id: ResourceId,
	vault_id: Schema.optionalKey(ResourceId),
})
export type McpServerCredential = typeof McpServerCredential.Type

export const McpServerCredentials = Schema.Array(McpServerCredential).check(
	Schema.isMaxLength(MAX_MCP_SERVERS),
)

export const PermissionPolicy = Schema.Literals(["always_allow", "always_ask"])
export type PermissionPolicy = typeof PermissionPolicy.Type

export const MAX_MCP_TOOL_POLICIES = 128
export const MAX_MCP_TOOL_NAME_LENGTH = 128
export const MAX_CUSTOM_TOOLS = 64
export const MAX_CUSTOM_TOOL_DESCRIPTION_LENGTH = 4096
export const MAX_CUSTOM_TOOL_INPUT_SCHEMA_LENGTH = 16_384

const PermissionConfig = Schema.Struct({
	permission_policy: Schema.optionalKey(Schema.Struct({ type: PermissionPolicy })),
})

export const McpToolset = Schema.Struct({
	type: Schema.Literal("mcp_toolset"),
	mcp_server_name: McpServerName,
	default_config: Schema.optionalKey(PermissionConfig).annotate({
		description:
			"Applies to tools without their own configuration. MCP tools require confirmation by default.",
	}),
	configs: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				name: Schema.String.check(
					Schema.isMinLength(1),
					Schema.isMaxLength(MAX_MCP_TOOL_NAME_LENGTH),
				),
				...PermissionConfig.fields,
			}),
		).check(Schema.isMaxLength(MAX_MCP_TOOL_POLICIES)),
	),
})
export type McpToolset = typeof McpToolset.Type

export const CustomToolName = Schema.String.check(
	Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u, {
		expected: "1-64 letters, digits, underscores or hyphens",
	}),
)

export const CustomTool = Schema.Struct({
	type: Schema.Literal("custom"),
	name: CustomToolName,
	description: NonEmptyString.check(Schema.isMaxLength(MAX_CUSTOM_TOOL_DESCRIPTION_LENGTH)),
	input_schema: Schema.JsonObject,
})
export type CustomTool = typeof CustomTool.Type

export const AgentTool = Schema.Union([McpToolset, CustomTool])
export type AgentTool = typeof AgentTool.Type

export const AgentTools = Schema.Array(AgentTool).check(
	Schema.isMaxLength(MAX_MCP_SERVERS + MAX_CUSTOM_TOOLS),
)

export const AgentSnapshot = Schema.Struct({
	id: AgentId,
	type: Schema.Literal("agent"),
	version: PositiveInt,
	current_version_id: AgentVersionId,
	name: NonEmptyString,
	model: AgentModel,
	system: Schema.NullOr(Schema.String),
	description: Schema.NullOr(Schema.String),
	mcp_servers: McpServers,
	tools: AgentTools,
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type AgentSnapshot = typeof AgentSnapshot.Type

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

export const IdleStopReason = Schema.Struct({
	type: Schema.Literals([...StopReason.fields.type.literals, "requires_action"]),
})
export type IdleStopReason = typeof IdleStopReason.Type

export const RequiresActionStopReason = Schema.Struct({
	type: Schema.Literal("requires_action"),
	event_ids: Schema.Array(Schema.String).annotate({
		description:
			"The tool calls waiting for an answer, by tool_use_id. Send a user.tool_confirmation for each agent.mcp_tool_use and a user.custom_tool_result for each agent.custom_tool_use.",
	}),
})
export type RequiresActionStopReason = typeof RequiresActionStopReason.Type

export const CancelledEventIds = Schema.Array(Schema.String).annotate({
	description:
		"The tool calls that still waited for an answer when the turn ended, by tool_use_id. The end of the turn cancelled them: they can no longer be answered.",
})

export const MAX_DENY_MESSAGE_LENGTH = 4096
export const MAX_CUSTOM_TOOL_RESULT_LENGTH = 16_384

export const EvaluatedPermission = Schema.Literals(["allow", "ask"])
export type EvaluatedPermission = typeof EvaluatedPermission.Type

export const ToolConfirmationResult = Schema.Literals(["allow", "deny"])
export type ToolConfirmationResult = typeof ToolConfirmationResult.Type

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

export const ToolRejection = Schema.Literals(["unavailable", "invalid_arguments", "blocked"])
export type ToolRejection = typeof ToolRejection.Type

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
		name: ResourceId.annotate({
			description:
				"The tool the model called. A code mode script is one call named codemode: its code is the input and its output the result; the calls the script makes are not published separately.",
		}),
		input: Schema.JsonObject,
		truncated: Schema.optionalKey(Schema.Literal(true)),
	},
	"agent.tool_result": {
		tool_use_id: ResourceId,
		content: Schema.Array(TextBlock),
		is_error: Schema.Boolean,
		truncated: Schema.optionalKey(Schema.Literal(true)),
		rejected: Schema.optionalKey(ToolRejection),
	},
	"agent.mcp_tool_use": {
		tool_use_id: ResourceId,
		mcp_server_name: McpServerName,
		name: ResourceId,
		input: Schema.JsonObject,
		evaluated_permission: Schema.optionalKey(
			EvaluatedPermission.annotate({
				description: "allow: the call ran without asking. ask: it waited for a confirmation.",
			}),
		),
		truncated: Schema.optionalKey(Schema.Literal(true)),
	},
	"agent.mcp_tool_result": {
		tool_use_id: ResourceId,
		content: Schema.Array(TextBlock),
		is_error: Schema.Boolean,
		truncated: Schema.optionalKey(Schema.Literal(true)),
		rejected: Schema.optionalKey(ToolRejection),
	},
	"agent.custom_tool_use": {
		tool_use_id: ResourceId,
		name: ResourceId,
		input: Schema.JsonObject,
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
		stop_reason: IdleStopReason,
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
	mcp_server_credentials: McpServerCredentials,
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type SessionSnapshot = typeof SessionSnapshot.Type

export const AutomationName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_AUTOMATION_NAME_LENGTH),
)

export const AutomationDescription = Schema.String.check(
	Schema.isMaxCodePoints(MAX_AUTOMATION_DESCRIPTION_LENGTH),
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
	description: Schema.NullOr(AutomationDescription),
	agent_id: ResourceId,
	agent_version: Schema.NullOr(PositiveInt),
	environment_id: ResourceId,
	text: MessageText,
	schedule: AutomationSchedule,
	status: Schema.Literals(["active", "paused", "archived"]),
	pause_reason: Schema.NullOr(Schema.String),
	runs: NonNegativeInt,
	activation: NonNegativeInt,
	revision: PositiveInt,
	upcoming: Schema.Array(NonNegativeInt),
	last_run_at: Schema.NullOr(Schema.DateTimeUtc),
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type AutomationSnapshot = typeof AutomationSnapshot.Type

import {
	MAX_ARTIFACT_CONTENT_TYPE_LENGTH,
	MAX_ARTIFACT_FILES,
	MAX_ARTIFACT_NAME_LENGTH,
	MAX_ARTIFACT_PATH_LENGTH,
	MAX_INLINE_TOTAL_BYTES,
} from "./Limits.ts"

export {
	MAX_ARTIFACT_CONTENT_TYPE_LENGTH,
	MAX_ARTIFACT_FILES,
	MAX_ARTIFACT_FILE_BYTES,
	MAX_ARTIFACT_NAME_LENGTH,
	MAX_ARTIFACT_PATH_LENGTH,
	MAX_ARTIFACT_TOTAL_BYTES,
	MAX_INLINE_FILE_BYTES,
	MAX_INLINE_TOTAL_BYTES,
} from "./Limits.ts"

const JSON_ESCAPE_ALLOWANCE = 3
export const MAX_ARTIFACT_BODY_BYTES =
	MAX_INLINE_TOTAL_BYTES * JSON_ESCAPE_ALLOWANCE +
	MAX_ARTIFACT_FILES * (MAX_ARTIFACT_PATH_LENGTH * 6 + 512) +
	16 * 1024

export const MIN_LINK_TTL_SECONDS = 60
export const DEFAULT_LINK_TTL_SECONDS = 60 * 60
export const MAX_LINK_TTL_SECONDS = 7 * 24 * 60 * 60

export const ArtifactId = Schema.String.check(Schema.isMinLength(1)).pipe(
	Schema.brand("ArtifactId"),
)
export type ArtifactId = typeof ArtifactId.Type

export const PUBLICATION_TOKEN_LENGTH = 25

export const PublicationAddress = Schema.String.check(
	Schema.isPattern(/^a[0-9a-f]{1,32}-[0-9a-z]{25}$/u),
).pipe(Schema.brand("PublicationAddress"))
export type PublicationAddress = typeof PublicationAddress.Type

export const ArtifactName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_ARTIFACT_NAME_LENGTH),
)

const PATH_EXCLUDED = String.raw`/\\\u0000-\u001f\u007f-\u009f\u2028\u2029`
const PATH_SEGMENT = String.raw`(?:[^.${PATH_EXCLUDED}][^${PATH_EXCLUDED}]*|\.[^.${PATH_EXCLUDED}][^${PATH_EXCLUDED}]*|\.\.[^${PATH_EXCLUDED}]+)`
const ARTIFACT_PATH = new RegExp(String.raw`^${PATH_SEGMENT}(?:/${PATH_SEGMENT})*$`, "u")

export const ArtifactPath = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_ARTIFACT_PATH_LENGTH),
	Schema.makeFilter((path) => (path.isWellFormed() ? undefined : "Expected well-formed Unicode")),
	Schema.isPattern(ARTIFACT_PATH),
)
export type ArtifactPath = typeof ArtifactPath.Type

export const ArtifactContentType = Schema.String.check(
	Schema.isMinCodePoints(3),
	Schema.isMaxCodePoints(MAX_ARTIFACT_CONTENT_TYPE_LENGTH),
	Schema.isPattern(
		/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(?:; ?[ -~]+)?$/u,
	),
)

export const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))

export const ArtifactFileInput = Schema.Struct({
	path: ArtifactPath.annotate({
		description: "Relative path inside the artifact, for example index.html or assets/app.js",
	}),
	content: Schema.String.annotate({
		description: "File content: text, or base64 when encoding is base64",
	}),
	encoding: Schema.optionalKey(
		Schema.Literals(["utf8", "base64"]).annotate({
			description: "How content is encoded (default utf8)",
		}),
	),
	content_type: Schema.optionalKey(
		ArtifactContentType.annotate({
			description: "Media type; inferred from the path extension when omitted",
		}),
	),
})
export type ArtifactFileInput = typeof ArtifactFileInput.Type

export const ArtifactFilesInput = Schema.Array(ArtifactFileInput).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ARTIFACT_FILES),
)

export const ArtifactKeptFileInput = Schema.Struct({
	path: ArtifactPath.annotate({
		description: "Relative path inside the artifact, for example index.html or assets/app.js",
	}),
	sha256: Sha256Hex.annotate({
		description:
			"sha256 of bytes this artifact already holds: a file of an earlier version, or bytes uploaded with PUT /v1/artifacts/{artifact_id}/blobs/{sha256}",
	}),
	content_type: Schema.optionalKey(
		ArtifactContentType.annotate({
			description: "Media type; inferred from the path extension when omitted",
		}),
	),
})
export type ArtifactKeptFileInput = typeof ArtifactKeptFileInput.Type

export const ArtifactVersionFileInput = Schema.Union([ArtifactFileInput, ArtifactKeptFileInput])
export type ArtifactVersionFileInput = typeof ArtifactVersionFileInput.Type

export const ArtifactVersionFilesInput = Schema.Array(ArtifactVersionFileInput).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ARTIFACT_FILES),
)

export const ArtifactFile = Schema.Struct({
	path: ArtifactPath,
	sha256: Sha256Hex,
	size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	content_type: Schema.String,
})
export type ArtifactFile = typeof ArtifactFile.Type

export const MAX_WEBHOOK_ID_LENGTH = 128
export const MAX_WEBHOOK_EVENT_ID_LENGTH = 320
export const MAX_WEBHOOK_URL_LENGTH = 2048
export const MAX_WEBHOOK_DESCRIPTION_LENGTH = 1024
export const MAX_WEBHOOK_EVENT_TYPES = 64

export const WebhookId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_WEBHOOK_ID_LENGTH),
	SinglePathSegmentCheck,
).pipe(Schema.brand("WebhookId"))
export type WebhookId = typeof WebhookId.Type

export const WebhookDeliveryId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_WEBHOOK_ID_LENGTH),
	SinglePathSegmentCheck,
).pipe(Schema.brand("WebhookDeliveryId"))
export type WebhookDeliveryId = typeof WebhookDeliveryId.Type

export const WebhookEventId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_WEBHOOK_EVENT_ID_LENGTH),
).pipe(Schema.brand("WebhookEventId"))
export type WebhookEventId = typeof WebhookEventId.Type

export const WebhookUrl = Schema.String.check(
	Schema.isMinLength(8),
	Schema.isMaxCodePoints(MAX_WEBHOOK_URL_LENGTH),
)

export const WebhookDescription = Schema.String.check(
	Schema.isMaxCodePoints(MAX_WEBHOOK_DESCRIPTION_LENGTH),
)

export const WEBHOOK_EVENT_TYPES = [
	"agent.created",
	"agent.updated",
	"agent.archived",
	"environment.created",
	"environment.updated",
	"environment.archived",
	"environment.deleted",
	"session.status_run_started",
	"session.status_idled",
	"session.status_terminated",
	"automation.created",
	"automation.updated",
	"automation.paused",
	"automation.unpaused",
	"automation.archived",
	"automation_run.started",
	"automation_run.succeeded",
	"automation_run.failed",
	"artifact.created",
	"artifact.version_added",
	"artifact.published",
	"artifact.unpublished",
	"artifact.deleted",
	"vault.created",
	"vault.archived",
	"vault.deleted",
	"vault_credential.created",
	"vault_credential.archived",
	"vault_credential.deleted",
	"webhook.test",
] as const

export const WebhookEventType = Schema.Literals(WEBHOOK_EVENT_TYPES)
export type WebhookEventType = typeof WebhookEventType.Type

export const WebhookEventSubscription = Schema.Literals(["*", ...WEBHOOK_EVENT_TYPES])
export type WebhookEventSubscription = typeof WebhookEventSubscription.Type

export const WebhookEndpointStatus = Schema.Literals([
	"active",
	"paused",
	"disabled_redirect",
	"disabled_sustained_failure",
	"deleted",
])
export type WebhookEndpointStatus = typeof WebhookEndpointStatus.Type

export const WebhookDeliveryStatus = Schema.Literals(["pending", "succeeded", "failed", "skipped"])
export type WebhookDeliveryStatus = typeof WebhookDeliveryStatus.Type

export const WebhookDeliveryOutcome = Schema.Literals([
	"http_2xx",
	"http_redirect",
	"http_4xx",
	"http_5xx",
	"timeout",
	"network_error",
	"invalid_destination",
])
export type WebhookDeliveryOutcome = typeof WebhookDeliveryOutcome.Type

export const MAX_VAULT_DISPLAY_NAME_LENGTH = 255
export const MAX_CREDENTIAL_DISPLAY_NAME_LENGTH = 255
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
export const StaticBearerAuth = Schema.Struct({
	type: Schema.Literal("static_bearer"),
	mcp_server_url: McpServerUrl,
})

export const CredentialAuth = Schema.Union([StaticBearerAuth])
export type CredentialAuth = typeof CredentialAuth.Type

export const MIN_CREDENTIAL_SECRET_LENGTH = 8

export const CredentialSecret = Schema.Redacted(
	Schema.String.check(
		Schema.isMinCodePoints(MIN_CREDENTIAL_SECRET_LENGTH),
		Schema.isMaxLength(MAX_CREDENTIAL_SECRET_LENGTH),
		Schema.isPattern(/^[!-~]+$/u, {
			description: "visible ASCII characters, with no spaces or line breaks",
		}),
	),
)
export type CredentialSecret = typeof CredentialSecret.Type

export const CredentialCustody = Schema.Literals(["storing", "held", "erasing", "erased"]).annotate(
	{
		description:
			"Where the secret stands: storing until its storage confirms the secret, held while the credential is active, erasing once it is archived or deleted, erased once its storage confirmed the secret is gone",
	},
)
export type CredentialCustody = typeof CredentialCustody.Type

export const VaultCustody = Schema.Struct({
	storing: NonNegativeInt.annotate({
		description: "Active credentials whose secrets are not yet confirmed stored",
	}),
	held: NonNegativeInt.annotate({ description: "Active credentials whose secrets are held" }),
	erasing: NonNegativeInt.annotate({
		description: "Archived or deleted credentials whose secrets are not yet confirmed erased",
	}),
})
export type VaultCustody = typeof VaultCustody.Type

export const VaultSnapshot = Schema.Struct({
	id: VaultId,
	type: Schema.Literal("vault"),
	display_name: NonEmptyString,
	custody: VaultCustody,
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
	custody: CredentialCustody,
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	archived_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type CredentialSnapshot = typeof CredentialSnapshot.Type
