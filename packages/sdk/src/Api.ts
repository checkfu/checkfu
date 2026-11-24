import type * as Effect from "effect/Effect"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiClient from "effect/http-api/HttpApiClient"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware"
import * as HttpApiSchema from "effect/http-api/HttpApiSchema"
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity"
import * as OpenApi from "effect/http-api/OpenApi"
import type * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientError from "effect/http/HttpClientError"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as Struct from "effect/Struct"
import {
	AgentDescription,
	AgentId,
	AgentModel,
	AgentName,
	AgentSnapshot,
	AgentSystem,
	AutomationId,
	AutomationName,
	AutomationRunError,
	AutomationSchedule,
	AutomationSnapshot,
	CredentialDisplayName,
	CredentialId,
	CredentialSecret,
	CredentialSnapshot,
	CustomTool,
	DenyMessage,
	EnvironmentConfig,
	EnvironmentDescription,
	EnvironmentId,
	EnvironmentName,
	EnvironmentSnapshot,
	MAX_CUSTOM_TOOLS,
	MAX_MCP_SERVERS,
	MAX_MCP_SERVER_URL_LENGTH,
	MAX_MCP_TOOL_POLICIES,
	McpServerBinding,
	McpServerName,
	NonEmptyString,
	PermissionPolicy,
	PositiveInt,
	ResourceId,
	SessionEventFields,
	SessionId,
	SessionSnapshot,
	SessionTitle,
	TextBlock,
	TextBlocks,
	ToolConfirmationResult,
	VaultDisplayName,
	VaultId,
	VaultSnapshot,
} from "./Schemas.ts"
import type { SessionEventType } from "./Schemas.ts"

export const REQUEST_ID_HEADER = "request-id"

export const RequestId = NonEmptyString.pipe(Schema.brand("RequestId"))
export type RequestId = typeof RequestId.Type

const ErrorAccepted = Schema.Array(Schema.Unknown)
const ErrorIndex = Schema.Finite
const isErrorIndex = Schema.is(ErrorIndex)

export const HANDLER_ERROR_TYPES = {
	400: "invalid_request_error",
	404: "not_found_error",
	409: "conflict_error",
	429: "rate_limit_error",
	500: "internal_error",
	503: "service_unavailable",
} as const

export const ERROR_TYPES = {
	...HANDLER_ERROR_TYPES,
	401: "authentication_error",
	413: "payload_too_large",
	415: "unsupported_media_type",
} as const

export type HandlerErrorStatus = keyof typeof HANDLER_ERROR_TYPES
export type ErrorStatus = keyof typeof ERROR_TYPES
export type HandlerErrorType = (typeof HANDLER_ERROR_TYPES)[HandlerErrorStatus]
export type ApiErrorType = (typeof ERROR_TYPES)[ErrorStatus]

const errorEnvelope = <const S extends ErrorStatus>(status: S) =>
	Schema.Struct({
		type: Schema.Literal("error"),
		error: Schema.Struct({
			type: Schema.Literal(ERROR_TYPES[status]),
			message: Schema.String,
		}),
		request_id: RequestId,
		accepted: Schema.optionalKey(ErrorAccepted),
		failed_index: Schema.optionalKey(ErrorIndex),
		unconfirmed_index: Schema.optionalKey(ErrorIndex),
	}).pipe(HttpApiSchema.status(status))

export const ERRORS = {
	400: errorEnvelope(400),
	401: errorEnvelope(401),
	404: errorEnvelope(404),
	409: errorEnvelope(409),
	413: errorEnvelope(413),
	415: errorEnvelope(415),
	429: errorEnvelope(429),
	500: errorEnvelope(500),
	503: errorEnvelope(503),
} as const

export type ApiError = (typeof ERRORS)[ErrorStatus]["Type"]
export type HandlerError = (typeof ERRORS)[HandlerErrorStatus]["Type"]

interface ApiErrorExtra {
	readonly accepted?: ReadonlyArray<unknown>
	readonly failed_index?: number
	readonly unconfirmed_index?: number
}

const makeError =
	<const S extends ErrorStatus>(status: S) =>
	(message: string, request_id: RequestId, extra?: ApiErrorExtra) => ({
		type: "error" as const,
		error: { type: ERROR_TYPES[status], message },
		request_id: RequestId.make(request_id),
		...extra,
	})

type ErrorFactories = {
	readonly [S in ErrorStatus]: (
		message: string,
		request_id: RequestId,
		extra?: ApiErrorExtra,
	) => (typeof ERRORS)[S]["Type"]
}

const ERROR_FACTORIES = {
	400: makeError(400),
	401: makeError(401),
	404: makeError(404),
	409: makeError(409),
	413: makeError(413),
	415: makeError(415),
	429: makeError(429),
	500: makeError(500),
	503: makeError(503),
} satisfies ErrorFactories

export const apiError = <S extends ErrorStatus>(
	status: S,
	message: string,
	request_id: RequestId,
	extra?: ApiErrorExtra,
): (typeof ERRORS)[S]["Type"] => ERROR_FACTORIES[status](message, request_id, extra)

const HANDLER_ERROR_STATUS_ENTRIES: ReadonlyArray<readonly [HandlerErrorType, HandlerErrorStatus]> =
	[
		[HANDLER_ERROR_TYPES[400], 400],
		[HANDLER_ERROR_TYPES[404], 404],
		[HANDLER_ERROR_TYPES[409], 409],
		[HANDLER_ERROR_TYPES[429], 429],
		[HANDLER_ERROR_TYPES[500], 500],
		[HANDLER_ERROR_TYPES[503], 503],
	]

const ALL_ERROR_STATUS_ENTRIES: ReadonlyArray<readonly [ApiErrorType, ErrorStatus]> = [
	...HANDLER_ERROR_STATUS_ENTRIES,
	[ERROR_TYPES[401], 401],
	[ERROR_TYPES[413], 413],
	[ERROR_TYPES[415], 415],
]

const HANDLER_ERROR_STATUS_BY_TYPE: ReadonlyMap<HandlerErrorType, HandlerErrorStatus> = new Map(
	HANDLER_ERROR_STATUS_ENTRIES,
)

export const STATUS_OF_ERROR_TYPE: ReadonlyMap<string, ErrorStatus> = new Map(
	ALL_ERROR_STATUS_ENTRIES,
)

export const API_ERROR_TYPE_LITERALS = [
	ERROR_TYPES[400],
	ERROR_TYPES[401],
	ERROR_TYPES[404],
	ERROR_TYPES[409],
	ERROR_TYPES[413],
	ERROR_TYPES[415],
	ERROR_TYPES[429],
	ERROR_TYPES[500],
	ERROR_TYPES[503],
] as const

export const isApiErrorType = (type: unknown): type is ApiErrorType =>
	typeof type === "string" && STATUS_OF_ERROR_TYPE.has(type)

export const statusOfErrorType = (type: ApiErrorType): ErrorStatus =>
	STATUS_OF_ERROR_TYPE.get(type) ?? 500

export const statusOf = (error: ApiError): ErrorStatus => statusOfErrorType(error.error.type)

const HandlerErrorInput = Schema.Struct({
	type: Schema.Literal("error"),
	error: Schema.Struct({
		type: Schema.Literals([
			HANDLER_ERROR_TYPES[400],
			HANDLER_ERROR_TYPES[404],
			HANDLER_ERROR_TYPES[409],
			HANDLER_ERROR_TYPES[429],
			HANDLER_ERROR_TYPES[500],
			HANDLER_ERROR_TYPES[503],
		]),
		message: Schema.String,
	}),
	accepted: Schema.optional(ErrorAccepted),
	failed_index: Schema.optional(ErrorIndex),
	unconfirmed_index: Schema.optional(ErrorIndex),
})

const decodeHandlerErrorInput = Schema.decodeUnknownOption(HandlerErrorInput)

