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
import { CLIENT_EVENT_ID_MAX_LENGTH } from "./IdempotencyKey.ts"
import * as SchemaGetter from "effect/SchemaGetter"
import * as Struct from "effect/Struct"
import {
	AgentDescription,
	AgentId,
	AgentModel,
	AgentName,
	AgentSnapshot,
	AgentSystem,
	ArtifactFile,
	ArtifactFilesInput,
	ArtifactVersionFilesInput,
	ArtifactId,
	ArtifactName,
	ArtifactPath,
	AutomationId,
	AutomationDescription,
	AutomationName,
	AutomationRunError,
	AutomationSchedule,
	CronExpression,
	AutomationSnapshot,
	CredentialCustody,
	CredentialDisplayName,
	CredentialId,
	CredentialSecret,
	CredentialSnapshot,
	EnvironmentConfig,
	EnvironmentDescription,
	EnvironmentId,
	EnvironmentName,
	EnvironmentSnapshot,
	MAX_ARTIFACT_BODY_BYTES,
	MAX_INLINE_FILE_BYTES,
	MAX_INLINE_TOTAL_BYTES,
	NonNegativeInt,
	MAX_ARTIFACT_TOTAL_BYTES,
	MAX_ARTIFACT_FILE_BYTES,
	MAX_ARTIFACT_FILES,
	MAX_LINK_TTL_SECONDS,
	MIN_LINK_TTL_SECONDS,
	MAX_MCP_SERVER_URL_LENGTH,
	McpServerUrl,
	NonEmptyString,
	PositiveInt,
	PublicationAddress,
	ResourceId,
	Timezone,
	ResourceListCursor,
	SessionEventFields,
	SessionId,
	SessionSnapshot,
	SessionTitle,
	Sha256Hex,
	TextBlocks,
	VaultCustody,
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

export class ArtifactBodyLimit extends HttpApiMiddleware.Service<ArtifactBodyLimit>()(
	"@checkfu/api/ArtifactBodyLimit",
	{ error: ERRORS[413] },
) {}

export class ArtifactBlobLimit extends HttpApiMiddleware.Service<ArtifactBlobLimit>()(
	"@checkfu/api/ArtifactBlobLimit",
	{ error: ERRORS[413] },
) {}

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

const ArtifactFilesField = ArtifactFilesInput.annotate({
	description: "Every file of the version; a new version replaces the whole set",
})

export const CreateArtifactBody = Schema.Struct({
	name: ArtifactName.annotate({ description: "Human-readable artifact name" }),
	files: Schema.optionalKey(
		ArtifactFilesField.annotate({
			description:
				"Every file of version 1. Leave it out to create an empty artifact at version 0, upload large files with PUT /v1/artifacts/{artifact_id}/blobs/{sha256}, then add version 1",
		}),
	),
})
export type CreateArtifactBody = typeof CreateArtifactBody.Type

export const CreateArtifactVersionBody = Schema.Struct({
	version: NonNegativeInt.annotate({
		description: "Current artifact version for optimistic concurrency (0 for an empty artifact)",
	}),
	files: ArtifactVersionFilesInput.annotate({
		description:
			"Every file of the version; a new version replaces the whole set. Send a small file's content inline, or name bytes the artifact already holds by their sha256",
	}),
})
export type CreateArtifactVersionBody = typeof CreateArtifactVersionBody.Type

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
	description: Schema.optionalKey(
		Schema.NullOr(AutomationDescription).annotate({
			description: "What the automation is for, up to 2048 characters",
		}),
	),
	agent: AgentReference.annotate({
		description:
			"Pass an agent ID to pin its latest version, or an agent reference with an explicit version to pin that version.",
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

export const UpdateAutomationBody = Schema.Struct({
	name: Schema.optionalKey(AutomationName.annotate({ description: "New automation name" })),
	description: Schema.optionalKey(
		Schema.NullOr(AutomationDescription).annotate({
			description:
				"New description. To clear it, send null for description in a JSON or YAML body on stdin; the --description flag always sends text.",
		}),
	),
	agent: Schema.optionalKey(
		AgentReference.annotate({
			description:
				"Pass an agent ID to pin its latest version, or an agent reference with an explicit version to pin that version.",
		}),
	),
	environment_id: Schema.optionalKey(
		ResourceId.annotate({ description: "Environment ID later runs' sessions use" }),
	),
	initial_events: Schema.optionalKey(
		AutomationInitialEvents.annotate({
			description: "The one user message later runs' sessions start with",
		}),
	),
	schedule: Schema.optionalKey(
		Schema.Struct({
			type: Schema.optionalKey(Schema.Literal("cron")),
			expression: Schema.optionalKey(CronExpression),
			timezone: Schema.optionalKey(Timezone),
		}).annotate({
			description:
				"New schedule, with the same rules as on create. A field left out keeps its value, so the expression and the timezone can change separately. On an active automation the next firing moves to it.",
		}),
	),
})
export type UpdateAutomationBody = typeof UpdateAutomationBody.Type

export const ClientEventId = Schema.String.check(
	Schema.isTrimmed(),
	Schema.isMinLength(1),
	Schema.isMaxLength(CLIENT_EVENT_ID_MAX_LENGTH),
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
		]),
	).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
})
export type SendSessionEventsBody = typeof SendSessionEventsBody.Type

