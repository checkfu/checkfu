import * as Effect from "effect/Effect"
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
import { ERROR_CODES } from "./ErrorCodes.ts"
import type { ErrorCode } from "./ErrorCodes.ts"
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
	ArtifactAccessLevel,
	ArtifactCapabilities,
	ArtifactCollectionName,
	ArtifactDataGrant,
	ArtifactDocumentId,
	MAX_ARTIFACT_COLLECTIONS,
	ArtifactFile,
	ArtifactFilesInput,
	ArtifactVersionFilesInput,
	ArtifactId,
	ArtifactMount,
	ARTIFACT_MOUNT_ROOT,
	SkillMount,
	FileMount,
	FILE_MOUNT_ROOT,
	MAX_MOUNT_PATH_LENGTH,
	ArtifactName,
	ArtifactPath,
	ArtifactContentType,
	FileId,
	FileName,
	MAX_FILE_BYTES,
	AutomationId,
	AutomationDescription,
	AutomationName,
	AutomationRunError,
	AutomationSchedule,
	CronExpression,
	AutomationSnapshot,
	ContentSha256,
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
	MAX_MCP_SERVERS,
	MAX_MCP_SERVER_URL_LENGTH,
	McpServer,
	McpServerName,
	McpServerUrl,
	DenyMessage,
	MAX_CUSTOM_TOOL_RESULT_LENGTH,
	MAX_IDENTIFIER_LENGTH,
	MAX_MESSAGE_TEXT_LENGTH,
	MAX_SESSION_INITIAL_EVENTS,
	CancelledEventIds,
	RequiresActionStopReason,
	StopReason,
	ToolConfirmationResult,
	GitHubRepositoryResource,
	MAX_SESSION_RESOURCES,
	MemoryAccess,
	MemoryInstructions,
	MemoryStoreResource,
	MemoryContent,
	MemoryId,
	MemoryIndexEntry,
	MemoryPath,
	MemorySnapshot,
	MemoryStoreDescription,
	MemoryStoreId,
	MemoryStoreName,
	MemoryStoreSnapshot,
	NonEmptyString,
	PositiveInt,
	PublicationAddress,
	RepositoryAccess,
	RepositoryCheckout,
	RepositoryMountPath,
	RepositoryTokenText,
	RepositoryUrl,
	ResourceId,
	Timezone,
	ResourceListCursor,
	SessionEventFields,
	SessionId,
	SessionResourceId,
	SessionSnapshot,
	SessionTitle,
	Sha256Hex,
	SystemMessageContent,
	TextBlocks,
	VaultCustody,
	VaultDisplayName,
	VaultId,
	VaultSnapshot,
	MAX_WEBHOOK_EVENT_TYPES,
	WebhookDeliveryId,
	WebhookDeliveryOutcome,
	WebhookDeliveryStatus,
	WebhookDescription,
	WebhookEndpointStatus,
	WebhookEventId,
	WebhookEventSubscription,
	WebhookId,
	WebhookUrl,
	CustomTool,
	CustomToolName,
	McpToolset,
	MAX_CUSTOM_TOOLS,
	MAX_CUSTOM_TOOL_INPUT_SCHEMA_LENGTH,
} from "./Schemas.ts"
import type { AgentTool, SessionEventType } from "./Schemas.ts"
import {
	MAX_EVENTS_BODY_BYTES,
	MAX_ARTIFACT_COLLECTION_DOCUMENTS,
	MAX_ARTIFACT_DATABASE_BYTES,
	MAX_ARTIFACT_DOCUMENT_BYTES,
	MAX_SESSION_BODY_BYTES,
	MAX_SESSION_EVENTS_PER_BATCH,
	MAX_SESSION_INITIAL_MESSAGES_BYTES,
	MAX_SESSION_VAULTS,
} from "./Limits.ts"

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

export { ERROR_CODES } from "./ErrorCodes.ts"
export type { ErrorCode } from "./ErrorCodes.ts"

const ErrorCodeSchema = Schema.Literals(Object.values(ERROR_CODES)).annotate({
	identifier: "ErrorCode",
})

export const ErrorCodeField = Schema.optionalKey(ErrorCodeSchema).pipe(
	Schema.catchDecoding(() => Effect.succeedNone),
)