export const parseHandlerError = (
	err: unknown,
	request_id: RequestId,
): HandlerError | undefined => {
	const decoded = decodeHandlerErrorInput(err)
	if (Option.isNone(decoded)) {
		return undefined
	}
	const { error, accepted, failed_index, unconfirmed_index } = decoded.value
	const status = HANDLER_ERROR_STATUS_BY_TYPE.get(error.type) ?? 500
	return apiError(status, error.message, request_id, {
		...(accepted === undefined ? {} : { accepted }),
		...(failed_index === undefined ? {} : { failed_index }),
		...(unconfirmed_index === undefined ? {} : { unconfirmed_index }),
	})
}

export interface LoggableApiFailure {
	readonly error_type: ApiErrorType | "unknown"
	readonly accepted_count?: number
	readonly failed_index?: number
	readonly unconfirmed_index?: number
}

export const redactApiErrorEnvelope = (error: unknown): LoggableApiFailure | null => {
	if (typeof error !== "object" || error === null || !("type" in error) || error.type !== "error") {
		return null
	}
	const nestedError =
		"error" in error && typeof error.error === "object" && error.error !== null
			? error.error
			: undefined
	const errorType: ApiErrorType | "unknown" =
		nestedError !== undefined && "type" in nestedError && isApiErrorType(nestedError.type)
			? nestedError.type
			: "unknown"
	const acceptedCount =
		"accepted" in error && Array.isArray(error.accepted) ? error.accepted.length : undefined
	const failedIndex =
		"failed_index" in error && isErrorIndex(error.failed_index) ? error.failed_index : undefined
	const unconfirmedIndex =
		"unconfirmed_index" in error && isErrorIndex(error.unconfirmed_index)
			? error.unconfirmed_index
			: undefined
	return {
		error_type: errorType,
		...(acceptedCount === undefined ? {} : { accepted_count: acceptedCount }),
		...(failedIndex === undefined ? {} : { failed_index: failedIndex }),
		...(unconfirmedIndex === undefined ? {} : { unconfirmed_index: unconfirmedIndex }),
	}
}

const HandlerErrors = [ERRORS[400], ERRORS[404], ERRORS[409], ERRORS[429], ERRORS[500], ERRORS[503]]
const BodyErrors = [...HandlerErrors, ERRORS[413], ERRORS[415]]

// @effect-diagnostics-next-line leakingRequirements:off
export class Authentication extends HttpApiMiddleware.Service<Authentication>()(
	"@checkfu/api/Authentication",
	{
		security: {
			bearer: HttpApiSecurity.bearer,
			apiKey: HttpApiSecurity.apiKey({ in: "header", key: "x-api-key" }),
		},
		error: [ERRORS[401], ERRORS[503]],
	},
) {}

export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
	"@checkfu/api/RequestValidation",
	{ error: [ERRORS[400], ERRORS[500]] },
) {}

export class AgentBodyLimit extends HttpApiMiddleware.Service<AgentBodyLimit>()(
	"@checkfu/api/AgentBodyLimit",
) {}

export class EventBatchBodyLimit extends HttpApiMiddleware.Service<EventBatchBodyLimit>()(
	"@checkfu/api/EventBatchBodyLimit",
) {}

// HTTPS, or plain HTTP to this machine only, and never with credentials in the URL.
const MCP_SERVER_URL =
	/^(?:https:\/\/[^\s/?#@]+|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?)(?:[/?#]\S*)?$/u

const McpServerUrlInput = Schema.String.check(
	Schema.isMaxLength(MAX_MCP_SERVER_URL_LENGTH),
	Schema.isPattern(MCP_SERVER_URL, { expected: "an https:// URL of an MCP server" }),
)

export const McpServerInput = Schema.Struct({
	type: Schema.Literal("url"),
	name: McpServerName.annotate({
		description: "Name the agent's tools and a session's credential binding refer to",
	}),
	url: McpServerUrlInput.annotate({ description: "Endpoint URL of the MCP server" }),
})
export type McpServerInput = typeof McpServerInput.Type

const McpServersInput = Schema.Array(McpServerInput)
	.check(Schema.isMaxLength(MAX_MCP_SERVERS))
	.annotate({ description: "MCP servers this agent connects to. Names must be unique." })

const PermissionPolicyInput = Schema.Struct({
	type: PermissionPolicy.annotate({
		description:
			"always_allow runs the tool without asking; always_ask pauses the session until the call is confirmed",
	}),
})

export const McpToolsetInput = Schema.Struct({
	type: Schema.Literal("mcp_toolset"),
	mcp_server_name: McpServerName.annotate({
		description: "The MCP server, by its name in mcp_servers, whose tools this configures",
	}),
	default_config: Schema.optionalKey(
		Schema.Struct({ permission_policy: Schema.optionalKey(PermissionPolicyInput) }).annotate({
			description:
				"Applies to every tool of the server without an entry in configs. When no policy is given, a tool the server marks read-only runs without asking and every other tool asks.",
		}),
	),
	configs: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				name: NonEmptyString.check(Schema.isMaxLength(256)).annotate({
					description: "The tool's name on the MCP server",
				}),
				permission_policy: Schema.optionalKey(PermissionPolicyInput),
			}),
		).check(Schema.isMaxLength(MAX_MCP_TOOL_POLICIES)),
	),
})
export type McpToolsetInput = typeof McpToolsetInput.Type

export const CustomToolInput = Schema.Struct({
	type: Schema.Literal("custom"),
	name: CustomTool.fields.name.annotate({
		description:
			"Name the agent calls the tool by. Unique among the agent's tools; it cannot start with mcp__ or be the name of a built-in tool.",
	}),
	description: CustomTool.fields.description.annotate({
		description: "What the tool does, as the agent is told",
	}),
	input_schema: CustomTool.fields.input_schema.annotate({
		description: 'JSON Schema of the tool\'s input. Its type must be "object".',
	}),
})
export type CustomToolInput = typeof CustomToolInput.Type

const AgentToolInput = Schema.Union([McpToolsetInput, CustomToolInput])

const AgentToolsInput = Schema.Array(AgentToolInput)
	.check(Schema.isMaxLength(MAX_MCP_SERVERS + MAX_CUSTOM_TOOLS))
	.annotate({
		description:
			"Tools and tool configuration. An mcp_toolset sets when the tools of one of the agent's MCP servers must be confirmed before they run, at most one per server. A custom tool is run by your application: the session pauses on agent.custom_tool_use until you send its user.custom_tool_result.",
	})

const ModelInput = Schema.Union([NonEmptyString, AgentModel])

export const CreateAgentBody = Schema.Struct({
	name: AgentName.annotate({ description: "Human-readable agent name" }),
	model: ModelInput.annotate({
		description: "Model ID string or model object ({id})",
	}),
	system: Schema.optionalKey(
		Schema.NullOr(AgentSystem).annotate({ description: "System prompt text" }),
	),
	description: Schema.optionalKey(
		Schema.NullOr(AgentDescription).annotate({ description: "Agent description" }),
	),
	mcp_servers: Schema.optionalKey(McpServersInput),
	tools: Schema.optionalKey(AgentToolsInput),
})
export type CreateAgentBody = typeof CreateAgentBody.Type

export const UpdateAgentBody = Schema.Struct({
	version: PositiveInt.annotate({
		description: "Current agent version for optimistic concurrency",
	}),
	name: Schema.optionalKey(AgentName.annotate({ description: "Updated agent name" })),
	model: Schema.optionalKey(
		ModelInput.annotate({
			description: "Updated model ID string or model object ({id})",
		}),
	),
	system: Schema.optionalKey(
		Schema.NullOr(AgentSystem).annotate({ description: "Updated system prompt text" }),
	),
	description: Schema.optionalKey(
		Schema.NullOr(AgentDescription).annotate({
			description: "Updated agent description",
		}),
	),
	mcp_servers: Schema.optionalKey(McpServersInput),
	tools: Schema.optionalKey(AgentToolsInput),
})
export type UpdateAgentBody = typeof UpdateAgentBody.Type

