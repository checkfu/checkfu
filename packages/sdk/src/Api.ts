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
	EnvironmentConfig,
	EnvironmentDescription,
	EnvironmentId,
	EnvironmentName,
	EnvironmentSnapshot,
	NonEmptyString,
	PositiveInt,
	ResourceId,
	SessionEventFields,
	SessionId,
	SessionSnapshot,
	SessionTitle,
	TextBlocks,
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

export type PendingResourceType = "agent" | "environment" | "session" | "automation"

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

export const PendingResource = Schema.Union([
	PendingAgent,
	PendingEnvironment,
	PendingSession,
	PendingAutomation,
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

const listResponse = <A extends Schema.Top>(resource: A) =>
	Schema.Struct({
		data: Schema.Array(resource),
		has_more: Schema.Boolean,
		next_cursor: Schema.NullOr(Schema.Finite),
	})

export const ListAgentsResponse = listResponse(AgentResource)
export type ListAgentsResponse = typeof ListAgentsResponse.Type

export const ListEnvironmentsResponse = listResponse(EnvironmentSnapshot)
export type ListEnvironmentsResponse = typeof ListEnvironmentsResponse.Type

export const ListSessionsResponse = listResponse(SessionResource)
export type ListSessionsResponse = typeof ListSessionsResponse.Type

export const ListAutomationsResponse = listResponse(AutomationResource)
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

const resourceListQuery = {
	after: Schema.optionalKey(EventListAfterFromString),
	limit: Schema.optionalKey(ListLimitFromString),
	order: Schema.optionalKey(
		Schema.Literals(["asc", "desc"]).annotate({
			description: "Sort order by creation: asc (oldest first, the default) or desc",
		}),
	),
	include_archived: Schema.optionalKey(
		Schema.Literals(["true", "false"])
			.annotate({ description: "Include archived results: true or false (default false)" })
			.pipe(
				Schema.decodeTo(Schema.Boolean, {
					decode: SchemaGetter.transform((value) => value === "true"),
					encode: SchemaGetter.transform((value) => (value ? "true" : "false")),
				}),
			),
	),
}

const resourceListCli = {
	intQueryParams: {
		after: { min: 0, metavar: "SEQ" },
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

export const CheckfuApi = HttpApi.make("checkfu")
	.add(Health)
	.add(Auth)
	.add(Agents)
	.add(Environments)
	.add(Sessions)
	.add(Automations)
	.annotate(OpenApi.Title, "Checkfu API")
	.annotate(OpenApi.Version, "0.0.1")
	.annotate(
		OpenApi.Description,
		"Managed agents API for managing agents, environments, sessions, and automations.",
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