export const AgentResource = Schema.Struct(
	Struct.omit(AgentSnapshot.fields, ["current_version_id"]),
)
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

const MCP_SERVER_URL =
	/^(?:https:\/\/[^\s/?#@]+|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?)(?:[/?#]\S*)?$/u

export const canonicalMcpServerUrl = (input: string): string => {
	const url = new URL(input)
	url.hash = ""
	return url.href
}

const McpServerUrlInput = Schema.String.check(
	Schema.isMaxLength(MAX_MCP_SERVER_URL_LENGTH),
	Schema.isPattern(MCP_SERVER_URL, { expected: "an https:// URL of an MCP server" }),
	Schema.makeFilter((input) => URL.canParse(input) || "a URL that can be parsed"),
).pipe(
	Schema.decodeTo(McpServerUrl, {
		decode: SchemaGetter.transform(canonicalMcpServerUrl),
		encode: SchemaGetter.passthrough(),
	}),
)

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
	custody: VaultCustody,
})
export type VaultDeleted = typeof VaultDeleted.Type

export const CredentialDeleted = Schema.Struct({
	id: Schema.String,
	type: Schema.Literal("vault_credential_deleted"),
	custody: CredentialCustody,
})
export type CredentialDeleted = typeof CredentialDeleted.Type

export const SessionResource = Schema.Struct({
	...Struct.omit(SessionSnapshot.fields, ["agent_id", "agent_version"]),
	agent: Schema.Struct({ id: Schema.String, version: PositiveInt }),
})
export type Session = typeof SessionResource.Type