export const CreateEnvironmentBody = Schema.Struct({
	name: EnvironmentName.annotate({ description: "Human-readable environment name" }),
	description: Schema.optionalKey(
		Schema.NullOr(EnvironmentDescription).annotate({
			description: "Environment description",
		}),
	),
	config: Schema.optionalKey(
		EnvironmentConfig.annotate({
			description: "Environment configuration object",
		}),
	),
})
export type CreateEnvironmentBody = typeof CreateEnvironmentBody.Type

export const UpdateEnvironmentBody = Schema.Struct({
	version: PositiveInt.annotate({
		description: "Current environment version for optimistic concurrency",
	}),
	name: Schema.optionalKey(EnvironmentName.annotate({ description: "Updated environment name" })),
	description: Schema.optionalKey(
		Schema.NullOr(EnvironmentDescription).annotate({
			description: "Updated environment description",
		}),
	),
	config: Schema.optionalKey(
		EnvironmentConfig.annotate({
			description: "Updated environment configuration object",
		}),
	),
})
export type UpdateEnvironmentBody = typeof UpdateEnvironmentBody.Type

const AgentReference = Schema.Union([
	ResourceId,
	Schema.Struct({ id: ResourceId, version: Schema.optionalKey(PositiveInt) }),
])

const CreateSessionCommonFields = {
	agent_version: Schema.optionalKey(
		PositiveInt.annotate({ description: "Optional pinned agent version" }),
	),
	environment_id: ResourceId.annotate({ description: "Environment ID for the session" }),
	title: Schema.optionalKey(
		Schema.NullOr(SessionTitle).annotate({ description: "Optional session title" }),
	),
	vault_ids: Schema.optionalKey(
		Schema.Array(ResourceId).check(Schema.isMaxLength(MAX_MCP_SERVERS)).annotate({
			description:
				"Vaults whose credentials the session may use. A server is bound to the one credential stored for its URL; when several match, bind it in mcp_server_credentials.",
		}),
	),
	mcp_server_credentials: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				mcp_server_name: McpServerName,
				credential_id: ResourceId,
			}),
		)
			.check(Schema.isMaxLength(MAX_MCP_SERVERS))
			.annotate({
				description:
					"Binds one of the agent's MCP servers to a credential by id, whatever vault_ids would match.",
			}),
	),
}

export const CreateSessionBody = Schema.Union([
	Schema.Struct({
		agent: AgentReference.annotate({
			description: "Agent ID string or agent reference object ({id, version})",
		}),
		agent_id: Schema.optionalKey(
			ResourceId.annotate({ description: "Agent ID (alternative to agent)" }),
		),
		...CreateSessionCommonFields,
	}),
	Schema.Struct({
		agent: Schema.optionalKey(
			AgentReference.annotate({
				description: "Agent ID string or agent reference object ({id, version})",
			}),
		),
		agent_id: ResourceId.annotate({ description: "Agent ID (alternative to agent)" }),
		...CreateSessionCommonFields,
	}),
])
export type CreateSessionBody = typeof CreateSessionBody.Type

const AutomationInitialEvent = Schema.Struct({
	type: Schema.Literal("user.message"),
	content: Schema.Array(
		Schema.Struct({ type: Schema.Literal("text"), text: NonEmptyString }),
	).check(Schema.isMinLength(1)),
})

const AutomationInitialEvents = Schema.Array(AutomationInitialEvent).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(1),
)

export const CreateAutomationBody = Schema.Struct({
	name: AutomationName.annotate({ description: "Human-readable automation name" }),
	agent: AgentReference.annotate({
		description:
			"Agent ID string, which follows the agent's latest version, or an agent reference object ({id, version}) that pins one",
	}),
	environment_id: ResourceId.annotate({ description: "Environment ID each run's session uses" }),
	initial_events: AutomationInitialEvents.annotate({
		description: "The one user message each run's session starts with",
	}),
	schedule: AutomationSchedule.annotate({
		description:
			"When the automation fires: a cron expression that names a single minute, so it fires at most once per clock hour, read in an IANA time zone name such as America/New_York",
	}),
})
export type CreateAutomationBody = typeof CreateAutomationBody.Type

export const ClientEventId = Schema.String.check(
	Schema.isTrimmed(),
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
)
export type ClientEventId = typeof ClientEventId.Type

export const SendSessionEventsBody = Schema.Struct({
	events: Schema.Array(
		Schema.Union([
			Schema.Struct({
				id: Schema.optionalKey(ClientEventId),
				type: Schema.Literal("user.message"),
				content: Schema.Array(
					Schema.Struct({ type: Schema.Literal("text"), text: NonEmptyString }),
				).check(Schema.isMinLength(1)),
			}),
			Schema.Struct({
				id: Schema.optionalKey(ClientEventId),
				type: Schema.Literal("user.interrupt"),
			}),
			Schema.Struct({
				id: Schema.optionalKey(ClientEventId),
				type: Schema.Literal("user.tool_confirmation"),
				tool_use_id: ResourceId.annotate({
					description:
						"The waiting tool call, as listed in stop_reason.event_ids of the session's requires_action idle event",
				}),
				result: ToolConfirmationResult,
				deny_message: Schema.optionalKey(
					DenyMessage.annotate({ description: "Why the call was denied, as the agent is told" }),
				),
			}),
			Schema.Struct({
				id: Schema.optionalKey(ClientEventId),
				type: Schema.Literal("user.custom_tool_result"),
				custom_tool_use_id: ResourceId.annotate({
					description:
						"The waiting custom tool call: the tool_use_id of its agent.custom_tool_use event, as listed in stop_reason.event_ids",
				}),
				content: Schema.Array(TextBlock).annotate({
					description:
						"The tool's result, as the agent is told. Text blocks are joined with newlines and recorded as one.",
				}),
				is_error: Schema.optionalKey(
					Schema.Boolean.annotate({ description: "Whether the tool failed" }),
				),
			}),
		]),
	).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
})
export type SendSessionEventsBody = typeof SendSessionEventsBody.Type

export const AgentResource = Schema.Struct({
	...Struct.omit(AgentSnapshot.fields, ["current_version_id"]),
	mcp_servers: Schema.Array(McpServerInput),
	tools: Schema.Array(AgentToolInput),
})
export type Agent = typeof AgentResource.Type

export type Environment = EnvironmentSnapshot

export const EnvironmentDeleted = Schema.Struct({
	id: Schema.String,
	type: Schema.Literal("environment_deleted"),
})
export type EnvironmentDeleted = typeof EnvironmentDeleted.Type

export const CreateVaultBody = Schema.Struct({
	display_name: VaultDisplayName.annotate({ description: "Human-readable vault name" }),
})
export type CreateVaultBody = typeof CreateVaultBody.Type

export const UpdateVaultBody = Schema.Struct({
	display_name: Schema.optionalKey(
		Schema.NullOr(VaultDisplayName).annotate({ description: "Updated vault name" }),
	),
})
export type UpdateVaultBody = typeof UpdateVaultBody.Type

export const CreateCredentialBody = Schema.Struct({
	auth: Schema.Union([
		Schema.Struct({
			type: Schema.Literal("static_bearer"),
			token: CredentialSecret.annotate({
				description: "Bearer token sent to the MCP server. Never returned.",
			}),
			mcp_server_url: McpServerUrlInput.annotate({
				description: "URL of the MCP server this credential authenticates against",
			}),
		}),
	]).annotate({ description: "What the credential authenticates against, and its secret" }),
	display_name: Schema.optionalKey(
		Schema.NullOr(CredentialDisplayName).annotate({
			description: "Human-readable credential name",
		}),
	),
})
export type CreateCredentialBody = typeof CreateCredentialBody.Type