const errorEnvelope = <const S extends ErrorStatus>(status: S) =>
	Schema.Struct({
		type: Schema.Literal("error"),
		error: Schema.Struct({
			type: Schema.Literal(ERROR_TYPES[status]),
			message: Schema.String,
			code: ErrorCodeField,
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
	readonly code?: ErrorCode
	readonly accepted?: ReadonlyArray<unknown>
	readonly failed_index?: number
	readonly unconfirmed_index?: number
}

const makeError =
	<const S extends ErrorStatus>(status: S) =>
	(message: string, request_id: RequestId, { code, ...extra }: ApiErrorExtra = {}) => ({
		type: "error" as const,
		error: { type: ERROR_TYPES[status], message, ...(code === undefined ? {} : { code }) },
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
		code: Schema.optional(ErrorCodeSchema),
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
		...(error.code === undefined ? {} : { code: error.code }),
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

export class FileBodyLimit extends HttpApiMiddleware.Service<FileBodyLimit>()(
	"@checkfu/api/FileBodyLimit",
	{ error: ERRORS[413] },
) {}

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

const distinct = <A>(key: (item: A) => string | undefined, twice: (key: string) => string) =>
	Schema.makeFilter<ReadonlyArray<A>>((items) => {
		const seen = new Set<string>()
		for (const item of items) {
			const name = key(item)
			if (name !== undefined) {
				if (seen.has(name)) {
					return twice(name)
				}
				seen.add(name)
			}
		}
		return true
	})

const McpServersInput = Schema.Array(
	Schema.Struct({ ...McpServer.fields, url: McpServerUrlInput }),
).check(
	distinct(
		(server: McpServer) => server.name,
		(name) => `Two MCP servers are named "${name}".`,
	),
	Schema.isMaxLength(MAX_MCP_SERVERS),
)

export const RESERVED_TOOL_NAMES: ReadonlyArray<string> = [
	"read",
	"ls",
	"find",
	"grep",
	"write",
	"edit",
	"delete",
	"bash",
	"save_artifact",
	"artifact_data",
	"codemode",
	"tool_search",
]

const McpToolsetInput = Schema.Struct({
	...McpToolset.fields,
	configs: Schema.optionalKey(
		McpToolset.fields.configs.schema.check(
			distinct(
				(config: { readonly name: string }) => config.name,
				(name) => `An mcp_toolset configures "${name}" twice.`,
			),
		),
	),
})

const CustomToolInput = Schema.Struct({
	...CustomTool.fields,
	name: CustomToolName.check(
		Schema.makeFilter(
			(name) =>
				(!RESERVED_TOOL_NAMES.includes(name) && !name.startsWith("mcp__")) ||
				`The custom tool name "${name}" is taken by a built-in tool.`,
		),
	),
	input_schema: Schema.JsonObject.check(
		Schema.makeFilter(
			(schema) => schema["type"] === "object" || 'An input_schema must have type "object".',
		),
		Schema.makeFilter(
			(schema) =>
				JSON.stringify(schema).length <= MAX_CUSTOM_TOOL_INPUT_SCHEMA_LENGTH ||
				`An input_schema is at most ${MAX_CUSTOM_TOOL_INPUT_SCHEMA_LENGTH} characters of JSON.`,
		),
	),
})

const AgentToolsInput = Schema.Array(Schema.Union([McpToolsetInput, CustomToolInput])).check(
	distinct(
		(tool: AgentTool) => (tool.type === "mcp_toolset" ? tool.mcp_server_name : undefined),
		(name) => `Two mcp_toolset entries name "${name}".`,
	),
	distinct(
		(tool: AgentTool) => (tool.type === "custom" ? tool.name : undefined),
		(name) => `Two custom tools are named "${name}".`,
	),
	Schema.makeFilter(
		(tools: ReadonlyArray<AgentTool>) =>
			tools.filter((tool) => tool.type === "custom").length <= MAX_CUSTOM_TOOLS ||
			`An agent has at most ${MAX_CUSTOM_TOOLS} custom tools.`,
	),
	Schema.isMaxLength(MAX_MCP_SERVERS + MAX_CUSTOM_TOOLS),
)

export class MemoryBodyLimit extends HttpApiMiddleware.Service<MemoryBodyLimit>()(
	"@checkfu/api/MemoryBodyLimit",
) {}

export class SessionBodyLimit extends HttpApiMiddleware.Service<SessionBodyLimit>()(
	"@checkfu/api/SessionBodyLimit",
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
	mcp_servers: Schema.optionalKey(
		McpServersInput.annotate({
			description:
				"MCP servers whose tools the agent may use. Each tool is offered as mcp__<server>__<tool>.",
		}),
	),
	tools: Schema.optionalKey(
		AgentToolsInput.annotate({
			description:
				"Permission policies for MCP servers' tools (mcp_toolset) and custom tools the caller's application runs (custom).",
		}),
	),
})
export type CreateAgentBody = typeof CreateAgentBody.Type

export const UpdateAgentBody = Schema.Struct({
	version: Schema.optionalKey(
		PositiveInt.annotate({
			description: "Apply the update only if the agent is still at this version",
		}),
	),
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
	mcp_servers: Schema.optionalKey(
		McpServersInput.annotate({ description: "Replacement list of the agent's MCP servers" }),
	),
	tools: Schema.optionalKey(
		AgentToolsInput.annotate({ description: "Replacement list of the agent's tool declarations" }),
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

export const ArtifactMadeFrom = Schema.Struct({
	artifact_id: ArtifactId,
	version: PositiveInt,
})
export type ArtifactMadeFrom = typeof ArtifactMadeFrom.Type

const MadeFromField = Schema.optionalKey(
	ArtifactMadeFrom.annotate({
		description:
			"Start from another artifact version, such as a type. The source supplies its files and any capability declaration. Add files at new paths and leave out artifact.json. The copy survives changes to or deletion of the source",
	}),
)

export const CreateArtifactBody = Schema.Struct({
	name: ArtifactName.annotate({ description: "Human-readable artifact name" }),
	files: Schema.optionalKey(
		ArtifactFilesField.annotate({
			description:
				"Every file of version 1, or with made_from the files to add to the source's. Send a small file's content inline, or name a file by its id. Required unless made_from is given",
		}),
	),
	made_from: MadeFromField,
})
export type CreateArtifactBody = typeof CreateArtifactBody.Type

export const CreateArtifactVersionBody = Schema.Struct({
	version: PositiveInt.annotate({
		description: "Current artifact version for optimistic concurrency",
	}),
	files: Schema.optionalKey(
		ArtifactVersionFilesInput.annotate({
			description:
				"Every file of the version, or with made_from the files to add to the source's; a new version replaces the whole set. Send a small file's content inline, name a file by its id, or keep a file of the current version by its sha256. Required unless made_from is given",
		}),
	),
	made_from: MadeFromField,
})
export type CreateArtifactVersionBody = typeof CreateArtifactVersionBody.Type

const AgentReference = Schema.Union([
	ResourceId,
	Schema.Struct({
		type: Schema.Literal("agent"),
		id: ResourceId,
		version: Schema.optionalKey(PositiveInt),
	}),
])

export const CreateMemoryStoreBody = Schema.Struct({
	name: MemoryStoreName.annotate({ description: "Name shown to the agent" }),
	description: Schema.optionalKey(
		MemoryStoreDescription.annotate({
			description: "What the store holds. Shown to the agent.",
		}),
	),
})

export const UpdateMemoryStoreBody = Schema.Struct({
	name: Schema.optionalKey(MemoryStoreName.annotate({ description: "New name" })),
	description: Schema.optionalKey(
		MemoryStoreDescription.annotate({ description: "New description" }),
	),
})

export const CreateMemoryBody = Schema.Struct({
	path: MemoryPath.annotate({ description: "Path inside the store, such as /notes/todo.md" }),
	content: MemoryContent.annotate({ description: "Text of the memory, up to 100 kB" }),
})

export const UpdateMemoryBody = Schema.Struct({
	content: MemoryContent.annotate({ description: "New text of the memory" }),
	precondition: Schema.optionalKey(
		Schema.Struct({
			type: Schema.Literal("content_sha256"),
			content_sha256: ContentSha256,
		}).annotate({
			description: "Apply only if the stored content still has this SHA-256",
		}),
	),
})

export const MemoryListItem = Schema.Struct({
	...MemoryIndexEntry.fields,
	type: Schema.Literal("memory"),
	memory_store_id: MemoryStoreId,
})

export const GitHubRepositoryParams = Schema.Struct({
	type: Schema.Literal("github_repository"),
	url: RepositoryUrl.annotate({
		description: "Repository URL, https://github.com/<owner>/<repository>",
	}),
	authorization_token: Schema.optionalKey(
		RepositoryTokenText.annotate({
			description:
				"GitHub token used to clone and fetch, and to push when access is read_write. Never returned.",
		}),
	),
	access: Schema.optionalKey(
		RepositoryAccess.annotate({
			description:
				"read_write (default) lets the session push with the token. read_only allows clone and fetch.",
		}),
	),
	checkout: Schema.optionalKey(
		Schema.NullOr(RepositoryCheckout).annotate({
			description: "Branch or commit to check out. Defaults to the default branch.",
		}),
	),
	mount_path: Schema.optionalKey(
		RepositoryMountPath.annotate({
			description: "Where the repository is cloned. Defaults to /workspace/<repository>.",
		}),
	),
})

export const MemoryStoreParams = Schema.Struct({
	type: Schema.Literal("memory_store"),
	memory_store_id: ResourceId.annotate({ description: "Memory store to mount" }),
	access: Schema.optionalKey(
		MemoryAccess.annotate({
			description: "read_write (default) saves the session's changes; read_only does not",
		}),
	),
	instructions: Schema.optionalKey(
		Schema.NullOr(MemoryInstructions).annotate({
			description: "How this session should use the store. Shown to the agent.",
		}),
	),
})

export const ArtifactMountParams = Schema.Struct({
	type: Schema.Literal("artifact"),
	artifact_id: ResourceId.annotate({ description: "Artifact whose files to mount, read-only" }),
	version: Schema.optionalKey(
		PositiveInt.annotate({ description: "Version to mount (default: the current version)" }),
	),
	mount_path: Schema.optionalKey(
		ArtifactPath.check(
			Schema.isMaxCodePoints(
				Math.floor((MAX_MOUNT_PATH_LENGTH - ARTIFACT_MOUNT_ROOT.length - 1) / 2),
			),
			Schema.isPattern(/^[^/]+$/u),
		).annotate({
			description: `Directory name under ${ARTIFACT_MOUNT_ROOT}. Defaults to a name derived from the artifact's name.`,
		}),
	),
})

export const SkillMountParams = Schema.Struct({
	type: Schema.Literal("skill"),
	artifact_id: ResourceId.annotate({
		description:
			"Artifact that holds the skill: a SKILL.md at its root, and the files it refers to",
	}),
	version: Schema.optionalKey(
		PositiveInt.annotate({ description: "Version to use (default: the current version)" }),
	),
})

const MAX_FILE_MOUNT_RELATIVE_LENGTH = MAX_MOUNT_PATH_LENGTH - FILE_MOUNT_ROOT.length - 1

export const FileMountParams = Schema.Struct({
	type: Schema.Literal("file"),
	file_id: FileId.annotate({
		description: "File to place in the session's uploads directory, read-only",
	}),
	mount_path: Schema.optionalKey(
		ArtifactPath.check(Schema.isMaxLength(MAX_FILE_MOUNT_RELATIVE_LENGTH)).annotate({
			description: `Path relative to ${FILE_MOUNT_ROOT}, up to ${MAX_FILE_MOUNT_RELATIVE_LENGTH} UTF-16 code units. Defaults to the file's name.`,
		}),
	),
})

const CreateSessionResource = Schema.Union([
	GitHubRepositoryParams,
	MemoryStoreParams,
	ArtifactMountParams,
	SkillMountParams,
	FileMountParams,
])
export type CreateSessionResource = typeof CreateSessionResource.Type

const CreateSessionResources = Schema.Array(CreateSessionResource).check(
	Schema.isMaxLength(MAX_SESSION_RESOURCES),
)

const SessionAgentReference = AgentReference.annotate({
	description:
		'Agent to run in the session. Pass an ID to pin the latest version, or pass an object with type "agent", id, and version to pin a specific version.',
})

const AutomationAgentReference = AgentReference.annotate({
	description:
		'Agent to run in each session. Pass an ID to pin the latest version, or pass an object with type "agent", id, and version to pin a specific version.',
})

export const CreateSessionBody = Schema.Struct({
	agent: SessionAgentReference,
	initial_events: Schema.optionalKey(
		Schema.Array(Schema.Struct({ type: Schema.Literal("user.message"), content: TextBlocks }))
			.check(Schema.isMaxLength(MAX_SESSION_INITIAL_EVENTS))
			.annotate({
				description: `User messages to send in order when the session is created. Each message's text blocks are joined with newlines. Each combined message can contain up to ${MAX_MESSAGE_TEXT_LENGTH} UTF-16 code units. The JSON array of combined message strings can contain up to ${MAX_SESSION_INITIAL_MESSAGES_BYTES} UTF-8 bytes. The whole request body can contain up to ${MAX_SESSION_BODY_BYTES} UTF-8 bytes.`,
			}),
	),
	environment_id: ResourceId.annotate({ description: "Environment ID for the session" }),
	title: Schema.optionalKey(
		Schema.NullOr(SessionTitle).annotate({ description: "Optional session title" }),
	),
	vault_ids: Schema.optionalKey(
		Schema.Array(VaultId).check(Schema.isMaxLength(MAX_SESSION_VAULTS)).annotate({
			description:
				"Vaults whose credentials the session may use. A server with exactly one matching credential across them is bound to it.",
		}),
	),
	mcp_server_credentials: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				mcp_server_name: McpServerName,
				credential_id: CredentialId,
			}),
		)
			.check(Schema.isMaxLength(MAX_MCP_SERVERS))
			.annotate({
				description:
					"Explicit credentials for named servers. An explicit binding wins over vault matching.",
			}),
	),
	resources: Schema.optionalKey(
		CreateSessionResources.annotate({
			description:
				"Repositories, memory stores, artifacts, skills and files to mount in the session's workspace",
		}),
	),
})
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
	agent: AutomationAgentReference,
	environment_id: ResourceId.annotate({ description: "Environment ID each run's session uses" }),
	initial_events: AutomationInitialEvents.annotate({
		description: `Initial events sent when each run creates a session. Supply one text user.message event of up to ${MAX_MESSAGE_TEXT_LENGTH} UTF-16 code units after its text blocks are joined with newlines.`,
	}),
	schedule: AutomationSchedule.annotate({
		description:
			"When the automation fires: a cron expression that names a single minute, so it fires at most once per clock hour, read in an IANA time zone name such as America/New_York",
	}),
})
export type CreateAutomationBody = typeof CreateAutomationBody.Type

export const UpdateAutomationBody = Schema.Struct({
	revision: Schema.optionalKey(
		PositiveInt.annotate({
			description:
				"Current automation revision. If supplied, the update fails when the revision has changed.",
		}),
	),
	name: Schema.optionalKey(AutomationName.annotate({ description: "New automation name" })),
	description: Schema.optionalKey(
		Schema.NullOr(AutomationDescription).annotate({
			description:
				"New description. To clear it, send null for description in a JSON or YAML body on stdin; the --description flag always sends text.",
		}),
	),
	agent: Schema.optionalKey(AutomationAgentReference),
	environment_id: Schema.optionalKey(
		ResourceId.annotate({ description: "Environment ID later runs' sessions use" }),
	),
	initial_events: Schema.optionalKey(
		AutomationInitialEvents.annotate({
			description: "Initial events for future runs. Supply one text user.message event.",
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

const ToolUseEventId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(2 * MAX_IDENTIFIER_LENGTH + "sevt__tool_".length),
)

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
				type: Schema.Literal("system.message"),
				content: SystemMessageContent,
			}),
			Schema.Struct({
				id: Schema.optionalKey(ClientEventId),
				type: Schema.Literal("user.tool_confirmation"),
				tool_use_id: ToolUseEventId.annotate({
					description: "The agent.mcp_tool_use event that waits for this answer",
				}),
				result: ToolConfirmationResult,
				deny_message: Schema.optionalKey(
					DenyMessage.annotate({ description: "Why the call was denied; the model reads it" }),
				),
			}),
			Schema.Struct({
				id: Schema.optionalKey(ClientEventId),
				type: Schema.Literal("user.custom_tool_result"),
				custom_tool_use_id: ToolUseEventId.annotate({
					description: "The agent.custom_tool_use event this result answers",
				}),
				content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }))
					.check(Schema.isMaxLength(64))
					.annotate({
						description: `The result the model reads; at most ${MAX_CUSTOM_TOOL_RESULT_LENGTH} characters in all`,
					}),
				is_error: Schema.optionalKey(Schema.Boolean),
			}),
		]),
	)
		.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SESSION_EVENTS_PER_BATCH))
		.annotate({
			description: "Session events in submission order.",
		}),
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
						writeOnly: true,
						"x-forge-sensitive": true,
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

const vaultDeleted = <const Secrets extends "erased" | "erasing">(secrets: Secrets) =>
	Schema.Struct({
		id: Schema.String,
		type: Schema.Literal("vault_deleted"),
		secrets: Schema.Literal(secrets).annotate({
			description:
				"erased once the vault's storage confirmed every secret gone; erasing while that finishes in the background",
		}),
		custody: VaultCustody,
	})
export const VaultDeletedErased = vaultDeleted("erased")
export const VaultDeletedErasing = vaultDeleted("erasing").pipe(HttpApiSchema.status(202))
export const VaultDeleted = Schema.Union([VaultDeletedErased, VaultDeletedErasing])
export type VaultDeleted = typeof VaultDeleted.Type