export const AutomationResource = Schema.Struct({
	...Struct.omit(AutomationSnapshot.fields, [
		"agent_id",
		"agent_version",
		"text",
		"runs",
		"activation",
		"revision",
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
	agent: Schema.NullOr(
		Schema.Struct({ id: Schema.String, version: Schema.NullOr(PositiveInt) }),
	).annotate({
		description:
			"The agent the run used, with the version its session opened on, or for a failed run the version the automation pinned (null for automations created without a pinned version). Null for runs recorded before runs named their agent.",
	}),
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

const ArtifactCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const ArtifactPublication = Schema.Struct({
	address: PublicationAddress,
	url: Schema.String,
	version: Schema.NullOr(PositiveInt).annotate({
		description: "The version served, or null when the latest version is served",
	}),
	published_at: Schema.DateTimeUtc,
})
export type ArtifactPublication = typeof ArtifactPublication.Type

export const ArtifactResource = Schema.Struct({
	id: ArtifactId,
	type: Schema.Literal("artifact"),
	name: Schema.String,
	version: NonNegativeInt.annotate({
		description: "Current version; 0 while an artifact has no versions yet",
	}),
	file_count: ArtifactCount,
	total_bytes: ArtifactCount,
	files: Schema.Array(ArtifactFile),
	publication: Schema.NullOr(ArtifactPublication).annotate({
		description: "The artifact's public address, or null when it is not published",
	}),
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
})
export type Artifact = typeof ArtifactResource.Type

export const ArtifactSummaryResource = ArtifactResource.mapFields(
	({ files: _files, ...fields }) => fields,
)
export type ArtifactSummary = typeof ArtifactSummaryResource.Type

export const PublishArtifactBody = Schema.Struct({
	version: Schema.optionalKey(
		Schema.Union([PositiveInt, Schema.Literal("latest")]).annotate({
			description:
				'Version to serve, or "latest" (the default) to serve each new version as it is added',
		}),
	),
})
export type PublishArtifactBody = typeof PublishArtifactBody.Type

export const ArtifactVersionResource = Schema.Struct({
	type: Schema.Literal("artifact_version"),
	artifact_id: Schema.String,
	version: PositiveInt,
	file_count: ArtifactCount,
	total_bytes: ArtifactCount,
	files: Schema.Array(ArtifactFile),
	created_at: Schema.DateTimeUtc,
})
export type ArtifactVersion = typeof ArtifactVersionResource.Type

export const ArtifactFileResource = Schema.Struct({
	type: Schema.Literal("artifact_file"),
	path: ArtifactPath,
	sha256: Sha256Hex,
	size: ArtifactCount,
	content_type: Schema.String,
	encoding: Schema.Literals(["utf8", "base64"]),
	content: Schema.String,
})
export type ArtifactFileContent = typeof ArtifactFileResource.Type

export const CreateArtifactLinkBody = Schema.Struct({
	expires_in: Schema.optionalKey(
		Schema.Int.check(
			Schema.isBetween({ minimum: MIN_LINK_TTL_SECONDS, maximum: MAX_LINK_TTL_SECONDS }),
		).annotate({
			description: "Seconds until the link stops working (default 3600, at most 7 days)",
		}),
	),
})
export type CreateArtifactLinkBody = typeof CreateArtifactLinkBody.Type

export const ArtifactLinkResource = Schema.Struct({
	type: Schema.Literal("artifact_link"),
	artifact_id: Schema.String,
	version: PositiveInt,
	url: Schema.String,
	expires_at: Schema.DateTimeUtc,
})
export type ArtifactLink = typeof ArtifactLinkResource.Type

export const ArtifactDeleted = Schema.Struct({
	id: Schema.String,
	type: Schema.Literal("artifact_deleted"),
})
export type ArtifactDeleted = typeof ArtifactDeleted.Type

export const ArtifactVersionFromString = Schema.String.check(Schema.isPattern(/^[1-9]\d{0,8}$/u))
	.annotate({ description: "Artifact version number" })
	.pipe(
		Schema.decodeTo(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999 })), {
			decode: SchemaGetter.transform(Number),
			encode: SchemaGetter.transform(String),
		}),
	)

export type PendingResourceType =
	| "agent"
	| "environment"
	| "session"
	| "automation"
	| "artifact"
	| "artifact_version"
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
export const PendingArtifact = pendingResource("artifact")
export type PendingArtifact = typeof PendingArtifact.Type

export const PendingArtifactVersion = Schema.Struct({
	id: Schema.String,
	type: Schema.Literal("artifact_version"),
	version: PositiveInt,
	pending: Schema.Literal(true),
}).pipe(HttpApiSchema.status(202))
export type PendingArtifactVersion = typeof PendingArtifactVersion.Type

export const PendingVault = pendingResource("vault")
export type PendingVault = typeof PendingVault.Type

export const PendingCredential = Schema.Struct({
	id: Schema.String,
	type: Schema.Literal("vault_credential"),
	vault_id: VaultId,
	pending: Schema.Literal(true),
}).pipe(HttpApiSchema.status(202))
export type PendingCredential = typeof PendingCredential.Type

export const PendingResource = Schema.Union([
	PendingAgent,
	PendingEnvironment,
	PendingSession,
	PendingAutomation,
	PendingArtifact,
	PendingArtifactVersion,
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

export const SendSessionEventReceipt = Schema.Union([
	UserMessageEventReceipt,
	UserInterruptEventReceipt,
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
export const SessionStatusRunningEvent = wireSessionEvent("session.status_running", {
	...SessionEventFields["session.status_running"],
	turn: Schema.optionalKey(PositiveInt),
})
export const SpanModelRequestStartEvent = wireSessionEvent(
	"span.model_request_start",
	SessionEventFields["span.model_request_start"],
)
const TOOL_CALL_RECORD =
	"A turn's calls come before its end event, whether the turn replied, failed or was interrupted."
export const AgentToolUseSessionEvent = wireSessionEvent(
	"agent.tool_use",
	SessionEventFields["agent.tool_use"],
).annotate({ description: `Records a call the model made. ${TOOL_CALL_RECORD}` })
export const AgentToolResultSessionEvent = wireSessionEvent(
	"agent.tool_result",
	SessionEventFields["agent.tool_result"],
).annotate({
	description: `Records what a call the model made returned, or, with rejected, why it did not run. ${TOOL_CALL_RECORD}`,
})
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
	SessionStatusRunningEvent,
	SpanModelRequestStartEvent,
	AgentToolUseSessionEvent,
	AgentToolResultSessionEvent,
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

const listResponse = <A extends Schema.Top, C extends Schema.Top>(resource: A, cursor: C) =>
	Schema.Struct({
		data: Schema.Array(resource),
		has_more: Schema.Boolean,
		next_cursor: Schema.NullOr(cursor),
	})

export const ListAgentsResponse = listResponse(AgentResource, ResourceListCursor)
export type ListAgentsResponse = typeof ListAgentsResponse.Type

export const ListEnvironmentsResponse = listResponse(EnvironmentSnapshot, ResourceListCursor)
export type ListEnvironmentsResponse = typeof ListEnvironmentsResponse.Type

export const ListSessionsResponse = listResponse(SessionResource, ResourceListCursor)
export type ListSessionsResponse = typeof ListSessionsResponse.Type

export const ListArtifactsResponse = listResponse(ArtifactSummaryResource, ResourceListCursor)
export type ListArtifactsResponse = typeof ListArtifactsResponse.Type

export const ListVaultsResponse = listResponse(VaultResource, ResourceListCursor)
export type ListVaultsResponse = typeof ListVaultsResponse.Type

export const ListCredentialsResponse = listResponse(CredentialResource, ResourceListCursor)
export type ListCredentialsResponse = typeof ListCredentialsResponse.Type

export const ListAutomationsResponse = listResponse(AutomationResource, ResourceListCursor)
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

const ListLimitFromString = Schema.String.check(Schema.isPattern(/^(?:[1-9]\d?|100)$/u))
	.annotate({ description: "Maximum number of results to return (1-100, default 50)" })
	.pipe(
		Schema.decodeTo(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })), {
			decode: SchemaGetter.transform(Number),
			encode: SchemaGetter.transform(String),
		}),
	)

const booleanQuery = (description: string) =>
	Schema.Literals(["true", "false"])
		.annotate({ description })
		.pipe(
			Schema.decodeTo(Schema.Boolean, {
				decode: SchemaGetter.transform((value) => value === "true"),
				encode: SchemaGetter.transform((value) => (value ? "true" : "false")),
			}),
		)

const RunNumberFromString = Schema.String.check(Schema.isPattern(/^[1-9]\d{0,14}$/u))
	.annotate({ description: "Run number: a whole number from 1, written in decimal" })
	.pipe(
		Schema.decodeTo(
			Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999_999_999 })),
			{
				decode: SchemaGetter.transform(Number),
				encode: SchemaGetter.transform(String),
			},
		),
	)