export const UpdateCredentialBody = Schema.Struct({
	auth: Schema.optionalKey(
		Schema.Union([
			Schema.Struct({
				type: Schema.Literal("static_bearer"),
				token: Schema.optionalKey(
					Schema.NullOr(CredentialSecret).annotate({
						description: "Replacement bearer token. Never returned.",
					}),
				),
			}),
		]).annotate({ description: "Replacement secret. The MCP server URL cannot change." }),
	),
	display_name: Schema.optionalKey(
		Schema.NullOr(CredentialDisplayName).annotate({
			description: "Updated credential name, or null to clear it",
		}),
	),
})
export type UpdateCredentialBody = typeof UpdateCredentialBody.Type

export const VaultResource = VaultSnapshot.annotate({ identifier: "Vault" })
export type Vault = typeof VaultResource.Type

export const CredentialResource = CredentialSnapshot.annotate({ identifier: "VaultCredential" })
export type VaultCredential = typeof CredentialResource.Type

export const VaultDeleted = Schema.Struct({
	id: Schema.String,
	type: Schema.Literal("vault_deleted"),
})
export type VaultDeleted = typeof VaultDeleted.Type

export const CredentialDeleted = Schema.Struct({
	id: Schema.String,
	type: Schema.Literal("vault_credential_deleted"),
})
export type CredentialDeleted = typeof CredentialDeleted.Type

export const ListCredentialsResponse = Schema.Struct({ data: Schema.Array(CredentialResource) })
export type ListCredentialsResponse = typeof ListCredentialsResponse.Type

export const SessionResource = Schema.Struct({
	...Struct.omit(SessionSnapshot.fields, ["agent_id", "agent_version"]),
	agent: Schema.Struct({ id: Schema.String, version: PositiveInt }),
	mcp_servers: Schema.Array(McpServerBinding).annotate({
		description: "The agent's MCP servers with the credential this session bound each to",
	}),
})
export type Session = typeof SessionResource.Type

export const AutomationResource = Schema.Struct({
	...Struct.omit(AutomationSnapshot.fields, [
		"agent_id",
		"agent_version",
		"text",
		"runs",
		"activation",
		"upcoming",
	]),
	agent: Schema.Struct({ id: Schema.String, version: Schema.NullOr(PositiveInt) }),
	initial_events: AutomationInitialEvents,
	run_count: Schema.Int,
	upcoming_runs_at: Schema.Array(Schema.DateTimeUtc),
})
export type Automation = typeof AutomationResource.Type

export const AutomationRunResource = Schema.Struct({
	type: Schema.Literal("automation_run"),
	automation_id: AutomationId,
	run: PositiveInt,
	status: Schema.Literals(["started", "failed"]),
	trigger: Schema.Union([
		Schema.Struct({ type: Schema.Literal("schedule"), scheduled_at: Schema.DateTimeUtc }),
		Schema.Struct({ type: Schema.Literal("manual") }),
	]),
	session_id: Schema.NullOr(Schema.String),
	error: Schema.NullOr(AutomationRunError),
	created_at: Schema.DateTimeUtc,
})
export type AutomationRun = typeof AutomationRunResource.Type

export const AutomationRunQueued = Schema.Struct({
	type: Schema.Literal("automation_run"),
	automation_id: AutomationId,
	run: PositiveInt,
	status: Schema.Literal("queued"),
	trigger: Schema.Struct({ type: Schema.Literal("manual") }),
}).pipe(HttpApiSchema.status(201))
export type AutomationRunQueued = typeof AutomationRunQueued.Type

export type PendingResourceType =
	| "agent"
	| "environment"
	| "session"
	| "automation"
	| "vault"
	| "vault_credential"

const pendingResource = <const T extends PendingResourceType>(type: T) =>
	Schema.Struct({
		id: Schema.String,
		type: Schema.Literal(type),
		pending: Schema.Literal(true),
	}).pipe(HttpApiSchema.status(202))

export const PendingAgent = pendingResource("agent")
export type PendingAgent = typeof PendingAgent.Type

export const PendingEnvironment = pendingResource("environment")
export type PendingEnvironment = typeof PendingEnvironment.Type

export const PendingSession = pendingResource("session")
export type PendingSession = typeof PendingSession.Type

export const PendingAutomation = pendingResource("automation")
export type PendingAutomation = typeof PendingAutomation.Type

export const PendingVault = pendingResource("vault")
export type PendingVault = typeof PendingVault.Type

export const PendingCredential = pendingResource("vault_credential")
export type PendingCredential = typeof PendingCredential.Type

export const PendingResource = Schema.Union([
	PendingAgent,
	PendingEnvironment,
	PendingSession,
	PendingAutomation,
	PendingVault,
	PendingCredential,
])

export type PendingResource = typeof PendingResource.Type

export const isPendingResource = <T extends { readonly type: string }>(
	value: T | PendingResource,
): value is Extract<T | PendingResource, { readonly pending: true }> =>
	"pending" in value && value.pending === true

export const UserMessageEventReceipt = Schema.Struct({
	type: Schema.Literal("user.message"),
	id: Schema.optionalKey(ClientEventId),
	turn: PositiveInt,
	queued: Schema.Boolean,
	content: TextBlocks,
})
export type UserMessageEventReceipt = typeof UserMessageEventReceipt.Type

export const UserInterruptEventReceipt = Schema.Struct({
	type: Schema.Literal("user.interrupt"),
	id: Schema.optionalKey(ClientEventId),
})
export type UserInterruptEventReceipt = typeof UserInterruptEventReceipt.Type

export const UserToolConfirmationEventReceipt = Schema.Struct({
	type: Schema.Literal("user.tool_confirmation"),
	id: Schema.optionalKey(ClientEventId),
	tool_use_id: ResourceId,
	result: ToolConfirmationResult,
})
export type UserToolConfirmationEventReceipt = typeof UserToolConfirmationEventReceipt.Type

export const UserCustomToolResultEventReceipt = Schema.Struct({
	type: Schema.Literal("user.custom_tool_result"),
	id: Schema.optionalKey(ClientEventId),
	custom_tool_use_id: ResourceId,
})
export type UserCustomToolResultEventReceipt = typeof UserCustomToolResultEventReceipt.Type

export const SendSessionEventReceipt = Schema.Union([
	UserMessageEventReceipt,
	UserInterruptEventReceipt,
	UserToolConfirmationEventReceipt,
	UserCustomToolResultEventReceipt,
]).annotate({ identifier: "SendSessionEventReceipt" })
export type SendSessionEventReceipt = typeof SendSessionEventReceipt.Type

export const SendSessionEventsResponse = Schema.Struct({
	data: Schema.Array(SendSessionEventReceipt),
})
export type SendSessionEventsResponse = typeof SendSessionEventsResponse.Type

const wireSessionEvent = <const T extends SessionEventType, const F extends Schema.Struct.Fields>(
	type: T,
	fields: F,
) =>
	Schema.Struct({
		id: Schema.String,
		seq: PositiveInt,
		type: Schema.Literal(type),
		created_at: Schema.DateTimeUtc,
		...fields,
	})