const credentialDeleted = <const Custody extends "erased" | "erasing">(custody: Custody) =>
	Schema.Struct({
		id: Schema.String,
		type: Schema.Literal("vault_credential_deleted"),
		custody: Schema.Literal(custody),
	})
export const CredentialDeletedErased = credentialDeleted("erased")
export const CredentialDeletedErasing = credentialDeleted("erasing").pipe(HttpApiSchema.status(202))
export const CredentialDeleted = Schema.Union([CredentialDeletedErased, CredentialDeletedErasing])
export type CredentialDeleted = typeof CredentialDeleted.Type

const resourceTimestamps = {
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
}

export const SessionResourceItem = Schema.Union([
	Schema.Struct({ ...GitHubRepositoryResource.fields, ...resourceTimestamps }),
	Schema.Struct({ ...MemoryStoreResource.fields, ...resourceTimestamps }),
	Schema.Struct({ ...ArtifactMount.fields, ...resourceTimestamps }),
	Schema.Struct({ ...SkillMount.fields, ...resourceTimestamps }),
	Schema.Struct({ ...FileMount.fields, ...resourceTimestamps }),
])
export type SessionResourceItem = typeof SessionResourceItem.Type

export const UpdateSessionResourceBody = Schema.Struct({
	authorization_token: RepositoryTokenText.annotate({
		description: "New GitHub token for the repository. Never returned.",
	}),
})

export const SessionResource = Schema.Struct({
	...Struct.omit(SessionSnapshot.fields, ["agent_id", "agent_version", "resources"]),
	agent: Schema.Struct({
		...Struct.pick(AgentResource.fields, [
			"id",
			"type",
			"version",
			"name",
			"model",
			"system",
			"description",
			"mcp_servers",
			"tools",
		]),
	}).annotate({ description: "The pinned agent configuration used by the session." }),
	resources: Schema.Array(SessionResourceItem),
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
	agent: Schema.Struct({ id: Schema.String, version: PositiveInt }),
	initial_events: AutomationInitialEvents,
	run_count: Schema.Int,
	upcoming_runs_at: Schema.Array(Schema.DateTimeUtc),
})
export type Automation = typeof AutomationResource.Type

export const AutomationRunResource = Schema.Struct({
	id: ResourceId,
	type: Schema.Literal("automation_run"),
	automation_id: AutomationId,
	run: PositiveInt,
	status: Schema.Literals(["started", "failed"]),
	trigger: Schema.Union([
		Schema.Struct({ type: Schema.Literal("schedule"), scheduled_at: Schema.DateTimeUtc }),
		Schema.Struct({ type: Schema.Literal("manual") }),
	]),
	agent: Schema.Struct({ id: Schema.String, version: PositiveInt }).annotate({
		description: "The agent and version pinned for this run.",
	}),
	session_id: Schema.NullOr(Schema.String),
	error: Schema.NullOr(AutomationRunError),
	created_at: Schema.DateTimeUtc,
})
export type AutomationRun = typeof AutomationRunResource.Type

export const AutomationRunQueued = Schema.Struct({
	id: ResourceId,
	type: Schema.Literal("automation_run"),
	automation_id: AutomationId,
	run: PositiveInt,
	status: Schema.Literal("queued"),
	trigger: Schema.Struct({ type: Schema.Literal("manual") }),
	session_id: SessionId.annotate({ description: "Session ID the run will use if it starts" }),
}).pipe(HttpApiSchema.status(201))
export type AutomationRunQueued = typeof AutomationRunQueued.Type

const ArtifactCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const ArtifactPublication = Schema.Struct({
	address: PublicationAddress,
	url: Schema.String,
	version: Schema.NullOr(PositiveInt).annotate({
		description: "The version served, or null when the latest version is served",
	}),
	access: ArtifactAccessLevel.annotate({
		description:
			"What anyone with the address may do: view the files only, also read the artifact's data, or also write it",
	}),
	grants: ArtifactDataGrant.annotate({
		description:
			"The most a visitor may do in each collection, recorded when the access level was set from the version then served. A later version cannot widen it",
	}),
	published_at: Schema.DateTimeUtc,
})
export type ArtifactPublication = typeof ArtifactPublication.Type

export const ArtifactResource = Schema.Struct({
	id: ArtifactId,
	type: Schema.Literal("artifact"),
	name: Schema.String,
	version: PositiveInt.annotate({ description: "Current version" }),
	capabilities: ArtifactCapabilities,
	made_from: Schema.NullOr(ArtifactMadeFrom).annotate({
		description: "The artifact version this version's files were started from, or null",
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
	access: Schema.optionalKey(
		ArtifactAccessLevel.annotate({
			description:
				"What anyone with the address may do with the artifact's data: view (files only), read or write. Each collection still allows at most what the version served declares for visitors. Collections a later version adds stay closed to visitors until a level is set again. Omit it to keep the level already set; a new publication starts at view",
		}),
	),
	if_current: Schema.optionalKey(
		Schema.Struct({
			version: PositiveInt.annotate({
				description: "The current artifact version you reviewed, regardless of the version served",
			}),
			publication: Schema.NullOr(
				ArtifactPublication.mapFields(
					({ url: _url, published_at: _publishedAt, ...settings }) => settings,
				),
			).annotate({
				description:
					"The address and settings you reviewed, or null if the artifact was unpublished",
			}),
		}).annotate({
			description:
				"Require the artifact version and publication settings to match the values you reviewed. Answers 409 if either changed",
		}),
	),
})
export type PublishArtifactBody = typeof PublishArtifactBody.Type

export const ArtifactVersionResource = Schema.Struct({
	type: Schema.Literal("artifact_version"),
	artifact_id: Schema.String,
	version: PositiveInt,
	capabilities: ArtifactCapabilities,
	made_from: Schema.NullOr(ArtifactMadeFrom).annotate({
		description: "The artifact version this version's files were started from, or null",
	}),
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
	access: Schema.optionalKey(
		ArtifactAccessLevel.annotate({
			description:
				"What anyone with the link may do with the artifact's data: view (files only, the default), read or write. Each collection still allows at most what this version declares for visitors",
		}),
	),
})
export type CreateArtifactLinkBody = typeof CreateArtifactLinkBody.Type

export const ArtifactLinkResource = Schema.Struct({
	type: Schema.Literal("artifact_link"),
	artifact_id: Schema.String,
	version: PositiveInt,
	url: Schema.String,
	access: ArtifactAccessLevel,
	expires_at: Schema.DateTimeUtc,
})
export type ArtifactLink = typeof ArtifactLinkResource.Type

export const FileOrigin = Schema.Union([
	Schema.Struct({ type: Schema.Literal("upload") }),
	Schema.Struct({
		type: Schema.Literal("session"),
		session_id: SessionId,
		turn: PositiveInt,
		path: ArtifactPath,
	}),
]).annotate({
	description:
		"Where the file came from: an upload or a session. Session file paths are relative to the directory where they were saved.",
})

export const FileResource = Schema.Struct({
	id: FileId,
	type: Schema.Literal("file"),
	filename: FileName,
	content_type: Schema.String,
	size: NonNegativeInt.annotate({ description: "Size in bytes" }),
	sha256: Sha256Hex,
	origin: FileOrigin,
	created_at: Schema.DateTimeUtc,
})
export type File = typeof FileResource.Type

export const SessionOutputsResource = Schema.Struct({
	type: Schema.Literal("session_outputs"),
	session_id: SessionId,
	turn: NonNegativeInt.annotate({
		description: "The latest turn whose outputs were recorded, or 0 when none has been",
	}),
	status: Schema.Literals(["none", "saved", "skipped"]).annotate({
		description:
			"When saved, the listed files come from that turn. When skipped, the listed files come from the last turn that saved outputs",
	}),
	reason: Schema.NullOr(Schema.String).annotate({
		description: "Why the turn's outputs were skipped",
	}),
	files: Schema.Array(FileResource),
	skipped: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })).annotate({
		description: "Files and directories skipped while saving outputs, with a reason for each",
	}),
	recorded_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type SessionOutputs = typeof SessionOutputsResource.Type

export const FileDeleted = Schema.Struct({
	id: Schema.String,
	type: Schema.Literal("file_deleted"),
})
export type FileDeleted = typeof FileDeleted.Type

export const ArtifactDeleted = Schema.Struct({
	id: Schema.String,
	type: Schema.Literal("artifact_deleted"),
})
export type ArtifactDeleted = typeof ArtifactDeleted.Type

export const MAX_ARTIFACT_DOCUMENT_DEPTH = 32

const nestedWithin = (value: Schema.Json, limit: number): boolean => {
	let level: Array<Schema.Json> = [value]
	for (let depth = 0; level.length > 0; depth += 1) {
		if (depth > limit) {
			return false
		}
		level = level.flatMap((entry): ReadonlyArray<Schema.Json> =>
			entry === null || typeof entry !== "object" ? [] : Object.values(entry),
		)
	}
	return true
}

export const ArtifactDocumentData = Schema.Json.check(
	Schema.makeFilter(
		(data) =>
			nestedWithin(data, MAX_ARTIFACT_DOCUMENT_DEPTH) ||
			`arrays and objects nested at most ${MAX_ARTIFACT_DOCUMENT_DEPTH} deep`,
	),
)

export const ArtifactDocumentResource = Schema.Struct({
	id: ArtifactDocumentId,
	type: Schema.Literal("artifact_document"),
	artifact_id: ArtifactId,
	collection: ArtifactCollectionName,
	data: Schema.Json.annotate({ description: "The document: any JSON value" }),
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
})
export type ArtifactDocument = typeof ArtifactDocumentResource.Type

export const ArtifactDocumentBody = Schema.Struct({
	data: ArtifactDocumentData.annotate({
		description: `The document: any JSON value of at most ${MAX_ARTIFACT_DOCUMENT_BYTES} bytes once encoded, with arrays and objects nested at most ${MAX_ARTIFACT_DOCUMENT_DEPTH} deep`,
	}),
})
export type ArtifactDocumentBody = typeof ArtifactDocumentBody.Type

export const ArtifactDocumentDeleted = Schema.Struct({
	id: Schema.String,
	type: Schema.Literal("artifact_document_deleted"),
})
export type ArtifactDocumentDeleted = typeof ArtifactDocumentDeleted.Type

export const ArtifactDatabaseResource = Schema.Struct({
	type: Schema.Literal("artifact_database"),
	artifact_id: ArtifactId,
	bytes: NonNegativeInt.annotate({ description: "Encoded size of every document held" }),
	collections: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			documents: NonNegativeInt,
			bytes: NonNegativeInt,
		}),
	).annotate({ description: "Every collection that holds a document, by name" }),
})
export type ArtifactDatabase = typeof ArtifactDatabaseResource.Type

export const WebhookEventSubscriptions = Schema.Array(WebhookEventSubscription)
	.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_WEBHOOK_EVENT_TYPES))
	.annotate({
		description:
			'Subscribed event types (or ["*"] to subscribe to all events). session.status_idled is sent when a turn ends or pauses for input, including tool approval. Scheduled runs emit automation_run.started when triggered, automation_run.succeeded when they create a session, and automation_run.failed when session creation fails. Manual runs do not emit automation_run events.',
	})