const resourceListQuery = {
	after: Schema.optionalKey(ResourceListCursor),
	limit: Schema.optionalKey(ListLimitFromString),
	order: Schema.optionalKey(
		Schema.Literals(["asc", "desc"]).annotate({
			description: "Sort order by creation: asc (oldest first, the default) or desc",
		}),
	),
	include_archived: Schema.optionalKey(
		booleanQuery("Include archived results: true or false (default false)"),
	),
}

const { include_archived: _archivedArtifacts, ...artifactListQuery } = resourceListQuery

const resourceListCli = {
	intQueryParams: {
		limit: { min: 1, max: 100, metavar: "N" },
	},
}

const agentParams = { agent_id: AgentId.annotate({ description: "Agent ID" }) }
const environmentParams = {
	environment_id: EnvironmentId.annotate({ description: "Environment ID" }),
}
const sessionParams = { session_id: SessionId.annotate({ description: "Session ID" }) }
const automationParams = {
	automation_id: AutomationId.annotate({ description: "Automation ID" }),
}
const artifactParams = { artifact_id: ArtifactId.annotate({ description: "Artifact ID" }) }
const artifactVersionParams = { ...artifactParams, version: ArtifactVersionFromString }
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
		HttpApiEndpoint.get("list", "/v1/agents", {
			query: resourceListQuery,
			success: ListAgentsResponse,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List agents")
			.annotate(
				OpenApi.Description,
				"List agents in creation order, oldest first by default. Archived agents are left out unless include_archived is true.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "agents",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "agents", endpoint: "list" },
				"x-checkfu-mcp": { name: "agents_listAgents" },
				"x-checkfu-cli": resourceListCli,
			}),
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
		HttpApiEndpoint.get("list", "/v1/environments", {
			query: resourceListQuery,
			success: ListEnvironmentsResponse,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List environments")
			.annotate(
				OpenApi.Description,
				"List environments in creation order, oldest first by default. Archived environments are left out unless include_archived is true; deleted ones never appear.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "environments",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "environments", endpoint: "list" },
				"x-checkfu-mcp": { name: "environments_listEnvironments" },
				"x-checkfu-cli": resourceListCli,
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
		HttpApiEndpoint.get("list", "/v1/sessions", {
			query: {
				...resourceListQuery,
				agent_id: Schema.optionalKey(
					ResourceId.annotate({ description: "Only sessions created with this agent" }),
				),
			},
			success: ListSessionsResponse,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List sessions")
			.annotate(
				OpenApi.Description,
				"List sessions in creation order, oldest first by default. Archived sessions are left out unless include_archived is true.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "sessions",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "sessions", endpoint: "list" },
				"x-checkfu-mcp": { name: "sessions_listSessions" },
				"x-checkfu-cli": resourceListCli,
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
	.add(
		HttpApiEndpoint.get("getOutputs", "/v1/sessions/:session_id/outputs", {
			params: sessionParams,
			success: ArtifactResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve a session's outputs")
			.annotate(
				OpenApi.Description,
				"Retrieve the artifact a session publishes from its outputs directory, with the files of its latest version",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "sessions.outputs",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "sessions", endpoint: "getOutputs" },
				"x-checkfu-mcp": { name: "sessions_getOutputs" },
				"x-checkfu-cli": {
					groupDescription: "Retrieve what a session published from its outputs directory",
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
				...resourceListQuery,
				agent_id: Schema.optionalKey(
					ResourceId.annotate({ description: "Only automations that use this agent" }),
				),
			},
			success: ListAutomationsResponse,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List automations")
			.annotate(
				OpenApi.Description,
				"List automations in creation order, oldest first by default. Archived automations are left out unless include_archived is true. The list catches up shortly after a create or archive, so an automation missing from it does not mean its create failed: to find out, resend the create with its original idempotency key, which returns the automation it created.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "automations",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "automations", endpoint: "list" },
				"x-checkfu-mcp": { name: "automations_listAutomations" },
				"x-checkfu-cli": resourceListCli,
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
		HttpApiEndpoint.post("update", "/v1/automations/:automation_id", {
			params: automationParams,
			payload: UpdateAutomationBody,
			success: [AutomationResource, PendingAutomation],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Update an automation")
			.annotate(
				OpenApi.Description,
				"Change any of an automation's fields; the ones left out keep their values. Changes apply to runs that start after the update, and on an active automation a new schedule replaces the next firing. An archived automation can't be updated.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "automations",
				"x-forge-method-name": "update",
				"x-checkfu-endpoint": { group: "automations", endpoint: "update" },
				"x-checkfu-mcp": { name: "automations_updateAutomation" },
				"x-checkfu-cli": {
					textOrObjectFields: ["agent"],
					repeatArrayField: {
						field: "initial_events",
						flag: "initial-event",
						description: "The user message later runs start with, as JSON, YAML, or @file",
					},
				},
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
	.add(
		HttpApiEndpoint.get("getRun", "/v1/automations/:automation_id/runs/:run", {
			params: { ...automationParams, run: RunNumberFromString },
			success: AutomationRunResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve an automation run")
			.annotate(
				OpenApi.Description,
				"Retrieve one run of an automation by its run number, once it has started or failed",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "automations.runs",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "automations", endpoint: "getRun" },
				"x-checkfu-mcp": { name: "automations_getRun" },
			}),
	)
	.annotate(OpenApi.Description, "Manage automations")
	.middleware(Authentication)

const ARTIFACT_UPLOAD_LIMIT = `A version holds at most ${MAX_ARTIFACT_FILES} files, ${MAX_ARTIFACT_FILE_BYTES / 1024 / 1024} MiB each and ${MAX_ARTIFACT_TOTAL_BYTES / 1024 / 1024} MiB in total. Content sent inline in JSON is at most ${MAX_INLINE_FILE_BYTES / 1024 / 1024} MiB per file and ${MAX_INLINE_TOTAL_BYTES / 1024 / 1024} MiB per request, in a body of at most ${MAX_ARTIFACT_BODY_BYTES} bytes; upload larger files with PUT /v1/artifacts/{artifact_id}/blobs/{sha256} and name them by sha256.`

export const ArtifactBlobResource = Schema.Struct({
	type: Schema.Literal("artifact_blob"),
	artifact_id: ArtifactId,
	sha256: Sha256Hex,
	size: NonNegativeInt,
})
export type ArtifactBlob = typeof ArtifactBlobResource.Type

const Artifacts = HttpApiGroup.make("artifacts")
	.add(
		HttpApiEndpoint.post("create", "/v1/artifacts", {
			headers: IdempotencyHeaders,
			payload: CreateArtifactBody,
			success: [ArtifactResource.pipe(HttpApiSchema.status(201)), PendingArtifact],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Create an artifact")
			.annotate(
				OpenApi.Description,
				`Create an artifact from a set of files (version 1). ${ARTIFACT_UPLOAD_LIMIT}`,
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "artifacts",
				"x-forge-method-name": "create",
				"x-checkfu-endpoint": { group: "artifacts", endpoint: "create" },
				"x-checkfu-mcp": { name: "artifacts_createArtifact", destructive: false },
				"x-checkfu-cli": {
					maxInputBytes: MAX_ARTIFACT_BODY_BYTES,
					repeatArrayField: {
						field: "files",
						flag: "file",
						description:
							"File as JSON, YAML, or @file with path, content, and optional encoding and content_type (repeatable)",
					},
					examples: [
						{
							command:
								'checkfu artifacts create --name "Report" --file \'{"path":"index.html","content":"<h1>Hello</h1>"}\'',
							description: "Create a one-page artifact",
						},
					],
				},
			})
			.middleware(ArtifactBodyLimit),
	)
	.add(
		HttpApiEndpoint.get("list", "/v1/artifacts", {
			query: artifactListQuery,
			success: ListArtifactsResponse,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List artifacts")
			.annotate(
				OpenApi.Description,
				"List artifacts in creation order, oldest first by default, each with the size of its latest version but not its files; retrieve an artifact for those. Deleted artifacts never appear.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "artifacts",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "artifacts", endpoint: "list" },
				"x-checkfu-mcp": { name: "artifacts_listArtifacts" },
				"x-checkfu-cli": resourceListCli,
			}),
	)
	.add(
		HttpApiEndpoint.get("get", "/v1/artifacts/:artifact_id", {
			params: artifactParams,
			success: ArtifactResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve an artifact")
			.annotate(OpenApi.Description, "Retrieve an artifact and the files of its latest version")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "artifacts",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "artifacts", endpoint: "get" },
				"x-checkfu-mcp": { name: "artifacts_getArtifact" },
			}),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/v1/artifacts/:artifact_id", {
			params: artifactParams,
			success: ArtifactDeleted,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Delete an artifact")
			.annotate(OpenApi.Description, "Delete an artifact and every stored version of its files")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "artifacts",
				"x-forge-method-name": "delete",
				"x-checkfu-endpoint": { group: "artifacts", endpoint: "delete" },
				"x-checkfu-mcp": { name: "artifacts_deleteArtifact" },
			}),
	)
	.add(
		HttpApiEndpoint.post("createVersion", "/v1/artifacts/:artifact_id/versions", {
			params: artifactParams,
			payload: CreateArtifactVersionBody,
			success: [ArtifactVersionResource.pipe(HttpApiSchema.status(201)), PendingArtifactVersion],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Create an artifact version")
			.annotate(
				OpenApi.Description,
				`Add a new immutable version to an artifact. ${ARTIFACT_UPLOAD_LIMIT}`,
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "artifacts.versions",
				"x-forge-method-name": "create",
				"x-checkfu-endpoint": { group: "artifacts", endpoint: "createVersion" },
				"x-checkfu-mcp": { name: "artifacts_createArtifactVersion", destructive: false },
				"x-checkfu-cli": {
					groupDescription: "Create and read artifact versions",
					maxInputBytes: MAX_ARTIFACT_BODY_BYTES,
					repeatArrayField: {
						field: "files",
						flag: "file",
						description:
							"File as JSON, YAML, or @file with path and content (optional encoding and content_type), or path and the sha256 of a file to keep from the version being replaced (repeatable)",
					},
				},
			})
			.middleware(ArtifactBodyLimit),
	)
	.add(
		HttpApiEndpoint.get("getVersion", "/v1/artifacts/:artifact_id/versions/:version", {
			params: artifactVersionParams,
			success: ArtifactVersionResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve an artifact version")
			.annotate(OpenApi.Description, "Retrieve one version of an artifact and its file list")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "artifacts.versions",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "artifacts", endpoint: "getVersion" },
				"x-checkfu-mcp": { name: "artifacts_getArtifactVersion" },
			}),
	)
	.add(
		HttpApiEndpoint.get("getFile", "/v1/artifacts/:artifact_id/versions/:version/file", {
			params: artifactVersionParams,
			query: {
				file: ArtifactPath.annotate({
					description: "Path of the file inside the version, for example index.html",
				}),
			},
			success: ArtifactFileResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve an artifact file")
			.annotate(
				OpenApi.Description,
				"Retrieve one file of an artifact version; content is text when it is valid UTF-8 and base64 otherwise",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "artifacts.versions",
				"x-forge-method-name": "file",
				"x-checkfu-endpoint": { group: "artifacts", endpoint: "getFile" },
				"x-checkfu-mcp": { name: "artifacts_getArtifactFile" },
			}),
	)
	.add(
		HttpApiEndpoint.get("getFileContent", "/v1/artifacts/:artifact_id/versions/:version/content", {
			params: artifactVersionParams,
			query: {
				file: ArtifactPath.annotate({
					description: "Path of the file inside the version, for example index.html",
				}),
			},
			success: HttpApiSchema.StreamUint8Array(),
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Download an artifact file")
			.annotate(
				OpenApi.Description,
				"Download one file of an artifact version as its raw bytes, with its content type",
			)
			.annotate(OpenApi.Override, {
				"x-forge-skip": true,
				"x-checkfu-endpoint": { group: "artifacts", endpoint: "getFileContent" },
			}),
	)
	.add(
		HttpApiEndpoint.put("uploadBlob", "/v1/artifacts/:artifact_id/blobs/:sha256", {
			params: {
				...artifactParams,
				sha256: Sha256Hex.annotate({ description: "sha256 of the bytes, as lowercase hex" }),
			},
			payload: Schema.Uint8Array.pipe(
				HttpApiSchema.asUint8Array({ contentType: "application/octet-stream" }),
			),
			success: ArtifactBlobResource,
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Upload file bytes to an artifact")
			.annotate(
				OpenApi.Description,
				`Store raw bytes in an artifact under their sha256, so a version can name them by sha256 without sending them inline. The request needs a Content-Length header, and the bytes must match the sha256 and be at most ${MAX_ARTIFACT_FILE_BYTES / 1024 / 1024} MiB. Uploading bytes the artifact already holds checks them and stores nothing new.`,
			)
			.annotate(OpenApi.Override, {
				"x-forge-skip": true,
				"x-checkfu-endpoint": { group: "artifacts", endpoint: "uploadBlob" },
			})
			.middleware(ArtifactBlobLimit),
	)
	.add(
		HttpApiEndpoint.post("createLink", "/v1/artifacts/:artifact_id/versions/:version/links", {
			params: artifactVersionParams,
			payload: CreateArtifactLinkBody,
			success: ArtifactLinkResource.pipe(HttpApiSchema.status(201)),
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Create a viewing link")
			.annotate(
				OpenApi.Description,
				"Create a link that opens one artifact version in a browser until it expires; anyone holding the link can view it",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "artifacts.versions",
				"x-forge-method-name": "link",
				"x-checkfu-endpoint": { group: "artifacts", endpoint: "createLink" },
				"x-checkfu-mcp": { name: "artifacts_createArtifactLink", destructive: false },
				"x-checkfu-cli": {
					examples: [
						{
							command:
								"checkfu artifacts:versions link --artifact-id art_123 --current-version 1 --expires-in 600",
							description: "Create a link that works for ten minutes",
						},
					],
				},
			}),
	)
	.add(
		HttpApiEndpoint.post("publish", "/v1/artifacts/:artifact_id/publication", {
			params: artifactParams,
			headers: IdempotencyHeaders,
			payload: PublishArtifactBody,
			success: ArtifactResource,
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Publish an artifact")
			.annotate(
				OpenApi.Description,
				"Serve an artifact at a public address that anyone who has it can view. Publishing again changes the version served and keeps the address; after an unpublish, the next publish gets a new address. A retry with the same Idempotency-Key is not applied again, so it cannot undo a later unpublish; the same key with another version, or one used to unpublish, answers 409",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "artifacts",
				"x-forge-method-name": "publish",
				"x-checkfu-endpoint": { group: "artifacts", endpoint: "publish" },
				"x-checkfu-mcp": { name: "artifacts_publishArtifact" },
				"x-checkfu-cli": {
					examples: [
						{
							command: "checkfu artifacts publish --artifact-id art_123",
							description: "Publish an artifact and serve each new version as it is added",
						},
					],
				},
			}),
	)
	.add(
		HttpApiEndpoint.delete("unpublish", "/v1/artifacts/:artifact_id/publication", {
			params: artifactParams,
			headers: IdempotencyHeaders,
			success: ArtifactResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Unpublish an artifact")
			.annotate(
				OpenApi.Description,
				"Take an artifact's public address down at once; the artifact is kept. A retry with the same Idempotency-Key is not applied again, so it cannot undo a later publish; a key used to publish answers 409",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "artifacts",
				"x-forge-method-name": "unpublish",
				"x-checkfu-endpoint": { group: "artifacts", endpoint: "unpublish" },
				"x-checkfu-mcp": { name: "artifacts_unpublishArtifact" },
			}),
	)
	.annotate(OpenApi.Description, "Manage artifacts")
	.middleware(Authentication)

const Vaults = HttpApiGroup.make("vaults")
	.add(
		HttpApiEndpoint.post("create", "/v1/vaults", {
			headers: IdempotencyHeaders,
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
		HttpApiEndpoint.get("list", "/v1/vaults", {
			query: resourceListQuery,
			success: ListVaultsResponse,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List vaults")
			.annotate(
				OpenApi.Description,
				"List vaults in creation order, oldest first by default. Archived vaults are left out unless include_archived is true.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "vaults",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "vaults", endpoint: "list" },
				"x-checkfu-mcp": { name: "vaults_listVaults" },
				"x-checkfu-cli": resourceListCli,
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
			.annotate(
				OpenApi.Description,
				"Delete a vault and its credentials. Every secret in the vault is erased before this answers; custody.erasing counts the credentials whose records have not caught up yet, and sending the delete again returns the current count. A 503 means the delete is recorded but the erasure is not confirmed: send it again.",
			)
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
			.annotate(
				OpenApi.Description,
				"Archive a vault and its credentials. Every secret in the vault is erased before this answers; custody.erasing counts the credentials whose records have not caught up yet. A 503 means the archive is recorded but the erasure is not confirmed: send it again.",
			)
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
			headers: IdempotencyHeaders,
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
			query: resourceListQuery,
			success: ListCredentialsResponse,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List credentials")
			.annotate(
				OpenApi.Description,
				"List a vault's credentials in creation order, oldest first by default. Archived credentials are left out unless include_archived is true.",
			)
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
			.annotate(
				OpenApi.Description,
				"Delete a credential. Its secret is erased before this answers, and sending the delete again returns the current state. A 503 means the delete is recorded but the erasure is not confirmed: send it again.",
			)
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
			.annotate(
				OpenApi.Description,
				"Archive a credential. Its secret is erased before this answers. A 503 means the archive is recorded but the erasure is not confirmed: send it again.",
			)
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
	.add(Artifacts)
	.add(Vaults)
	.annotate(OpenApi.Title, "Checkfu API")
	.annotate(OpenApi.Version, "0.0.1")
	.annotate(
		OpenApi.Description,
		"Managed agents API for managing agents, environments, sessions, automations, artifacts, and vaults.",
	)
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