export const UserMessageSessionEvent = wireSessionEvent(
	"user.message",
	SessionEventFields["user.message"],
)
export const UserInterruptSessionEvent = wireSessionEvent(
	"user.interrupt",
	SessionEventFields["user.interrupt"],
)
export const UserToolConfirmationSessionEvent = wireSessionEvent(
	"user.tool_confirmation",
	SessionEventFields["user.tool_confirmation"],
)
export const UserCustomToolResultSessionEvent = wireSessionEvent(
	"user.custom_tool_result",
	SessionEventFields["user.custom_tool_result"],
)
export const SessionStatusRunningEvent = wireSessionEvent("session.status_running", {
	...SessionEventFields["session.status_running"],
	turn: Schema.optionalKey(PositiveInt),
})
export const SpanModelRequestStartEvent = wireSessionEvent(
	"span.model_request_start",
	SessionEventFields["span.model_request_start"],
)
export const AgentToolUseSessionEvent = wireSessionEvent(
	"agent.tool_use",
	SessionEventFields["agent.tool_use"],
)
export const AgentToolResultSessionEvent = wireSessionEvent(
	"agent.tool_result",
	SessionEventFields["agent.tool_result"],
)
export const AgentMcpToolUseSessionEvent = wireSessionEvent(
	"agent.mcp_tool_use",
	SessionEventFields["agent.mcp_tool_use"],
)
export const AgentMcpToolResultSessionEvent = wireSessionEvent(
	"agent.mcp_tool_result",
	SessionEventFields["agent.mcp_tool_result"],
)
export const AgentCustomToolUseSessionEvent = wireSessionEvent(
	"agent.custom_tool_use",
	SessionEventFields["agent.custom_tool_use"],
)
export const AgentThinkingSessionEvent = wireSessionEvent(
	"agent.thinking",
	SessionEventFields["agent.thinking"],
)
export const AgentMessageSessionEvent = wireSessionEvent(
	"agent.message",
	SessionEventFields["agent.message"],
)
export const SpanModelRequestEndEvent = wireSessionEvent(
	"span.model_request_end",
	SessionEventFields["span.model_request_end"],
)
export const SessionStatusIdleEvent = wireSessionEvent("session.status_idle", {
	...SessionEventFields["session.status_idle"],
	turn: Schema.optionalKey(PositiveInt),
})
export const SessionErrorSessionEvent = wireSessionEvent(
	"session.error",
	SessionEventFields["session.error"],
)
export const SessionStatusTerminatedEvent = wireSessionEvent(
	"session.status_terminated",
	SessionEventFields["session.status_terminated"],
)
export const SessionArchivedEvent = wireSessionEvent(
	"session.archived",
	SessionEventFields["session.archived"],
)

export const SessionEvent = Schema.Union([
	UserMessageSessionEvent,
	UserInterruptSessionEvent,
	UserToolConfirmationSessionEvent,
	UserCustomToolResultSessionEvent,
	SessionStatusRunningEvent,
	SpanModelRequestStartEvent,
	AgentToolUseSessionEvent,
	AgentToolResultSessionEvent,
	AgentMcpToolUseSessionEvent,
	AgentMcpToolResultSessionEvent,
	AgentCustomToolUseSessionEvent,
	AgentThinkingSessionEvent,
	AgentMessageSessionEvent,
	SpanModelRequestEndEvent,
	SessionStatusIdleEvent,
	SessionErrorSessionEvent,
	SessionStatusTerminatedEvent,
	SessionArchivedEvent,
]).annotate({ identifier: "SessionEvent" })

export type SessionEvent = typeof SessionEvent.Type

export const ListSessionEventsResponse = Schema.Struct({
	data: Schema.Array(SessionEvent),
	has_more: Schema.Boolean,
	next_cursor: Schema.NullOr(Schema.Finite),
})
export type ListSessionEventsResponse = typeof ListSessionEventsResponse.Type

export const ListAutomationRunsResponse = Schema.Struct({
	data: Schema.Array(AutomationRunResource),
	has_more: Schema.Boolean,
	next_cursor: Schema.NullOr(Schema.Finite),
})
export type ListAutomationRunsResponse = typeof ListAutomationRunsResponse.Type

export const ListAutomationsResponse = Schema.Struct({
	data: Schema.Array(AutomationResource),
	has_more: Schema.Boolean,
	next_cursor: Schema.NullOr(Schema.Finite),
})
export type ListAutomationsResponse = typeof ListAutomationsResponse.Type

export const CursorFromString = Schema.String.check(Schema.isPattern(/^\d{1,15}$/u)).pipe(
	Schema.decodeTo(
		Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 999_999_999_999_999 })),
		{
			decode: SchemaGetter.transform(Number),
			encode: SchemaGetter.transform(String),
		},
	),
)

const EventListAfterFromString = Schema.String.check(Schema.isPattern(/^\d{1,15}$/u))
	.annotate({
		description:
			"Exclusive sequence pagination cursor in the selected order (> after for asc, < after for desc)",
	})
	.pipe(
		Schema.decodeTo(
			Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 999_999_999_999_999 })),
			{
				decode: SchemaGetter.transform(Number),
				encode: SchemaGetter.transform(String),
			},
		),
	)

const EventListLimitFromString = Schema.String.check(Schema.isPattern(/^(?:[1-9]\d?|100)$/u))
	.annotate({ description: "Maximum number of events to return (1-100)" })
	.pipe(
		Schema.decodeTo(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })), {
			decode: SchemaGetter.transform(Number),
			encode: SchemaGetter.transform(String),
		}),
	)

const agentParams = { agent_id: AgentId.annotate({ description: "Agent ID" }) }
const environmentParams = {
	environment_id: EnvironmentId.annotate({ description: "Environment ID" }),
}
const sessionParams = { session_id: SessionId.annotate({ description: "Session ID" }) }
const automationParams = {
	automation_id: AutomationId.annotate({ description: "Automation ID" }),
}
const vaultParams = { vault_id: VaultId.annotate({ description: "Vault ID" }) }
const credentialParams = {
	...vaultParams,
	credential_id: CredentialId.annotate({ description: "Credential ID" }),
}

const IdempotencyHeaders = Schema.Struct({
	"idempotency-key": Schema.optionalKey(
		ClientEventId.annotate({
			description: "Optional Idempotency-Key header for safe retries",
		}),
	),
})

const RequiredIdempotencyHeaders = Schema.Struct({
	"idempotency-key": ClientEventId.annotate({
		description:
			"Idempotency-Key header. Required: resending the request with the same key returns the automation the first request created, so a lost response never leaves a second schedule running",
	}),
})

const Health = HttpApiGroup.make("health").add(
	HttpApiEndpoint.get("health", "/health", {
		success: Schema.Struct({ status: Schema.Literal("ok") }),
	})
		.annotate(OpenApi.Summary, "Health check")
		.annotate(OpenApi.Override, { "x-forge-skip": true }),
)

const Auth = HttpApiGroup.make("auth")
	.add(
		HttpApiEndpoint.get("verify", "/v1/auth/verify", {
			success: Schema.Struct({ type: Schema.Literal("authentication_verified") }),
		})
			.annotate(OpenApi.Summary, "Verify a credential")
			.annotate(
				OpenApi.Description,
				"Succeeds when the request's API key is accepted. Reads no stored data.",
			)
			.annotate(OpenApi.Override, { "x-forge-skip": true }),
	)
	.annotate(OpenApi.Description, "Check a credential")
	.middleware(Authentication)