export const CreateWebhookBody = Schema.Struct({
	url: WebhookUrl.annotate({
		description: "Public HTTPS destination URL that receives signed webhook POST requests",
	}),
	description: Schema.optionalKey(
		WebhookDescription.annotate({
			description: "Optional human-readable description for this webhook endpoint",
		}),
	),
	event_types: WebhookEventSubscriptions,
})
export type CreateWebhookBody = typeof CreateWebhookBody.Type

export const UpdateWebhookBody = Schema.Struct({
	url: Schema.optionalKey(
		WebhookUrl.annotate({
			description: "New public HTTPS destination URL",
		}),
	),
	description: Schema.optionalKey(
		WebhookDescription.annotate({
			description: "Updated description for this webhook endpoint",
		}),
	),
	event_types: Schema.optionalKey(WebhookEventSubscriptions),
	reactivate: Schema.optionalKey(
		Schema.Boolean.annotate({
			description: "Set to true to reactivate a paused or auto-disabled endpoint",
		}),
	),
})
export type UpdateWebhookBody = typeof UpdateWebhookBody.Type

const WebhookCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const WebhookResource = Schema.Struct({
	id: WebhookId,
	type: Schema.Literal("webhook"),
	status: WebhookEndpointStatus,
	url: Schema.String,
	description: Schema.String,
	event_types: Schema.Array(Schema.String),
	definition_revision: PositiveInt,
	secret_revision: PositiveInt,
	previous_secret_expires_at: Schema.NullOr(Schema.DateTimeUtc).annotate({
		description: "When the previous signing secret stops being sent after a rotation, or null",
	}),
	consecutive_failures: WebhookCount,
	last_failure_at: Schema.NullOr(Schema.DateTimeUtc),
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
})
export type Webhook = typeof WebhookResource.Type

export const WebhookCreatedResource = WebhookResource.mapFields((fields) => ({
	...fields,
	signing_secret: NonEmptyString.annotate({
		description:
			"Standard Webhooks signing secret (whsec_...). Shown once when the endpoint is created.",
	}),
}))
export type WebhookCreated = typeof WebhookCreatedResource.Type

export const WebhookSecretRotatedResource = WebhookResource.mapFields((fields) => ({
	...fields,
	signing_secret: NonEmptyString.annotate({
		description:
			"New Standard Webhooks signing secret (whsec_...). Shown once; the previous secret stays active for 24 hours.",
	}),
}))
export type WebhookSecretRotated = typeof WebhookSecretRotatedResource.Type

export const WebhookDeletedResource = Schema.Struct({
	id: WebhookId,
	type: Schema.Literal("webhook_deleted"),
})
export type WebhookDeleted = typeof WebhookDeletedResource.Type

export const WebhookDeliveryResource = Schema.Struct({
	id: WebhookDeliveryId,
	type: Schema.Literal("webhook_delivery"),
	webhook_id: WebhookId,
	event_id: WebhookEventId,
	event_type: Schema.String,
	status: WebhookDeliveryStatus,
	attempt_count: WebhookCount,
	max_attempts: PositiveInt,
	next_attempt_at: Schema.NullOr(Schema.DateTimeUtc),
	last_attempt_at: Schema.NullOr(Schema.DateTimeUtc),
	last_http_status: Schema.NullOr(Schema.Int),
	last_outcome: Schema.NullOr(WebhookDeliveryOutcome),
	last_error: Schema.NullOr(Schema.String),
	created_at: Schema.DateTimeUtc,
	updated_at: Schema.DateTimeUtc,
	completed_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type WebhookDelivery = typeof WebhookDeliveryResource.Type

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
	| "webhook"
	| "memory_store"
	| "memory"

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

export const PendingWebhook = Schema.Struct({
	id: WebhookId,
	type: Schema.Literal("webhook"),
	pending: Schema.Literal(true),
	signing_secret: NonEmptyString.annotate({
		description:
			"Standard Webhooks signing secret (whsec_...). Shown once while registration finishes propagating.",
	}),
}).pipe(HttpApiSchema.status(202))
export type PendingWebhook = typeof PendingWebhook.Type
export const PendingMemoryStore = pendingResource("memory_store")
export type PendingMemoryStore = typeof PendingMemoryStore.Type

export const PendingMemory = Schema.Struct({
	id: Schema.String,
	type: Schema.Literal("memory"),
	memory_store_id: Schema.String,
	pending: Schema.Literal(true),
}).pipe(HttpApiSchema.status(202))
export type PendingMemory = typeof PendingMemory.Type

export const PendingResource = Schema.Union([
	PendingAgent,
	PendingEnvironment,
	PendingSession,
	PendingAutomation,
	PendingArtifact,
	PendingArtifactVersion,
	PendingVault,
	PendingCredential,
	PendingWebhook,
	PendingMemoryStore,
	PendingMemory,
])

export type PendingResource = typeof PendingResource.Type

export const isPendingResource = <T extends { readonly type: string }>(
	value: T | PendingResource,
): value is Extract<T | PendingResource, { readonly pending: true }> =>
	"pending" in value && value.pending === true

export const UserMessageEventReceipt = Schema.Struct({
	type: Schema.Literal("user.message"),
	id: Schema.String,
	processed_at: Schema.NullOr(Schema.DateTimeUtc),
	turn: PositiveInt,
	queued: Schema.Boolean,
	content: TextBlocks,
})
export type UserMessageEventReceipt = typeof UserMessageEventReceipt.Type

export const UserInterruptEventReceipt = Schema.Struct({
	type: Schema.Literal("user.interrupt"),
	id: Schema.String,
	processed_at: Schema.NullOr(Schema.DateTimeUtc),
})
export type UserInterruptEventReceipt = typeof UserInterruptEventReceipt.Type

export const UserToolConfirmationEventReceipt = Schema.Struct({
	type: Schema.Literal("user.tool_confirmation"),
	id: Schema.String,
	processed_at: Schema.NullOr(Schema.DateTimeUtc),
	tool_use_id: ToolUseEventId,
	result: ToolConfirmationResult,
	deny_message: Schema.optionalKey(DenyMessage),
})
export type UserToolConfirmationEventReceipt = typeof UserToolConfirmationEventReceipt.Type

export const UserCustomToolResultEventReceipt = Schema.Struct({
	type: Schema.Literal("user.custom_tool_result"),
	id: Schema.String,
	processed_at: Schema.NullOr(Schema.DateTimeUtc),
	custom_tool_use_id: ToolUseEventId,
	content: Schema.optionalKey(TextBlocks),
	is_error: Schema.optionalKey(Schema.Boolean),
})
export type UserCustomToolResultEventReceipt = typeof UserCustomToolResultEventReceipt.Type

export const SystemMessageEventReceipt = Schema.Struct({
	type: Schema.Literal("system.message"),
	id: Schema.String,
	processed_at: Schema.DateTimeUtc,
	content: TextBlocks,
})

export const SendSessionEventReceipt = Schema.Union([
	SystemMessageEventReceipt,
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
		processed_at: Schema.NullOr(Schema.DateTimeUtc),
		...fields,
	})

export const SystemMessageSessionEvent = wireSessionEvent(
	"system.message",
	SessionEventFields["system.message"],
).annotate({ description: "Privileged context appended to the session's system instructions." })

export const UserMessageSessionEvent = wireSessionEvent(
	"user.message",
	SessionEventFields["user.message"],
).annotate({ description: "A user message in the session conversation, with text content blocks." })
export const UserInterruptSessionEvent = wireSessionEvent(
	"user.interrupt",
	SessionEventFields["user.interrupt"],
).annotate({ description: "An interrupt that stops the agent's current turn." })
export const UserToolConfirmationSessionEvent = wireSessionEvent("user.tool_confirmation", {
	...SessionEventFields["user.tool_confirmation"],
	tool_use_id: ToolUseEventId,
})
export const UserCustomToolResultSessionEvent = wireSessionEvent("user.custom_tool_result", {
	...SessionEventFields["user.custom_tool_result"],
	custom_tool_use_id: ToolUseEventId,
})
export const AgentCustomToolUseSessionEvent = wireSessionEvent("agent.custom_tool_use", {
	...SessionEventFields["agent.custom_tool_use"],
	tool_use_id: ToolUseEventId,
})
export const SessionStatusRunningEvent = wireSessionEvent(
	"session.status_running",
	SessionEventFields["session.status_running"],
).annotate({ description: "The agent is processing a turn." })
export const SpanModelRequestStartEvent = wireSessionEvent(
	"span.model_request_start",
	SessionEventFields["span.model_request_start"],
).annotate({ description: "A model request started." })
const TOOL_CALL_RECORD =
	"A turn's calls come before its end event, whether the turn replied, failed or was interrupted."
export const AgentToolUseSessionEvent = wireSessionEvent("agent.tool_use", {
	...SessionEventFields["agent.tool_use"],
	tool_use_id: ToolUseEventId,
}).annotate({ description: `The agent called a tool. ${TOOL_CALL_RECORD}` })
export const AgentToolResultSessionEvent = wireSessionEvent("agent.tool_result", {
	...SessionEventFields["agent.tool_result"],
	tool_use_id: ToolUseEventId,
}).annotate({
	description: `The result of a tool call, including why the call was rejected when applicable. ${TOOL_CALL_RECORD}`,
})
export const AgentMcpToolUseSessionEvent = wireSessionEvent("agent.mcp_tool_use", {
	...SessionEventFields["agent.mcp_tool_use"],
	tool_use_id: ToolUseEventId,
}).annotate({ description: `Records an MCP call the model made. ${TOOL_CALL_RECORD}` })
export const AgentMcpToolResultSessionEvent = wireSessionEvent("agent.mcp_tool_result", {
	...SessionEventFields["agent.mcp_tool_result"],
	tool_use_id: ToolUseEventId,
}).annotate({
	description: `Records what an MCP call the model made returned, or, with rejected, why it did not run. ${TOOL_CALL_RECORD}`,
})
export const AgentThinkingSessionEvent = wireSessionEvent(
	"agent.thinking",
	SessionEventFields["agent.thinking"],
).annotate({ description: "The agent is thinking." })
export const AgentMessageSessionEvent = wireSessionEvent(
	"agent.message",
	SessionEventFields["agent.message"],
).annotate({ description: "The agent's response, with text content blocks." })
export const SpanModelRequestEndEvent = wireSessionEvent(
	"span.model_request_end",
	SessionEventFields["span.model_request_end"],
).annotate({ description: "A model request finished. Includes token usage in model_usage." })
export const SessionStatusIdleEvent = wireSessionEvent("session.status_idle", {
	...SessionEventFields["session.status_idle"],
	stop_reason: Schema.Union([StopReason, RequiresActionStopReason]),
	cancelled_event_ids: Schema.optionalKey(CancelledEventIds),
}).annotate({
	description: "The agent stopped processing a turn. See stop_reason for why it stopped.",
})
export const SessionErrorSessionEvent = wireSessionEvent(
	"session.error",
	SessionEventFields["session.error"],
).annotate({
	description:
		"An error occurred while processing a turn. Includes the error and its retry status.",
})
export const SessionStatusTerminatedEvent = wireSessionEvent("session.status_terminated", {
	...SessionEventFields["session.status_terminated"],
	cancelled_event_ids: Schema.optionalKey(CancelledEventIds),
})
export const SessionArchivedEvent = wireSessionEvent(
	"session.archived",
	SessionEventFields["session.archived"],
)

export const SessionEvent = Schema.Union([
	SystemMessageSessionEvent,
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

const SessionPreviewType = Schema.Literals(["agent.message", "agent.thinking"])
export type SessionPreviewType = typeof SessionPreviewType.Type

export const SessionEventPreview = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("event_start"),
		event: Schema.Struct({ id: Schema.String, type: SessionPreviewType }),
	}),
	Schema.Struct({
		type: Schema.Literal("event_delta"),
		event_id: Schema.String,
		delta: Schema.Struct({
			type: Schema.Literal("content_delta"),
			index: NonNegativeInt,
			content: Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
		}),
	}),
]).annotate({ identifier: "SessionEventPreview" })
export type SessionEventPreview = typeof SessionEventPreview.Type