const Agents = HttpApiGroup.make("agents")
	.add(
		HttpApiEndpoint.post("create", "/v1/agents", {
			headers: IdempotencyHeaders,
			payload: CreateAgentBody,
			success: [AgentResource.pipe(HttpApiSchema.status(201)), PendingAgent],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Create an agent")
			.annotate(OpenApi.Description, "Create an agent")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "agents",
				"x-forge-method-name": "create",
				"x-checkfu-endpoint": { group: "agents", endpoint: "create" },
				"x-checkfu-mcp": { name: "agents_createAgent", destructive: false },
				"x-checkfu-cli": {
					fileFields: ["system", "description"],
					textOrObjectFields: ["model"],
					examples: [
						{
							command: 'checkfu agents create --name "Assistant" --model gpt-6.2-sol',
							description: "Create an agent with flags",
						},
						{
							command: "checkfu agents create < agent.yaml",
							description: "Create an agent from YAML on stdin",
						},
					],
				},
			})
			.middleware(AgentBodyLimit),
	)
	.add(
		HttpApiEndpoint.get("get", "/v1/agents/:agent_id", {
			params: agentParams,
			success: AgentResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve an agent")
			.annotate(OpenApi.Description, "Retrieve an agent by ID")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "agents",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "agents", endpoint: "get" },
				"x-checkfu-mcp": { name: "agents_getAgent" },
			}),
	)
	.add(
		HttpApiEndpoint.post("update", "/v1/agents/:agent_id", {
			params: agentParams,
			payload: UpdateAgentBody,
			success: [AgentResource, PendingAgent],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Update an agent")
			.annotate(OpenApi.Description, "Update an agent (creates a new agent version)")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "agents",
				"x-forge-method-name": "update",
				"x-checkfu-endpoint": { group: "agents", endpoint: "update" },
				"x-checkfu-mcp": { name: "agents_updateAgent" },
				"x-checkfu-cli": {
					fileFields: ["system", "description"],
					textOrObjectFields: ["model"],
				},
			})
			.middleware(AgentBodyLimit),
	)
	.add(
		HttpApiEndpoint.post("archive", "/v1/agents/:agent_id/archive", {
			params: agentParams,
			success: [AgentResource, PendingAgent],
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Archive an agent")
			.annotate(OpenApi.Description, "Archive an agent")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "agents",
				"x-forge-method-name": "archive",
				"x-checkfu-endpoint": { group: "agents", endpoint: "archive" },
				"x-checkfu-mcp": { name: "agents_archiveAgent" },
				"x-checkfu-idempotent": true,
			}),
	)
	.annotate(OpenApi.Description, "Manage agents")
	.middleware(Authentication)

const Environments = HttpApiGroup.make("environments")
	.add(
		HttpApiEndpoint.post("create", "/v1/environments", {
			headers: IdempotencyHeaders,
			payload: CreateEnvironmentBody,
			success: [EnvironmentSnapshot.pipe(HttpApiSchema.status(201)), PendingEnvironment],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Create an environment")
			.annotate(OpenApi.Description, "Create an environment")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "environments",
				"x-forge-method-name": "create",
				"x-checkfu-endpoint": { group: "environments", endpoint: "create" },
				"x-checkfu-mcp": { name: "environments_createEnvironment", destructive: false },
				"x-checkfu-cli": {
					fileFields: ["description"],
					examples: [
						{
							command:
								'checkfu environments create --name "default" --config \'{"type":"cloud","networking":{"type":"unrestricted"}}\'',
							description: "Create a cloud environment",
						},
					],
				},
			}),
	)
	.add(
		HttpApiEndpoint.get("get", "/v1/environments/:environment_id", {
			params: environmentParams,
			success: EnvironmentSnapshot,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve an environment")
			.annotate(OpenApi.Description, "Retrieve an environment by ID")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "environments",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "environments", endpoint: "get" },
				"x-checkfu-mcp": { name: "environments_getEnvironment" },
			}),
	)
	.add(
		HttpApiEndpoint.post("update", "/v1/environments/:environment_id", {
			params: environmentParams,
			payload: UpdateEnvironmentBody,
			success: [EnvironmentSnapshot, PendingEnvironment],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Update an environment")
			.annotate(OpenApi.Description, "Update an environment")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "environments",
				"x-forge-method-name": "update",
				"x-checkfu-endpoint": { group: "environments", endpoint: "update" },
				"x-checkfu-mcp": { name: "environments_updateEnvironment" },
				"x-checkfu-cli": {
					fileFields: ["description"],
				},
			}),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/v1/environments/:environment_id", {
			params: environmentParams,
			success: EnvironmentDeleted,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Delete an environment")
			.annotate(OpenApi.Description, "Delete an environment")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "environments",
				"x-forge-method-name": "delete",
				"x-checkfu-endpoint": { group: "environments", endpoint: "delete" },
				"x-checkfu-mcp": { name: "environments_deleteEnvironment" },
			}),
	)
	.add(
		HttpApiEndpoint.post("archive", "/v1/environments/:environment_id/archive", {
			params: environmentParams,
			success: [EnvironmentSnapshot, PendingEnvironment],
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Archive an environment")
			.annotate(OpenApi.Description, "Archive an environment")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "environments",
				"x-forge-method-name": "archive",
				"x-checkfu-endpoint": { group: "environments", endpoint: "archive" },
				"x-checkfu-mcp": { name: "environments_archiveEnvironment" },
				"x-checkfu-idempotent": true,
			}),
	)
	.annotate(OpenApi.Description, "Manage environments")
	.middleware(Authentication)

const Sessions = HttpApiGroup.make("sessions")
	.add(
		HttpApiEndpoint.post("create", "/v1/sessions", {
			headers: IdempotencyHeaders,
			payload: CreateSessionBody,
			success: [SessionResource.pipe(HttpApiSchema.status(201)), PendingSession],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Create a session")
			.annotate(OpenApi.Description, "Create a session")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "sessions",
				"x-forge-method-name": "create",
				"x-checkfu-endpoint": { group: "sessions", endpoint: "create" },
				"x-checkfu-mcp": { name: "sessions_createSession", destructive: false },
				"x-checkfu-cli": {
					textOrObjectFields: ["agent"],
					examples: [
						{
							command: "checkfu sessions create --agent agent_123 --environment-id env_456",
							description: "Create a session with flags",
						},
					],
				},
			}),
	)
	.add(
		HttpApiEndpoint.get("get", "/v1/sessions/:session_id", {
			params: sessionParams,
			success: SessionResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve a session")
			.annotate(OpenApi.Description, "Retrieve a session by ID")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "sessions",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "sessions", endpoint: "get" },
				"x-checkfu-mcp": { name: "sessions_getSession" },
			}),
	)
	.add(
		HttpApiEndpoint.post("archive", "/v1/sessions/:session_id/archive", {
			params: sessionParams,
			success: [SessionResource, PendingSession],
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Archive a session")
			.annotate(OpenApi.Description, "Archive a session")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "sessions",
				"x-forge-method-name": "archive",
				"x-checkfu-endpoint": { group: "sessions", endpoint: "archive" },
				"x-checkfu-mcp": { name: "sessions_archiveSession" },
				"x-checkfu-idempotent": true,
			}),
	)
	.add(
		HttpApiEndpoint.post("sendEvents", "/v1/sessions/:session_id/events", {
			params: sessionParams,
			headers: IdempotencyHeaders,
			payload: SendSessionEventsBody,
			success: SendSessionEventsResponse,
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Send session events")
			.annotate(OpenApi.Description, "Send user events to a session")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "sessions.events",
				"x-forge-method-name": "send",
				"x-checkfu-endpoint": { group: "sessions", endpoint: "sendEvents" },
				"x-checkfu-mcp": { name: "sessions_sendSessionEvents" },
				"x-checkfu-cli": {
					groupDescription: "Send, list, and stream session events",
					repeatArrayField: {
						field: "events",
						flag: "event",
						description: "Event payload as JSON, YAML, or @file (repeatable, up to 8)",
					},
					examples: [
						{
							command:
								'checkfu sessions:events send --session-id sess_123 --event \'{"type":"user.message","content":[{"type":"text","text":"Hello!"}]}\'',
							description: "Send a user message event",
						},
						{
							command:
								'checkfu sessions:events send --session-id sess_123 --event \'{"type":"user.interrupt"}\'',
							description: "Interrupt an active session turn",
						},
						{
							command:
								'checkfu sessions:events send --session-id sess_123 --event \'{"type":"user.tool_confirmation","tool_use_id":"call_1","result":"allow"}\'',
							description: "Allow a tool call the session is waiting on",
						},
						{
							command:
								'checkfu sessions:events send --session-id sess_123 --event \'{"type":"user.custom_tool_result","custom_tool_use_id":"call_1","content":[{"type":"text","text":"42"}]}\'',
							description: "Answer a custom tool call the session is waiting on",
						},
					],
				},
			})
			.middleware(EventBatchBodyLimit),
	)
	.add(
		HttpApiEndpoint.get("listEvents", "/v1/sessions/:session_id/events", {
			params: sessionParams,
			query: {
				after: Schema.optionalKey(EventListAfterFromString),
				limit: Schema.optionalKey(EventListLimitFromString),
				order: Schema.optionalKey(
					Schema.Literals(["asc", "desc"]).annotate({ description: "Sort order: asc or desc" }),
				),
			},
			success: ListSessionEventsResponse,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List session events")
			.annotate(OpenApi.Description, "List historical events for a session")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "sessions.events",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "sessions", endpoint: "listEvents" },
				"x-checkfu-mcp": { name: "sessions_listEvents" },
				"x-checkfu-cli": {
					intQueryParams: {
						after: { min: 0, metavar: "SEQ" },
						limit: { min: 1, max: 100, metavar: "N" },
					},
				},
			}),
	)
	.add(
		HttpApiEndpoint.get("streamEvents", "/v1/sessions/:session_id/events/stream", {
			params: sessionParams,
			// Keep `after` as a raw string here so `streamEvents` can give a non-empty
			// `Last-Event-ID` header precedence before decoding the selected cursor.
			query: {
				after: Schema.optionalKey(
					Schema.String.annotate({
						description: "Resume stream strictly after this sequence number",
					}),
				),
			},
			success: [HttpApiSchema.StreamSse({ data: SessionEvent }), HttpApiSchema.NoContent],
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Stream session events")
			.annotate(OpenApi.Description, "Stream live session events over Server-Sent Events")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "sessions.events",
				"x-forge-method-name": "stream",
				"x-checkfu-endpoint": { group: "sessions", endpoint: "streamEvents" },
				"x-checkfu-mcp": false,
				"x-checkfu-cli": {
					intQueryParams: {
						after: { min: 0, metavar: "SEQ" },
					},
					examples: [
						{
							command: "checkfu sessions:events stream --session-id sess_123",
							description: "Stream all events as JSONL",
						},
						{
							command:
								"checkfu sessions:events stream --session-id sess_123 --after 5 --transform content.0.text -r",
							description: "Resume after sequence 5 and extract message text",
						},
					],
				},
			}),
	)
	.annotate(OpenApi.Description, "Manage sessions")
	.middleware(Authentication)

const Automations = HttpApiGroup.make("automations")
	.add(
		HttpApiEndpoint.post("create", "/v1/automations", {
			headers: RequiredIdempotencyHeaders,
			payload: CreateAutomationBody,
			success: [AutomationResource.pipe(HttpApiSchema.status(201)), PendingAutomation],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Create an automation")
			.annotate(
				OpenApi.Description,
				"Create an automation that opens a new session with its message every time its schedule fires",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "automations",
				"x-forge-method-name": "create",
				"x-checkfu-endpoint": { group: "automations", endpoint: "create" },
				"x-checkfu-mcp": { name: "automations_createAutomation", destructive: false },
				"x-checkfu-cli": {
					textOrObjectFields: ["agent"],
					repeatArrayField: {
						field: "initial_events",
						flag: "initial-event",
						description: "The user message each run starts with, as JSON, YAML, or @file",
					},
					examples: [
						{
							command:
								'checkfu automations create --name "Morning report" --agent agent_123 --environment-id env_456 --initial-event \'{"type":"user.message","content":[{"type":"text","text":"Write the morning report."}]}\' --schedule \'{"type":"cron","expression":"0 9 * * 1-5","timezone":"America/New_York"}\'',
							description: "Run an agent at 09:00 New York time on weekdays",
						},
					],
				},
			}),
	)
	.add(
		HttpApiEndpoint.get("list", "/v1/automations", {
			query: {
				after: Schema.optionalKey(EventListAfterFromString),
				limit: Schema.optionalKey(EventListLimitFromString),
				order: Schema.optionalKey(
					Schema.Literals(["asc", "desc"]).annotate({ description: "Sort order: asc or desc" }),
				),
			},
			success: ListAutomationsResponse,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List automations")
			.annotate(
				OpenApi.Description,
				"List the automations that are not archived, oldest first by default. The list catches up shortly after a create or archive, so an automation missing from it does not mean its create failed: to find out, resend the create with its original idempotency key, which returns the automation it created.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "automations",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "automations", endpoint: "list" },
				"x-checkfu-mcp": { name: "automations_listAutomations" },
				"x-checkfu-cli": {
					intQueryParams: {
						after: { min: 0, metavar: "SEQ" },
						limit: { min: 1, max: 100, metavar: "N" },
					},
				},
			}),
	)
	.add(
		HttpApiEndpoint.get("get", "/v1/automations/:automation_id", {
			params: automationParams,
			success: AutomationResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve an automation")
			.annotate(OpenApi.Description, "Retrieve an automation by ID")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "automations",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "automations", endpoint: "get" },
				"x-checkfu-mcp": { name: "automations_getAutomation" },
			}),
	)
	.add(
		HttpApiEndpoint.post("pause", "/v1/automations/:automation_id/pause", {
			params: automationParams,
			success: [AutomationResource, PendingAutomation],
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Pause an automation")
			.annotate(
				OpenApi.Description,
				"Stop an automation's schedule until it is unpaused; it can still be run on request",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "automations",
				"x-forge-method-name": "pause",
				"x-checkfu-endpoint": { group: "automations", endpoint: "pause" },
				"x-checkfu-mcp": { name: "automations_pauseAutomation" },
			}),
	)
	.add(
		HttpApiEndpoint.post("unpause", "/v1/automations/:automation_id/unpause", {
			params: automationParams,
			success: [AutomationResource, PendingAutomation],
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Unpause an automation")
			.annotate(
				OpenApi.Description,
				"Resume an automation's schedule from now, without running the occurrences it missed",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "automations",
				"x-forge-method-name": "unpause",
				"x-checkfu-endpoint": { group: "automations", endpoint: "unpause" },
				"x-checkfu-mcp": { name: "automations_unpauseAutomation" },
			}),
	)
	.add(
		HttpApiEndpoint.post("archive", "/v1/automations/:automation_id/archive", {
			params: automationParams,
			success: [AutomationResource, PendingAutomation],
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Archive an automation")
			.annotate(OpenApi.Description, "Archive an automation so it never runs again")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "automations",
				"x-forge-method-name": "archive",
				"x-checkfu-endpoint": { group: "automations", endpoint: "archive" },
				"x-checkfu-mcp": { name: "automations_archiveAutomation" },
				"x-checkfu-idempotent": true,
			}),
	)
	.add(
		HttpApiEndpoint.post("run", "/v1/automations/:automation_id/run", {
			params: automationParams,
			success: AutomationRunQueued,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Run an automation now")
			.annotate(
				OpenApi.Description,
				"Queue a run now, whether or not the automation is paused, without moving its schedule. The response carries the run's number; the run appears in the run list once its session starts or fails to",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "automations",
				"x-forge-method-name": "run",
				"x-checkfu-endpoint": { group: "automations", endpoint: "run" },
				"x-checkfu-mcp": { name: "automations_runAutomation" },
			}),
	)
	.add(
		HttpApiEndpoint.get("listRuns", "/v1/automations/:automation_id/runs", {
			params: automationParams,
			query: {
				after: Schema.optionalKey(EventListAfterFromString),
				limit: Schema.optionalKey(EventListLimitFromString),
				order: Schema.optionalKey(
					Schema.Literals(["asc", "desc"]).annotate({ description: "Sort order: asc or desc" }),
				),
			},
			success: ListAutomationRunsResponse,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List automation runs")
			.annotate(
				OpenApi.Description,
				"List the runs of an automation that have started or failed, oldest first by default",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "automations.runs",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "automations", endpoint: "listRuns" },
				"x-checkfu-mcp": { name: "automations_listRuns" },
				"x-checkfu-cli": {
					intQueryParams: {
						after: { min: 0, metavar: "SEQ" },
						limit: { min: 1, max: 100, metavar: "N" },
					},
				},
			}),
	)
	.annotate(OpenApi.Description, "Manage automations")
	.middleware(Authentication)

const Vaults = HttpApiGroup.make("vaults")
	.add(
		HttpApiEndpoint.post("create", "/v1/vaults", {
			payload: CreateVaultBody,
			success: [VaultResource.pipe(HttpApiSchema.status(201)), PendingVault],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Create a vault")
			.annotate(OpenApi.Description, "Create a vault to hold credentials for agents to use")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "vaults",
				"x-forge-method-name": "create",
				"x-checkfu-endpoint": { group: "vaults", endpoint: "create" },
				"x-checkfu-mcp": { name: "vaults_createVault", destructive: false },
			}),
	)
	.add(
		HttpApiEndpoint.get("get", "/v1/vaults/:vault_id", {
			params: vaultParams,
			success: VaultResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve a vault")
			.annotate(OpenApi.Description, "Retrieve a vault by ID")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "vaults",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "vaults", endpoint: "get" },
				"x-checkfu-mcp": { name: "vaults_getVault" },
			}),
	)
	.add(
		HttpApiEndpoint.post("update", "/v1/vaults/:vault_id", {
			params: vaultParams,
			payload: UpdateVaultBody,
			success: [VaultResource, PendingVault],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Update a vault")
			.annotate(OpenApi.Description, "Rename a vault")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "vaults",
				"x-forge-method-name": "update",
				"x-checkfu-endpoint": { group: "vaults", endpoint: "update" },
				"x-checkfu-mcp": { name: "vaults_updateVault" },
			}),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/v1/vaults/:vault_id", {
			params: vaultParams,
			success: VaultDeleted,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Delete a vault")
			.annotate(OpenApi.Description, "Delete a vault, its credentials and their secrets")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "vaults",
				"x-forge-method-name": "delete",
				"x-checkfu-endpoint": { group: "vaults", endpoint: "delete" },
				"x-checkfu-mcp": { name: "vaults_deleteVault" },
			}),
	)
	.add(
		HttpApiEndpoint.post("archive", "/v1/vaults/:vault_id/archive", {
			params: vaultParams,
			success: [VaultResource, PendingVault],
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Archive a vault")
			.annotate(OpenApi.Description, "Archive a vault and its credentials, and erase their secrets")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "vaults",
				"x-forge-method-name": "archive",
				"x-checkfu-endpoint": { group: "vaults", endpoint: "archive" },
				"x-checkfu-mcp": { name: "vaults_archiveVault" },
				"x-checkfu-idempotent": true,
			}),
	)
	.add(
		HttpApiEndpoint.post("createCredential", "/v1/vaults/:vault_id/credentials", {
			params: vaultParams,
			payload: CreateCredentialBody,
			success: [CredentialResource.pipe(HttpApiSchema.status(201)), PendingCredential],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Create a credential")
			.annotate(OpenApi.Description, "Store a credential in a vault. Its secret is never returned.")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "vaults.credentials",
				"x-forge-method-name": "create",
				"x-checkfu-endpoint": { group: "vaults", endpoint: "createCredential" },
				"x-checkfu-mcp": false,
			}),
	)
	.add(
		HttpApiEndpoint.get("listCredentials", "/v1/vaults/:vault_id/credentials", {
			params: vaultParams,
			success: ListCredentialsResponse,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List credentials")
			.annotate(OpenApi.Description, "List a vault's active credentials")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "vaults.credentials",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "vaults", endpoint: "listCredentials" },
				"x-checkfu-mcp": { name: "vaults_listCredentials" },
			}),
	)
	.add(
		HttpApiEndpoint.get("getCredential", "/v1/vaults/:vault_id/credentials/:credential_id", {
			params: credentialParams,
			success: CredentialResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve a credential")
			.annotate(OpenApi.Description, "Retrieve a credential by ID. Its secret is never returned.")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "vaults.credentials",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "vaults", endpoint: "getCredential" },
				"x-checkfu-mcp": { name: "vaults_getCredential" },
			}),
	)
	.add(
		HttpApiEndpoint.post("updateCredential", "/v1/vaults/:vault_id/credentials/:credential_id", {
			params: credentialParams,
			payload: UpdateCredentialBody,
			success: [CredentialResource, PendingCredential],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Update a credential")
			.annotate(OpenApi.Description, "Rename a credential or replace its secret")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "vaults.credentials",
				"x-forge-method-name": "update",
				"x-checkfu-endpoint": { group: "vaults", endpoint: "updateCredential" },
				"x-checkfu-mcp": false,
			}),
	)
	.add(
		HttpApiEndpoint.delete("deleteCredential", "/v1/vaults/:vault_id/credentials/:credential_id", {
			params: credentialParams,
			success: CredentialDeleted,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Delete a credential")
			.annotate(OpenApi.Description, "Delete a credential and erase its secret")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "vaults.credentials",
				"x-forge-method-name": "delete",
				"x-checkfu-endpoint": { group: "vaults", endpoint: "deleteCredential" },
				"x-checkfu-mcp": { name: "vaults_deleteCredential" },
			}),
	)
	.add(
		HttpApiEndpoint.post(
			"archiveCredential",
			"/v1/vaults/:vault_id/credentials/:credential_id/archive",
			{
				params: credentialParams,
				success: [CredentialResource, PendingCredential],
				error: HandlerErrors,
			},
		)
			.annotate(OpenApi.Summary, "Archive a credential")
			.annotate(OpenApi.Description, "Archive a credential and erase its secret")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "vaults.credentials",
				"x-forge-method-name": "archive",
				"x-checkfu-endpoint": { group: "vaults", endpoint: "archiveCredential" },
				"x-checkfu-mcp": { name: "vaults_archiveCredential" },
				"x-checkfu-idempotent": true,
			}),
	)
	.annotate(OpenApi.Description, "Manage vaults and the credentials they hold")
	.middleware(Authentication)