export const SessionStreamEvent = Schema.Union([SessionEvent, SessionEventPreview])
export type SessionStreamEvent = typeof SessionStreamEvent.Type

const SessionPreviewTypes = Schema.Array(SessionPreviewType)
	.check(Schema.isMaxLength(100))
	.annotate({ description: "Event types to preview on this connection." })

const listResponse = <A extends Schema.Top>(resource: A) =>
	Schema.Struct({
		data: Schema.Array(resource),
		next_page: Schema.NullOr(Schema.String).annotate({
			description: "Token for the next page, or null when there are no more results.",
		}),
	})

export const ListSessionEventsResponse = listResponse(SessionEvent)
export type ListSessionEventsResponse = typeof ListSessionEventsResponse.Type

export const ListAutomationRunsResponse = listResponse(AutomationRunResource)
export type ListAutomationRunsResponse = typeof ListAutomationRunsResponse.Type

const AgentVersionPage = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(512),
).annotate({ description: "Opaque cursor returned by the previous page." })

export const ListAgentVersionsResponse = Schema.Struct({
	data: Schema.Array(AgentResource),
	next_page: Schema.NullOr(AgentVersionPage),
})

export const ListAgentsResponse = listResponse(AgentResource)
export type ListAgentsResponse = typeof ListAgentsResponse.Type

export const ListEnvironmentsResponse = listResponse(EnvironmentSnapshot)
export const ListMemoryStoresResponse = listResponse(MemoryStoreSnapshot)
export type ListEnvironmentsResponse = typeof ListEnvironmentsResponse.Type

export const ListSessionsResponse = listResponse(SessionResource)
export type ListSessionsResponse = typeof ListSessionsResponse.Type

export const ListFilesResponse = listResponse(FileResource)
export type ListFilesResponse = typeof ListFilesResponse.Type

export const ListArtifactsResponse = listResponse(ArtifactSummaryResource)
export type ListArtifactsResponse = typeof ListArtifactsResponse.Type

export const ListVaultsResponse = listResponse(VaultResource)
export type ListVaultsResponse = typeof ListVaultsResponse.Type

export const ListCredentialsResponse = listResponse(CredentialResource)
export type ListCredentialsResponse = typeof ListCredentialsResponse.Type

export const ListAutomationsResponse = listResponse(AutomationResource)
export type ListAutomationsResponse = typeof ListAutomationsResponse.Type

export const ListWebhooksResponse = listResponse(WebhookResource)
export type ListWebhooksResponse = typeof ListWebhooksResponse.Type

export const ListWebhookDeliveriesResponse = listResponse(WebhookDeliveryResource)
export type ListWebhookDeliveriesResponse = typeof ListWebhookDeliveriesResponse.Type

export const CursorFromString = Schema.String.check(Schema.isPattern(/^\d{1,15}$/u)).pipe(
	Schema.decodeTo(
		Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 999_999_999_999_999 })),
		{
			decode: SchemaGetter.transform(Number),
			encode: SchemaGetter.transform(String),
		},
	),
)

const EventListPage = Schema.String.check(Schema.isPattern(/^\d{1,15}$/u)).annotate({
	description: "Opaque pagination cursor from the previous response's next_page.",
})

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

const positiveIntegerFromString = (description: string) =>
	Schema.String.check(Schema.isPattern(/^[1-9]\d{0,14}$/u))
		.annotate({ description })
		.pipe(
			Schema.decodeTo(
				Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999_999_999 })),
				{
					decode: SchemaGetter.transform(Number),
					encode: SchemaGetter.transform(String),
				},
			),
		)

const RunNumberFromString = positiveIntegerFromString("Run number as a positive integer")
const AgentVersionFromString = positiveIntegerFromString(
	"Agent version. Omit to retrieve the latest version.",
)

const ArchiveVersionFromString = positiveIntegerFromString(
	"Expected version. The archive is refused if the resource changed or a live automation uses it.",
)
const ArchiveRevisionFromString = positiveIntegerFromString(
	"Expected revision. The archive is refused if the automation changed.",
)