export const CheckfuApi = HttpApi.make("checkfu")
	.add(Health)
	.add(Auth)
	.add(Agents)
	.add(Environments)
	.add(Sessions)
	.add(Automations)
	.add(Vaults)
	.annotate(OpenApi.Title, "Checkfu API")
	.annotate(OpenApi.Version, "0.0.1")
	.annotate(
		OpenApi.Description,
		"Managed agents API for managing agents, environments, sessions, automations, and vaults.",
	)
	// The published schemas forbid unknown body fields, so a misspelled field is refused rather
	// than dropped.
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	.middleware(RequestValidation)

export type CheckfuHttpApiClient<E = never, R = never> = HttpApiClient.ForApi<
	typeof CheckfuApi,
	E,
	R
>

export const makeCheckfuHttpApiClient = (options?: {
	readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
	readonly transformResponse?:
		| ((
				effect: Effect.Effect<unknown, unknown, unknown>,
		  ) => Effect.Effect<unknown, unknown, unknown>)
		| undefined
	readonly baseUrl?: URL | string | undefined
}): Effect.Effect<CheckfuHttpApiClient, never, HttpClient.HttpClient> =>
	HttpApiClient.make(CheckfuApi, options)

export const makeCheckfuHttpApiClientWith = <E, R>(options: {
	readonly httpClient: HttpClient.HttpClient.With<E, R>
	readonly transformResponse?:
		| ((
				effect: Effect.Effect<unknown, unknown, unknown>,
		  ) => Effect.Effect<unknown, unknown, unknown>)
		| undefined
	readonly baseUrl?: URL | string | undefined
}): Effect.Effect<CheckfuHttpApiClient<Exclude<E, HttpClientError.HttpClientError>, R>> =>
	HttpApiClient.makeWith(CheckfuApi, options)