const resourceListQuery = {
	page: Schema.optionalKey(ResourceListCursor),
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
const artifactCollectionParams = {
	...artifactParams,
	collection: ArtifactCollectionName.annotate({ description: "Collection name" }),
}
const artifactDocumentParams = {
	...artifactCollectionParams,
	document_id: ArtifactDocumentId.annotate({ description: "Document ID" }),
}
const memoryStoreParams = {
	memory_store_id: MemoryStoreId.annotate({ description: "Memory store ID" }),
}
const memoryParams = {
	...memoryStoreParams,
	memory_id: MemoryId.annotate({ description: "Memory ID" }),
}
const vaultParams = { vault_id: VaultId.annotate({ description: "Vault ID" }) }
const credentialParams = {
	...vaultParams,
	credential_id: CredentialId.annotate({ description: "Credential ID" }),
}
const webhookParams = { webhook_id: WebhookId.annotate({ description: "Webhook ID" }) }
const webhookDeliveryParams = {
	...webhookParams,
	delivery_id: WebhookDeliveryId.annotate({ description: "Webhook delivery ID" }),
}
const webhookDeliveryListQuery = {
	page: Schema.optionalKey(ResourceListCursor),
	limit: Schema.optionalKey(ListLimitFromString),
}
const sessionResourceParams = {
	...sessionParams,
	resource_id: SessionResourceId.annotate({ description: "Session resource ID" }),
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
			.annotate(
				OpenApi.Description,
				"Create a reusable agent configuration with a model and an optional system prompt.",
			)
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
			query: {
				version: Schema.optionalKey(AgentVersionFromString),
			},
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
				"x-checkfu-cli": { intQueryParams: { version: { min: 1, metavar: "N" } } },
			}),
	)
	.add(
		HttpApiEndpoint.get("listVersions", "/v1/agents/:agent_id/versions", {
			params: agentParams,
			query: {
				page: Schema.optionalKey(AgentVersionPage),
				limit: Schema.optionalKey(ListLimitFromString),
			},
			success: ListAgentVersionsResponse,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List agent versions")
			.annotate(OpenApi.Description, "List the published versions of an agent, newest first.")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "agents.versions",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "agents", endpoint: "listVersions" },
				"x-checkfu-mcp": { name: "agents_listVersions" },
				"x-checkfu-cli": { intQueryParams: { limit: { min: 1, max: 100, metavar: "N" } } },
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
			.annotate(
				OpenApi.Description,
				"Update an agent's configuration. Changes create a new version for future sessions.",
			)
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
			query: { version: Schema.optionalKey(ArchiveVersionFromString) },
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
				"x-checkfu-cli": {
					intQueryParams: { version: { min: 1, metavar: "N" } },
					versionFlag: "current-version",
				},
			}),
	)
	.annotate(OpenApi.Description, "Create and manage versioned agent configurations")
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
			.annotate(
				OpenApi.Description,
				"Create an environment that configures the cloud sandbox where sessions run.",
			)
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
			.annotate(
				OpenApi.Description,
				"Update an environment. A session already running picks up the new configuration, network rules included, when its next turn starts.",
			)
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
			query: { version: Schema.optionalKey(ArchiveVersionFromString) },
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
				"x-checkfu-cli": {
					intQueryParams: { version: { min: 1, metavar: "N" } },
					versionFlag: "current-version",
				},
			}),
	)
	.annotate(OpenApi.Description, "Create and manage environments where agents run")
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
			.annotate(
				OpenApi.Description,
				`Create an agent instance in an environment. Include initial user messages to start work immediately. The whole request body can contain up to ${MAX_SESSION_BODY_BYTES} UTF-8 bytes.`,
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "sessions",
				"x-forge-method-name": "create",
				"x-checkfu-endpoint": { group: "sessions", endpoint: "create" },
				"x-checkfu-mcp": { name: "sessions_createSession", destructive: false },
				"x-checkfu-cli": {
					textOrObjectFields: ["agent"],
					repeatArrayField: {
						field: "initial_events",
						flag: "initial-event",
						description: `Initial user message as JSON, YAML, or @file (up to ${MAX_SESSION_INITIAL_EVENTS} messages and ${MAX_SESSION_INITIAL_MESSAGES_BYTES} encoded bytes total)`,
					},
					examples: [
						{
							command: "checkfu sessions create --agent agent_123 --environment-id env_456",
							description: "Create a session using the latest agent version",
						},
					],
				},
			})
			.middleware(SessionBodyLimit),
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
			.annotate(
				OpenApi.Description,
				`Send events to start, resume, follow up, or interrupt. Send up to ${MAX_SESSION_EVENTS_PER_BATCH} events and ${MAX_EVENTS_BODY_BYTES} UTF-8 JSON bytes. Each user message allows up to ${MAX_MESSAGE_TEXT_LENGTH} UTF-16 code units after joining blocks with newlines.`,
			)
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
						description: `Event payload as JSON, YAML, or @file (repeatable, up to ${MAX_SESSION_EVENTS_PER_BATCH})`,
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
				page: Schema.optionalKey(EventListPage),
				limit: Schema.optionalKey(EventListLimitFromString),
				types: Schema.optionalKey(
					Schema.Array(
						Schema.Literals(SessionEvent.members.map((event) => event.fields.type.literal)),
					).annotate({
						description: "Return events with one of these types.",
					}),
				),
				order: Schema.optionalKey(
					Schema.Literals(["asc", "desc"]).annotate({ description: "Sort order: asc or desc" }),
				),
			},
			success: ListSessionEventsResponse,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List session events")
			.annotate(
				OpenApi.Description,
				"List persisted events for a session. Use next_page to continue through its history.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "sessions.events",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "sessions", endpoint: "listEvents" },
				"x-checkfu-mcp": { name: "sessions_listEvents" },
				"x-checkfu-cli": {
					repeatArrayField: { field: "types", flag: "type" },
					intQueryParams: {
						limit: { min: 1, max: 100, metavar: "N" },
					},
				},
			}),
	)
	.add(
		HttpApiEndpoint.get("streamEvents", "/v1/sessions/:session_id/events/stream", {
			params: sessionParams,
			query: {
				"event_deltas[]": Schema.optionalKey(SessionPreviewTypes),
				after: Schema.optionalKey(
					Schema.String.annotate({
						description: "Resume stream strictly after this sequence number",
					}),
				),
			},
			success: [HttpApiSchema.StreamSse({ data: SessionStreamEvent }), HttpApiSchema.NoContent],
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Stream session events")
			.annotate(
				OpenApi.Description,
				"Follow a session's event stream over server-sent events (SSE). Pass after to resume from a sequence number.",
			)
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
			success: SessionOutputsResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve a session's outputs")
			.annotate(
				OpenApi.Description,
				"Retrieve the files a session left in its outputs directory, as of the latest turn that recorded them. Download each saved file on its own. After every reply the directory is saved file by file. The skipped list gives a reason for each skipped file or directory",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "sessions.outputs",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "sessions", endpoint: "getOutputs" },
				"x-checkfu-mcp": { name: "sessions_getOutputs" },
				"x-checkfu-cli": {
					groupDescription: "Retrieve the files a session saved from its outputs directory",
				},
			}),
	)
	.add(
		HttpApiEndpoint.get("listResources", "/v1/sessions/:session_id/resources", {
			params: sessionParams,
			success: Schema.Struct({ data: Schema.Array(SessionResourceItem) }),
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List session resources")
			.annotate(OpenApi.Description, "List what is mounted in a session's workspace")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "sessions.resources",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "sessions", endpoint: "listResources" },
				"x-checkfu-mcp": { name: "sessions_listResources" },
				"x-checkfu-cli": {
					groupDescription: "List session resources and rotate their credentials",
				},
			}),
	)
	.add(
		HttpApiEndpoint.get("getResource", "/v1/sessions/:session_id/resources/:resource_id", {
			params: sessionResourceParams,
			success: SessionResourceItem,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve a session resource")
			.annotate(OpenApi.Description, "Retrieve one resource mounted in a session's workspace")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "sessions.resources",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "sessions", endpoint: "getResource" },
				"x-checkfu-mcp": { name: "sessions_getResource" },
			}),
	)
	.add(
		HttpApiEndpoint.post("updateResource", "/v1/sessions/:session_id/resources/:resource_id", {
			params: sessionResourceParams,
			payload: UpdateSessionResourceBody,
			success: SessionResourceItem,
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Rotate a repository's token")
			.annotate(
				OpenApi.Description,
				"Replace the GitHub token a mounted repository clones and pushes with",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "sessions.resources",
				"x-forge-method-name": "update",
				"x-checkfu-endpoint": { group: "sessions", endpoint: "updateResource" },
				"x-checkfu-mcp": false,
			}),
	)
	.annotate(OpenApi.Description, "Run agents in sessions and follow their events")
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
				"Create an automation that runs an agent on a cron schedule. Each run starts a new session in the configured environment and sends the initial events.",
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
						description:
							"The initial user.message event sent to each session, as JSON, YAML, or @file",
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
				"Pause scheduled runs. You can still run the automation manually, and sessions from earlier runs continue.",
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
			query: { revision: Schema.optionalKey(ArchiveRevisionFromString) },
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
				"x-checkfu-cli": { intQueryParams: { revision: { min: 1, metavar: "N" } } },
			}),
	)
	.add(
		HttpApiEndpoint.post("run", "/v1/automations/:automation_id/run", {
			params: automationParams,
			headers: IdempotencyHeaders,
			success: AutomationRunQueued,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Run an automation now")
			.annotate(
				OpenApi.Description,
				"Trigger a run, including while paused. Check the result by the queued run ID. If the run starts, it uses the returned session ID. Retrying with the same Idempotency-Key returns the same run.",
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
				page: Schema.optionalKey(EventListPage),
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
				"Get a run by number. Returns 404 immediately until its result appears.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "automations.runs",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "automations", endpoint: "getRun" },
				"x-checkfu-mcp": { name: "automations_getRun" },
			}),
	)
	.add(
		HttpApiEndpoint.get("getRunById", "/v1/automation_runs/:automation_run_id", {
			params: { automation_run_id: ResourceId },
			success: AutomationRunResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve an automation run by ID")
			.annotate(
				OpenApi.Description,
				"Get a run by ID. Returns 404 if unknown or unissued, or retryable 503 if no result appears after a brief wait.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "automationRuns",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "automations", endpoint: "getRunById" },
				"x-checkfu-mcp": { name: "automationRuns_retrieve" },
			}),
	)
	.annotate(OpenApi.Description, "Run agents on a schedule and inspect their runs")
	.middleware(Authentication)

const fileParams = { file_id: FileId.annotate({ description: "File ID" }) }

const Files = HttpApiGroup.make("files")
	.add(
		HttpApiEndpoint.post("upload", "/v1/files", {
			headers: IdempotencyHeaders,
			query: {
				filename: FileName.annotate({
					description: "Name of the file, for example report.pdf; one name, not a path",
				}),
				content_type: Schema.optionalKey(
					ArtifactContentType.annotate({
						description: "Media type; inferred from the filename extension when omitted",
					}),
				),
			},
			payload: Schema.Uint8Array.pipe(
				HttpApiSchema.asUint8Array({ contentType: "application/octet-stream" }),
			),
			success: FileResource.pipe(HttpApiSchema.status(201)),
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Upload a file")
			.annotate(OpenApi.Transform, (operation) => {
				const parameters: ReadonlyArray<unknown> = Array.isArray(operation.parameters)
					? operation.parameters
					: []
				return {
					...operation,
					parameters: [
						...parameters,
						{
							name: "Content-Length",
							in: "header",
							required: true,
							description:
								"Exact byte length of the raw request body. Clients using a fixed-size body can let their HTTP transport set this header.",
							schema: { type: "integer", minimum: 0, maximum: MAX_FILE_BYTES },
						},
					],
				}
			})
			.annotate(
				OpenApi.Description,
				`Upload one file as the raw request body, with a Content-Length header. A file never changes after it is uploaded; to change its content, upload another. At most ${MAX_FILE_BYTES / 1024 / 1024} MiB.`,
			)
			.annotate(OpenApi.Override, {
				"x-forge-skip": true,
				"x-checkfu-endpoint": { group: "files", endpoint: "upload" },
			})
			.middleware(FileBodyLimit),
	)
	.add(
		HttpApiEndpoint.get("list", "/v1/files", {
			query: artifactListQuery,
			success: ListFilesResponse,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List files")
			.annotate(
				OpenApi.Description,
				"List files in creation order, oldest first by default. Deleted files never appear.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "files",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "files", endpoint: "list" },
				"x-checkfu-mcp": { name: "files_listFiles" },
				"x-checkfu-cli": resourceListCli,
			}),
	)
	.add(
		HttpApiEndpoint.get("get", "/v1/files/:file_id", {
			params: fileParams,
			success: FileResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve a file")
			.annotate(OpenApi.Description, "Retrieve a file's name, type, size and sha256")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "files",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "files", endpoint: "get" },
				"x-checkfu-mcp": { name: "files_getFile" },
			}),
	)
	.add(
		HttpApiEndpoint.get("content", "/v1/files/:file_id/content", {
			params: fileParams,
			success: HttpApiSchema.StreamUint8Array(),
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Download a file")
			.annotate(
				OpenApi.Description,
				"Download a file's bytes with its content type. A single HTTP byte range returns 206. A range outside the file returns 416. A matching If-None-Match returns 304.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-skip": true,
				"x-checkfu-endpoint": { group: "files", endpoint: "content" },
			}),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/v1/files/:file_id", {
			params: fileParams,
			success: FileDeleted,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Delete a file")
			.annotate(OpenApi.Description, "Delete a file and its bytes. This cannot be undone.")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "files",
				"x-forge-method-name": "delete",
				"x-checkfu-endpoint": { group: "files", endpoint: "delete" },
				"x-checkfu-mcp": { name: "files_deleteFile" },
			}),
	)
	.annotate(OpenApi.Description, "Upload files to give to agents, and download files they produce")
	.middleware(Authentication)

const ARTIFACT_UPLOAD_LIMIT = `A version holds at most ${MAX_ARTIFACT_FILES} files, ${MAX_ARTIFACT_FILE_BYTES / 1024 / 1024} MiB each and ${MAX_ARTIFACT_TOTAL_BYTES / 1024 / 1024} MiB in total. Content sent inline in JSON is at most ${MAX_INLINE_FILE_BYTES / 1024 / 1024} MiB per file and ${MAX_INLINE_TOTAL_BYTES / 1024 / 1024} MiB per request, in a body of at most ${MAX_ARTIFACT_BODY_BYTES} bytes; upload a larger file with POST /v1/files and name it by its id.`

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
				`Create an artifact from a set of files (version 1). An Idempotency-Key retries the same request, including the source version and file descriptors when supplied. ${ARTIFACT_UPLOAD_LIMIT}`,
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
							"File as JSON, YAML, or @file: path with content (and optional encoding), or path with file_id; content_type is optional (repeatable)",
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
			.annotate(
				OpenApi.Description,
				"Permanently delete an artifact, all versions of its files, and all documents in its database. Its public address and viewing links stop working.",
			)
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
				`Add a new immutable version to an artifact. If the artifact is still on the version the request added, resending the same request returns that version. ${ARTIFACT_UPLOAD_LIMIT}`,
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
							"File as JSON, YAML, or @file: path with content (and optional encoding), path with file_id, or path with the sha256 of a file to keep from the version being replaced; content_type is optional (repeatable)",
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
								"checkfu artifacts:versions link --artifact-id art_123 --at-version 1 --expires-in 600",
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
					versionFlag: "at-version",
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
			query: {
				if_current: Schema.optionalKey(
					PublicationAddress.annotate({ description: "The public address to revoke" }),
				),
			},
			headers: IdempotencyHeaders,
			success: ArtifactResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Unpublish an artifact")
			.annotate(
				OpenApi.Description,
				"Take down an artifact's public address and keep the artifact. Supply if_current to revoke a specific address. The request returns 409 if that address is no longer current. Retrying the same request with the same Idempotency-Key preserves any later publication.",
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

const ArtifactData = HttpApiGroup.make("artifact_data")
	.add(
		HttpApiEndpoint.get("getDatabase", "/v1/artifacts/:artifact_id/data", {
			params: artifactParams,
			success: ArtifactDatabaseResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Describe an artifact's database")
			.annotate(
				OpenApi.Description,
				`List the collections an artifact's database holds, with how many documents and bytes are in each. A database holds up to ${MAX_ARTIFACT_COLLECTIONS} collections and ${MAX_ARTIFACT_DATABASE_BYTES} bytes of documents`,
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "artifacts.data",
				"x-forge-method-name": "describe",
				"x-checkfu-endpoint": { group: "artifact_data", endpoint: "getDatabase" },
				"x-checkfu-mcp": { name: "artifacts_getDatabase" },
				"x-checkfu-cli": {
					groupDescription: "Read and write the documents in an artifact's database",
				},
			}),
	)
	.add(
		HttpApiEndpoint.get("listDocuments", "/v1/artifacts/:artifact_id/data/:collection", {
			params: artifactCollectionParams,
			query: {
				page: Schema.optionalKey(EventListPage),
				limit: Schema.optionalKey(ListLimitFromString),
			},
			success: listResponse(ArtifactDocumentResource),
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List documents")
			.annotate(
				OpenApi.Description,
				"List documents oldest first. Pages hold up to 512 KiB of document bodies and can contain fewer than the requested limit. Continue until next_page is null.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "artifacts.data",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "artifact_data", endpoint: "listDocuments" },
				"x-checkfu-mcp": { name: "artifacts_listDocuments" },
				"x-checkfu-cli": resourceListCli,
			}),
	)
	.add(
		HttpApiEndpoint.post("addDocument", "/v1/artifacts/:artifact_id/data/:collection", {
			params: artifactCollectionParams,
			headers: IdempotencyHeaders,
			payload: ArtifactDocumentBody,
			success: ArtifactDocumentResource.pipe(HttpApiSchema.status(201)),
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Add a document")
			.annotate(
				OpenApi.Description,
				`Add a document to a collection under a new id. A collection holds up to ${MAX_ARTIFACT_COLLECTION_DOCUMENTS} documents. While the added document exists, a matching retry with the same Idempotency-Key returns the same document ID and its current contents. Retries compare JSON values with object member order ignored and array order preserved. Reusing the key with a different JSON value answers 409.`,
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "artifacts.data",
				"x-forge-method-name": "add",
				"x-checkfu-endpoint": { group: "artifact_data", endpoint: "addDocument" },
				"x-checkfu-mcp": { name: "artifacts_addDocument", destructive: false },
			}),
	)
	.add(
		HttpApiEndpoint.get("getDocument", "/v1/artifacts/:artifact_id/data/:collection/:document_id", {
			params: artifactDocumentParams,
			success: ArtifactDocumentResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve a document")
			.annotate(OpenApi.Description, "Retrieve one document from a collection")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "artifacts.data",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "artifact_data", endpoint: "getDocument" },
				"x-checkfu-mcp": { name: "artifacts_getDocument" },
			}),
	)
	.add(
		HttpApiEndpoint.put("putDocument", "/v1/artifacts/:artifact_id/data/:collection/:document_id", {
			params: artifactDocumentParams,
			payload: ArtifactDocumentBody,
			success: ArtifactDocumentResource,
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Put a document")
			.annotate(
				OpenApi.Description,
				"Store a document under an id you choose, replacing the document already there",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "artifacts.data",
				"x-forge-method-name": "put",
				"x-checkfu-endpoint": { group: "artifact_data", endpoint: "putDocument" },
				"x-checkfu-mcp": { name: "artifacts_putDocument" },
			}),
	)
	.add(
		HttpApiEndpoint.delete(
			"deleteDocument",
			"/v1/artifacts/:artifact_id/data/:collection/:document_id",
			{
				params: artifactDocumentParams,
				success: ArtifactDocumentDeleted,
				error: HandlerErrors,
			},
		)
			.annotate(OpenApi.Summary, "Delete a document")
			.annotate(OpenApi.Description, "Remove one document from a collection")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "artifacts.data",
				"x-forge-method-name": "delete",
				"x-checkfu-endpoint": { group: "artifact_data", endpoint: "deleteDocument" },
				"x-checkfu-mcp": { name: "artifacts_deleteDocument" },
			}),
	)
	.annotate(OpenApi.Description, "Manage the documents in an artifact's database")
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
			success: [VaultDeletedErased, VaultDeletedErasing],
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Delete a vault")
			.annotate(
				OpenApi.Description,
				"Delete a vault and its credentials. A 200 (secrets: erased) means the vault's storage confirmed every secret gone. A 202 (secrets: erasing) means the delete is recorded but that confirmation is still to come; erasure continues in the background. Sessions cannot start new MCP requests using a revoked credential after the change is recorded. custody.erasing counts the credentials whose records have not caught up yet. Sending the delete again returns the current state.",
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
				"Archive a vault and its credentials. A 200 means the vault's storage confirmed every secret gone; custody.erasing counts the credentials whose records have not caught up yet. A 202 receipt means the archive is recorded but that confirmation is still to come; erasure continues in the background. Sessions cannot start new MCP requests using a revoked credential after the change is recorded. Resend the archive to check for a 200 confirmation. Reading the vault shows the archived_at timestamp and outstanding credential records.",
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
			success: [CredentialDeletedErased, CredentialDeletedErasing],
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Delete a credential")
			.annotate(
				OpenApi.Description,
				"Delete a credential. A 200 (custody: erased) means storage confirmed its secret gone. A 202 (custody: erasing) means the delete is recorded but that confirmation is still to come; erasure continues in the background. Sessions cannot start new MCP requests using a revoked credential after the change is recorded. Sending the delete again returns the current state.",
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
				"Archive a credential. A 200 means storage confirmed its secret gone (custody: erased). A 202 receipt means the archive is recorded but that confirmation is still to come; erasure continues in the background. Sessions cannot start new MCP requests using a revoked credential after the change is recorded. Read the credential again until archived_at is set and custody is erased.",
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

const MemoryStores = HttpApiGroup.make("memory_stores")
	.add(
		HttpApiEndpoint.post("create", "/v1/memory_stores", {
			headers: IdempotencyHeaders,
			payload: CreateMemoryStoreBody,
			success: [MemoryStoreSnapshot.pipe(HttpApiSchema.status(201)), PendingMemoryStore],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Create a memory store")
			.annotate(OpenApi.Description, "Create a store of memories that sessions can share")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "memoryStores",
				"x-forge-method-name": "create",
				"x-checkfu-endpoint": { group: "memory_stores", endpoint: "create" },
				"x-checkfu-mcp": { name: "memoryStores_createMemoryStore", destructive: false },
				"x-checkfu-cli": {
					fileFields: ["description"],
					examples: [
						{
							command:
								'checkfu memory-stores create --name "User Preferences" --description "Per-user preferences"',
							description: "Create a memory store",
						},
					],
				},
			}),
	)
	.add(
		HttpApiEndpoint.get("list", "/v1/memory_stores", {
			query: {
				page: Schema.optionalKey(
					ResourceListCursor.annotate({
						description: "Opaque page token from the previous response's next_page.",
					}),
				),
				limit: resourceListQuery.limit,
				order: resourceListQuery.order,
				include_archived: resourceListQuery.include_archived,
			},
			success: ListMemoryStoresResponse,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List memory stores")
			.annotate(
				OpenApi.Description,
				"List memory stores in creation order, oldest first by default. Archived stores are left out unless include_archived is true; deleted ones never appear.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "memoryStores",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "memory_stores", endpoint: "list" },
				"x-checkfu-mcp": { name: "memoryStores_listMemoryStores" },
				"x-checkfu-cli": resourceListCli,
			}),
	)
	.add(
		HttpApiEndpoint.get("get", "/v1/memory_stores/:memory_store_id", {
			params: memoryStoreParams,
			success: MemoryStoreSnapshot,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve a memory store")
			.annotate(OpenApi.Description, "Retrieve a memory store by ID")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "memoryStores",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "memory_stores", endpoint: "get" },
				"x-checkfu-mcp": { name: "memoryStores_getMemoryStore" },
			}),
	)
	.add(
		HttpApiEndpoint.post("update", "/v1/memory_stores/:memory_store_id", {
			params: memoryStoreParams,
			payload: UpdateMemoryStoreBody,
			success: [MemoryStoreSnapshot, PendingMemoryStore],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Update a memory store")
			.annotate(OpenApi.Description, "Rename a memory store or change its description")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "memoryStores",
				"x-forge-method-name": "update",
				"x-checkfu-endpoint": { group: "memory_stores", endpoint: "update" },
				"x-checkfu-mcp": { name: "memoryStores_updateMemoryStore" },
				"x-checkfu-cli": { fileFields: ["description"] },
			}),
	)
	.add(
		HttpApiEndpoint.post("archive", "/v1/memory_stores/:memory_store_id/archive", {
			params: memoryStoreParams,
			success: [MemoryStoreSnapshot, PendingMemoryStore],
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Archive a memory store")
			.annotate(
				OpenApi.Description,
				"Make a memory store read-only and stop new sessions from attaching it",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "memoryStores",
				"x-forge-method-name": "archive",
				"x-checkfu-endpoint": { group: "memory_stores", endpoint: "archive" },
				"x-checkfu-idempotent": true,
				"x-checkfu-mcp": { name: "memoryStores_archiveMemoryStore" },
			}),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/v1/memory_stores/:memory_store_id", {
			params: memoryStoreParams,
			success: Schema.Struct({ id: Schema.String, type: Schema.Literal("memory_store_deleted") }),
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Delete a memory store")
			.annotate(OpenApi.Description, "Delete a memory store and make its memories unreachable")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "memoryStores",
				"x-forge-method-name": "delete",
				"x-checkfu-endpoint": { group: "memory_stores", endpoint: "delete" },
				"x-checkfu-mcp": { name: "memoryStores_deleteMemoryStore" },
			}),
	)
	.add(
		HttpApiEndpoint.post("createMemory", "/v1/memory_stores/:memory_store_id/memories", {
			params: memoryStoreParams,
			payload: CreateMemoryBody,
			success: [MemorySnapshot.pipe(HttpApiSchema.status(201)), PendingMemory],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Create a memory")
			.annotate(
				OpenApi.Description,
				"Create a memory at a path. Repeating the same content returns the existing memory. If the path holds different content, the request returns 409.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "memoryStores.memories",
				"x-forge-method-name": "create",
				"x-checkfu-endpoint": { group: "memory_stores", endpoint: "createMemory" },
				"x-checkfu-mcp": { name: "memoryStores_createMemory", destructive: false },
				"x-checkfu-cli": {
					groupDescription: "Read and edit the memories in a store",
					fileFields: ["content"],
				},
			})
			.middleware(MemoryBodyLimit),
	)
	.add(
		HttpApiEndpoint.get("listMemories", "/v1/memory_stores/:memory_store_id/memories", {
			params: memoryStoreParams,
			query: {
				path_prefix: Schema.optionalKey(
					Schema.String.check(Schema.isStartingWith("/"), Schema.isEndingWith("/")).annotate({
						description: "List only memories under this directory. Must start and end with /",
					}),
				),
				depth: Schema.optionalKey(
					Schema.Literals(["0", "1"]).annotate({
						description: "1 lists only the directory's own memories; 0 lists the whole subtree",
					}),
				),
			},
			success: Schema.Struct({ data: Schema.Array(MemoryListItem) }),
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List memories")
			.annotate(OpenApi.Description, "List the memories in a store, without their content")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "memoryStores.memories",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "memory_stores", endpoint: "listMemories" },
				"x-checkfu-mcp": { name: "memoryStores_listMemories" },
			}),
	)
	.add(
		HttpApiEndpoint.get("getMemory", "/v1/memory_stores/:memory_store_id/memories/:memory_id", {
			params: memoryParams,
			success: MemorySnapshot,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve a memory")
			.annotate(OpenApi.Description, "Retrieve a memory with its content")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "memoryStores.memories",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "memory_stores", endpoint: "getMemory" },
				"x-checkfu-mcp": { name: "memoryStores_getMemory" },
			}),
	)
	.add(
		HttpApiEndpoint.post("updateMemory", "/v1/memory_stores/:memory_store_id/memories/:memory_id", {
			params: memoryParams,
			payload: UpdateMemoryBody,
			success: [MemorySnapshot, PendingMemory],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Update a memory")
			.annotate(
				OpenApi.Description,
				"Replace a memory's content, optionally only if it is unchanged since it was read",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "memoryStores.memories",
				"x-forge-method-name": "update",
				"x-checkfu-endpoint": { group: "memory_stores", endpoint: "updateMemory" },
				"x-checkfu-mcp": { name: "memoryStores_updateMemory" },
				"x-checkfu-cli": { fileFields: ["content"] },
			})
			.middleware(MemoryBodyLimit),
	)
	.add(
		HttpApiEndpoint.delete(
			"deleteMemory",
			"/v1/memory_stores/:memory_store_id/memories/:memory_id",
			{
				params: memoryParams,
				query: {
					expected_content_sha256: Schema.optionalKey(
						ContentSha256.annotate({
							description: "Delete only if the stored content still has this SHA-256",
						}),
					),
				},
				success: Schema.Struct({ id: Schema.String, type: Schema.Literal("memory_deleted") }),
				error: HandlerErrors,
			},
		)
			.annotate(OpenApi.Summary, "Delete a memory")
			.annotate(OpenApi.Description, "Delete a memory from its store")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "memoryStores.memories",
				"x-forge-method-name": "delete",
				"x-checkfu-endpoint": { group: "memory_stores", endpoint: "deleteMemory" },
				"x-checkfu-mcp": { name: "memoryStores_deleteMemory" },
				"x-checkfu-idempotent": false,
			}),
	)
	.annotate(OpenApi.Description, "Manage memory stores")
	.middleware(Authentication)

const webhookListQuery = {
	...artifactListQuery,
	id: Schema.optionalKey(WebhookId).annotate({
		description: "Filter to a single webhook endpoint ID to check listing readiness in O(1).",
	}),
}

const Webhooks = HttpApiGroup.make("webhooks")
	.add(
		HttpApiEndpoint.post("create", "/v1/webhooks", {
			headers: IdempotencyHeaders,
			payload: CreateWebhookBody,
			success: [WebhookCreatedResource.pipe(HttpApiSchema.status(201)), PendingWebhook],
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Create a webhook")
			.annotate(
				OpenApi.Description,
				"Register an outbound HTTPS webhook endpoint and return its Standard Webhooks signing secret once.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "webhooks",
				"x-forge-method-name": "create",
				"x-checkfu-endpoint": { group: "webhooks", endpoint: "create" },
				"x-checkfu-mcp": { name: "webhooks_createWebhook", destructive: false },
				"x-checkfu-cli": {
					examples: [
						{
							command:
								'checkfu webhooks create --url "https://hooks.example.com/checkfu" --event-types \'["session.status_idled","automation_run.failed"]\'',
							description: "Create a webhook subscribed to session and automation events",
						},
					],
				},
			}),
	)
	.add(
		HttpApiEndpoint.get("list", "/v1/webhooks", {
			query: webhookListQuery,
			success: ListWebhooksResponse,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List webhooks")
			.annotate(
				OpenApi.Description,
				"List webhook endpoints in creation order, oldest first by default. Deleted endpoints never appear.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "webhooks",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "webhooks", endpoint: "list" },
				"x-checkfu-mcp": { name: "webhooks_listWebhooks" },
				"x-checkfu-cli": resourceListCli,
			}),
	)
	.add(
		HttpApiEndpoint.get("get", "/v1/webhooks/:webhook_id", {
			params: webhookParams,
			success: WebhookResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve a webhook")
			.annotate(OpenApi.Description, "Retrieve a webhook endpoint by ID")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "webhooks",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "webhooks", endpoint: "get" },
				"x-checkfu-mcp": { name: "webhooks_getWebhook" },
			}),
	)
	.add(
		HttpApiEndpoint.post("update", "/v1/webhooks/:webhook_id", {
			params: webhookParams,
			payload: UpdateWebhookBody,
			success: WebhookResource,
			error: BodyErrors,
		})
			.annotate(OpenApi.Summary, "Update a webhook")
			.annotate(
				OpenApi.Description,
				"Update a webhook endpoint's URL, description, or subscribed event types, and optionally reactivate it.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "webhooks",
				"x-forge-method-name": "update",
				"x-checkfu-endpoint": { group: "webhooks", endpoint: "update" },
				"x-checkfu-mcp": { name: "webhooks_updateWebhook" },
			}),
	)
	.add(
		HttpApiEndpoint.post("pause", "/v1/webhooks/:webhook_id/pause", {
			params: webhookParams,
			success: WebhookResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Pause a webhook")
			.annotate(OpenApi.Description, "Pause deliveries to a webhook endpoint without deleting it.")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "webhooks",
				"x-forge-method-name": "pause",
				"x-checkfu-endpoint": { group: "webhooks", endpoint: "pause" },
				"x-checkfu-mcp": { name: "webhooks_pauseWebhook" },
				"x-checkfu-idempotent": true,
			}),
	)
	.add(
		HttpApiEndpoint.post("resume", "/v1/webhooks/:webhook_id/resume", {
			params: webhookParams,
			success: WebhookResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Resume a webhook")
			.annotate(
				OpenApi.Description,
				"Resume a paused or auto-disabled webhook endpoint and clear its failure window.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "webhooks",
				"x-forge-method-name": "resume",
				"x-checkfu-endpoint": { group: "webhooks", endpoint: "resume" },
				"x-checkfu-mcp": { name: "webhooks_resumeWebhook" },
				"x-checkfu-idempotent": true,
			}),
	)
	.add(
		HttpApiEndpoint.post("rotateSecret", "/v1/webhooks/:webhook_id/rotate-secret", {
			params: webhookParams,
			headers: IdempotencyHeaders,
			success: WebhookSecretRotatedResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Rotate a webhook signing secret")
			.annotate(
				OpenApi.Description,
				"Generate a new signing secret for a webhook endpoint and return it once. The previous signing secret continues to be included in webhook-signature for 24 hours; overlapping rotations during an active grace period return 409 Conflict.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "webhooks",
				"x-forge-method-name": "rotateSecret",
				"x-checkfu-endpoint": { group: "webhooks", endpoint: "rotateSecret" },
				"x-checkfu-mcp": { name: "webhooks_rotateWebhookSecret" },
			}),
	)
	.add(
		HttpApiEndpoint.post("test", "/v1/webhooks/:webhook_id/test", {
			params: webhookParams,
			success: WebhookDeliveryResource.pipe(HttpApiSchema.status(201)),
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Send a test webhook event")
			.annotate(
				OpenApi.Description,
				"Queue a signed webhook.test delivery for an active webhook endpoint.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "webhooks",
				"x-forge-method-name": "test",
				"x-checkfu-endpoint": { group: "webhooks", endpoint: "test" },
				"x-checkfu-mcp": { name: "webhooks_testWebhook" },
			}),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/v1/webhooks/:webhook_id", {
			params: webhookParams,
			success: WebhookDeletedResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Delete a webhook")
			.annotate(
				OpenApi.Description,
				"Delete a webhook endpoint, discard its signing secrets, and purge its delivery queue.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "webhooks",
				"x-forge-method-name": "delete",
				"x-checkfu-endpoint": { group: "webhooks", endpoint: "delete" },
				"x-checkfu-mcp": { name: "webhooks_deleteWebhook" },
			}),
	)
	.add(
		HttpApiEndpoint.get("listDeliveries", "/v1/webhooks/:webhook_id/deliveries", {
			params: webhookParams,
			query: webhookDeliveryListQuery,
			success: ListWebhookDeliveriesResponse,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "List webhook deliveries")
			.annotate(
				OpenApi.Description,
				"List recent delivery attempts for a webhook endpoint, newest first.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "webhooks.deliveries",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "webhooks", endpoint: "listDeliveries" },
				"x-checkfu-mcp": { name: "webhooks_listDeliveries" },
				"x-checkfu-cli": {
					groupDescription: "Inspect and replay webhook deliveries",
					...resourceListCli,
				},
			}),
	)
	.add(
		HttpApiEndpoint.get("getDelivery", "/v1/webhooks/:webhook_id/deliveries/:delivery_id", {
			params: webhookDeliveryParams,
			success: WebhookDeliveryResource,
			error: HandlerErrors,
		})
			.annotate(OpenApi.Summary, "Retrieve a webhook delivery")
			.annotate(OpenApi.Description, "Retrieve one delivery record for a webhook endpoint.")
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "webhooks.deliveries",
				"x-forge-method-name": "retrieve",
				"x-checkfu-endpoint": { group: "webhooks", endpoint: "getDelivery" },
				"x-checkfu-mcp": { name: "webhooks_getDelivery" },
			}),
	)
	.add(
		HttpApiEndpoint.post(
			"redeliver",
			"/v1/webhooks/:webhook_id/deliveries/:delivery_id/redeliver",
			{
				params: webhookDeliveryParams,
				success: WebhookDeliveryResource.pipe(HttpApiSchema.status(201)),
				error: HandlerErrors,
			},
		)
			.annotate(OpenApi.Summary, "Redeliver a webhook event")
			.annotate(
				OpenApi.Description,
				"Queue a fresh delivery attempt for the payload of an existing webhook delivery.",
			)
			.annotate(OpenApi.Override, {
				"x-forge-group-name": "webhooks.deliveries",
				"x-forge-method-name": "redeliver",
				"x-checkfu-endpoint": { group: "webhooks", endpoint: "redeliver" },
				"x-checkfu-mcp": { name: "webhooks_redeliver" },
			}),
	)
	.annotate(OpenApi.Description, "Manage outbound webhooks")
	.middleware(Authentication)

export const CheckfuApi = HttpApi.make("checkfu")
	.add(Health)
	.add(Auth)
	.add(Agents)
	.add(Environments)
	.add(Sessions)
	.add(Automations)
	.add(Artifacts)
	.add(ArtifactData)
	.add(Files)
	.add(Vaults)
	.add(Webhooks)
	.add(MemoryStores)
	.annotate(OpenApi.Title, "Checkfu API")
	.annotate(OpenApi.Version, "0.0.1")
	.annotate(
		OpenApi.Description,
		"Managed agents API for managing agents, environments, sessions, automations, artifacts, vaults, memory stores, and outbound webhooks.",
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
