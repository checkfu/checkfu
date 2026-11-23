import { AgentId } from "@checkfu/agents/Agent/Agent.id"
import { AgentSnapshot } from "@checkfu/agents/Agent/AgentView.view"
import {
	AgentDescription,
	AgentModel,
	AgentName,
	AgentSystem,
	NonEmptyString,
	PositiveInt,
} from "@checkfu/agents/AgentTypes"
import { EnvironmentId } from "@checkfu/environments/Environment/Environment.id"
import { EnvironmentSnapshot } from "@checkfu/environments/Environment/EnvironmentView.view"
import {
	EnvironmentConfig,
	EnvironmentDescription,
	EnvironmentName,
} from "@checkfu/environments/EnvironmentTypes"
import { SessionId } from "@checkfu/sessions/Session/Session.id"
import { ResourceId, SessionTitle } from "@checkfu/sessions/Session/SessionTypes"
import { SessionSnapshot } from "@checkfu/sessions/Session/SessionView.view"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Function from "effect/Function"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiClient from "effect/http-api/HttpApiClient"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware"
import * as HttpApiSchema from "effect/http-api/HttpApiSchema"
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity"
import type * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientError from "effect/http/HttpClientError"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as Struct from "effect/Struct"
import type { Simplify } from "effect/Types"

export const REQUEST_ID_HEADER = "request-id"

export const RequestId = NonEmptyString.pipe(Schema.brand("RequestId"))
export type RequestId = typeof RequestId.Type

const ErrorAccepted = Schema.Array(Schema.Unknown)
const ErrorIndex = Schema.Finite
const isErrorIndex = Schema.is(ErrorIndex)

const errorEnvelope = <const T extends string>(status: number, type: T) =>
	Schema.Struct({
		type: Schema.Literal("error"),
		error: Schema.Struct({ type: Schema.Literal(type), message: Schema.String }),
		request_id: RequestId,
		accepted: Schema.optionalKey(ErrorAccepted),
		failed_index: Schema.optionalKey(ErrorIndex),
		unconfirmed_index: Schema.optionalKey(ErrorIndex),
	}).pipe(HttpApiSchema.status(status))

export const ERRORS = {
	400: errorEnvelope(400, "invalid_request_error"),
	401: errorEnvelope(401, "authentication_error"),
	404: errorEnvelope(404, "not_found_error"),
	409: errorEnvelope(409, "conflict_error"),
	413: errorEnvelope(413, "payload_too_large"),
	415: errorEnvelope(415, "unsupported_media_type"),
	429: errorEnvelope(429, "rate_limit_error"),
	500: errorEnvelope(500, "internal_error"),
	503: errorEnvelope(503, "service_unavailable"),
} as const

export type ErrorStatus = keyof typeof ERRORS
export type ApiError = (typeof ERRORS)[ErrorStatus]["Type"]
export type HandlerErrorStatus = 400 | 404 | 409 | 429 | 500 | 503
export type HandlerError = (typeof ERRORS)[HandlerErrorStatus]["Type"]

interface ApiErrorExtra {
	readonly accepted?: ReadonlyArray<unknown>
	readonly failed_index?: number
	readonly unconfirmed_index?: number
}

const makeError =
	<const T extends ApiError["error"]["type"]>(type: T) =>
	(message: string, request_id: RequestId, extra?: ApiErrorExtra) => ({
		type: "error" as const,
		error: { type, message },
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
	400: makeError("invalid_request_error"),
	401: makeError("authentication_error"),
	404: makeError("not_found_error"),
	409: makeError("conflict_error"),
	413: makeError("payload_too_large"),
	415: makeError("unsupported_media_type"),
	429: makeError("rate_limit_error"),
	500: makeError("internal_error"),
	503: makeError("service_unavailable"),
} satisfies ErrorFactories

export const apiError = <S extends ErrorStatus>(
	status: S,
	message: string,
	request_id: RequestId,
	extra?: ApiErrorExtra,
): (typeof ERRORS)[S]["Type"] => ERROR_FACTORIES[status](message, request_id, extra)

const HANDLER_ERROR_STATUS_BY_TYPE: Readonly<
	Record<HandlerError["error"]["type"], HandlerErrorStatus>
> = {
	invalid_request_error: 400,
	not_found_error: 404,
	conflict_error: 409,
	rate_limit_error: 429,
	internal_error: 500,
	service_unavailable: 503,
}

const STATUS_OF_TYPE: Readonly<Record<ApiError["error"]["type"], ErrorStatus>> = {
	...HANDLER_ERROR_STATUS_BY_TYPE,
	authentication_error: 401,
	payload_too_large: 413,
	unsupported_media_type: 415,
}

export const isApiErrorType = (type: unknown): type is ApiError["error"]["type"] =>
	typeof type === "string" && Object.hasOwn(STATUS_OF_TYPE, type)

export const statusOf = (error: ApiError): ErrorStatus => STATUS_OF_TYPE[error.error.type]

const HandlerErrorInput = Schema.Struct({
	type: Schema.Literal("error"),
	error: Schema.Struct({
		type: Schema.Literals([
			"invalid_request_error",
			"not_found_error",
			"conflict_error",
			"rate_limit_error",
			"internal_error",
			"service_unavailable",
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
	return apiError(HANDLER_ERROR_STATUS_BY_TYPE[error.type], error.message, request_id, {
		...(accepted === undefined ? {} : { accepted }),
		...(failed_index === undefined ? {} : { failed_index }),
		...(unconfirmed_index === undefined ? {} : { unconfirmed_index }),
	})
}

export interface LoggableApiFailure {
	readonly error_type: ApiError["error"]["type"] | "unknown"
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
	const errorType: ApiError["error"]["type"] | "unknown" =
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
	name: AgentName,
	model: ModelInput,
	system: Schema.optionalKey(Schema.NullOr(AgentSystem)),
	description: Schema.optionalKey(Schema.NullOr(AgentDescription)),
})

export const UpdateAgentBody = Schema.Struct({
	version: PositiveInt,
	name: Schema.optionalKey(AgentName),
	model: Schema.optionalKey(ModelInput),
	system: Schema.optionalKey(Schema.NullOr(AgentSystem)),
	description: Schema.optionalKey(Schema.NullOr(AgentDescription)),
})

export const CreateEnvironmentBody = Schema.Struct({
	name: EnvironmentName,
	description: Schema.optionalKey(Schema.NullOr(EnvironmentDescription)),
	config: Schema.optionalKey(EnvironmentConfig),
})

export const UpdateEnvironmentBody = Schema.Struct({
	version: PositiveInt,
	name: Schema.optionalKey(EnvironmentName),
	description: Schema.optionalKey(Schema.NullOr(EnvironmentDescription)),
	config: Schema.optionalKey(EnvironmentConfig),
})

const AgentReference = Schema.Union([
	ResourceId,
	Schema.Struct({ id: ResourceId, version: Schema.optionalKey(PositiveInt) }),
])

const CreateSessionCommonFields = {
	agent_version: Schema.optionalKey(PositiveInt),
	environment_id: ResourceId,
	title: Schema.optionalKey(Schema.NullOr(SessionTitle)),
}

export const CreateSessionBody = Schema.Union([
	Schema.Struct({
		agent: AgentReference,
		agent_id: Schema.optionalKey(ResourceId),
		...CreateSessionCommonFields,
	}),
	Schema.Struct({
		agent: Schema.optionalKey(AgentReference),
		agent_id: ResourceId,
		...CreateSessionCommonFields,
	}),
])

export const ClientEventId = Schema.String.check(
	Schema.isTrimmed(),
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
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
		]),
	).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
})

const AgentResource = Schema.Struct(Struct.omit(AgentSnapshot.fields, ["current_version_id"]))

const SessionResource = Schema.Struct({
	...Struct.omit(SessionSnapshot.fields, ["agent_id", "agent_version"]),
	agent: Schema.Struct({ id: Schema.String, version: PositiveInt }),
})

const Pending = Schema.Struct({
	id: Schema.String,
	type: Schema.String,
	pending: Schema.Literal(true),
}).pipe(HttpApiSchema.status(202))

const EventNonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const EventPositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const EventNonEmptyString = Schema.String.check(Schema.isMinLength(1))

const SessionEventTextBlock = Schema.Struct({
	type: Schema.Literal("text"),
	text: Schema.String,
})

const SessionEventContent = Schema.Array(SessionEventTextBlock).check(Schema.isMinLength(1))

const SessionEventModelUsage = Schema.Struct({
	input_tokens: EventNonNegativeInt,
	output_tokens: EventNonNegativeInt,
})

const SessionEventStopReason = Schema.Struct({
	type: Schema.Literals([
		"end_turn",
		"interrupted",
		"retries_exhausted",
		"budget_reached",
		"refusal",
	]),
})

const SessionEventRetryStatus = Schema.Struct({
	type: Schema.Literals(["retrying", "exhausted", "terminal"]),
})

const SessionEventErrorBody = Schema.Struct({
	type: Schema.String,
	message: Schema.String,
	retry_status: SessionEventRetryStatus,
})

const sessionEventBase = <const T extends string>(type: T) => ({
	id: Schema.String,
	seq: EventPositiveInt,
	type: Schema.Literal(type),
	created_at: Schema.DateTimeUtc,
})

export const UserMessageSessionEvent = Schema.Struct({
	...sessionEventBase("user.message"),
	content: SessionEventContent,
})

export const UserInterruptSessionEvent = Schema.Struct({
	...sessionEventBase("user.interrupt"),
})

export const SessionStatusRunningEvent = Schema.Struct({
	...sessionEventBase("session.status_running"),
})

export const SpanModelRequestStartEvent = Schema.Struct({
	...sessionEventBase("span.model_request_start"),
	model_request_start_id: EventNonEmptyString,
})

export const AgentThinkingSessionEvent = Schema.Struct({
	...sessionEventBase("agent.thinking"),
	thinking: Schema.String,
})

export const AgentMessageSessionEvent = Schema.Struct({
	...sessionEventBase("agent.message"),
	content: SessionEventContent,
	truncated: Schema.optionalKey(Schema.Literal(true)),
})

export const SpanModelRequestEndEvent = Schema.Struct({
	...sessionEventBase("span.model_request_end"),
	model_request_start_id: EventNonEmptyString,
	model_usage: SessionEventModelUsage,
	is_error: Schema.NullOr(Schema.Boolean),
})

export const SessionStatusIdleEvent = Schema.Struct({
	...sessionEventBase("session.status_idle"),
	stop_reason: SessionEventStopReason,
})

export const SessionErrorSessionEvent = Schema.Struct({
	...sessionEventBase("session.error"),
	error: SessionEventErrorBody,
})

export const SessionStatusTerminatedEvent = Schema.Struct({
	...sessionEventBase("session.status_terminated"),
})

export const SessionArchivedEvent = Schema.Struct({
	...sessionEventBase("session.archived"),
})

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

export const CursorFromString = Schema.String.check(Schema.isPattern(/^\d{1,15}$/u)).pipe(
	Schema.decodeTo(
		Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 999_999_999_999_999 })),
		{
			decode: SchemaGetter.transform(Number),
			encode: SchemaGetter.transform(String),
		},
	),
)

const EventListLimitFromString = Schema.String.check(Schema.isPattern(/^(?:[1-9]\d?|100)$/u)).pipe(
	Schema.decodeTo(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })), {
		decode: SchemaGetter.transform(Number),
		encode: SchemaGetter.transform(String),
	}),
)

const agentParams = { agent_id: AgentId }
const environmentParams = { environment_id: EnvironmentId }
const sessionParams = { session_id: SessionId }

export const IdempotencyKey = Context.Reference<string | undefined>("@checkfu/api/IdempotencyKey", {
	defaultValue: () => undefined,
})

export const withIdempotencyKey: {
	(key: string): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
	<A, E, R>(effect: Effect.Effect<A, E, R>, key: string): Effect.Effect<A, E, R>
} = Function.dual(
	2,
	<A, E, R>(effect: Effect.Effect<A, E, R>, key: string): Effect.Effect<A, E, R> =>
		Effect.provideService(effect, IdempotencyKey, key),
)

const IdempotencyHeaders = Schema.Struct({
	"idempotency-key": Schema.optionalKey(ClientEventId),
})

const IdempotencyHeadersInput = Schema.Struct({
	"idempotency-key": Schema.optional(ClientEventId),
})

export type OptionalIdempotencyHeadersInput = typeof IdempotencyHeadersInput.Type

const encodeIdempotencyHeaders = SchemaGetter.transformEffect(
	(value: OptionalIdempotencyHeadersInput | undefined) =>
		Effect.gen(function* () {
			const explicit = value?.["idempotency-key"]
			if (explicit !== undefined) {
				return { "idempotency-key": explicit }
			}
			const contextual = yield* IdempotencyKey
			return contextual === undefined ? {} : { "idempotency-key": contextual }
		}),
)

const ContextualIdempotencyHeaders = IdempotencyHeaders.pipe(
	Schema.decodeTo(IdempotencyHeadersInput, {
		decode: SchemaGetter.passthrough(),
		encode: encodeIdempotencyHeaders,
	}),
)

const OptionalIdempotencyHeaders = IdempotencyHeaders.pipe(
	Schema.decodeTo(Schema.UndefinedOr(IdempotencyHeadersInput), {
		decode: SchemaGetter.passthrough(),
		encode: encodeIdempotencyHeaders,
	}),
)

type WithoutClientHeaders<Endpoint> =
	Endpoint extends HttpApiEndpoint.HttpApiEndpoint<
		infer Identifier,
		infer Method,
		infer Path,
		infer Params,
		infer Query,
		infer Payload,
		infer _Headers,
		infer Success,
		infer Error,
		infer Middleware,
		infer MiddlewareServices
	>
		? HttpApiEndpoint.HttpApiEndpoint<
				Identifier,
				Method,
				Path,
				Params,
				Query,
				Payload,
				never,
				Success,
				Error,
				Middleware,
				MiddlewareServices
			>
		: never

const withOptionalIdempotencyHeaders = <Endpoint extends HttpApiEndpoint.Constraint>(
	endpoint: Endpoint,
): WithoutClientHeaders<Endpoint> =>
	// Erase only the phantom `~Headers` type parameter so Effect's generated client
	// does not require `headers` while runtime decoding and OpenAPI retain the schema.
	// oxlint-disable-next-line quality/no-chained-type-assertions, typescript/no-unsafe-type-assertion
	endpoint as unknown as WithoutClientHeaders<Endpoint>

const Health = HttpApiGroup.make("health").add(
	HttpApiEndpoint.get("health", "/health", {
		success: Schema.Struct({ status: Schema.Literal("ok") }),
	}),
)

const Agents = HttpApiGroup.make("agents")
	.add(
		withOptionalIdempotencyHeaders(
			HttpApiEndpoint.post("create", "/v1/agents", {
				headers: OptionalIdempotencyHeaders,
				payload: CreateAgentBody,
				success: [AgentResource.pipe(HttpApiSchema.status(201)), Pending],
				error: BodyErrors,
			}).middleware(AgentBodyLimit),
		),
	)
	.add(
		HttpApiEndpoint.get("get", "/v1/agents/:agent_id", {
			params: agentParams,
			success: AgentResource,
			error: HandlerErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("update", "/v1/agents/:agent_id", {
			params: agentParams,
			payload: UpdateAgentBody,
			success: [AgentResource, Pending],
			error: BodyErrors,
		}).middleware(AgentBodyLimit),
	)
	.add(
		HttpApiEndpoint.post("archive", "/v1/agents/:agent_id/archive", {
			params: agentParams,
			success: [AgentResource, Pending],
			error: HandlerErrors,
		}),
	)
	.middleware(Authentication)

const Environments = HttpApiGroup.make("environments")
	.add(
		withOptionalIdempotencyHeaders(
			HttpApiEndpoint.post("create", "/v1/environments", {
				headers: OptionalIdempotencyHeaders,
				payload: CreateEnvironmentBody,
				success: [EnvironmentSnapshot.pipe(HttpApiSchema.status(201)), Pending],
				error: BodyErrors,
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("get", "/v1/environments/:environment_id", {
			params: environmentParams,
			success: EnvironmentSnapshot,
			error: HandlerErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("update", "/v1/environments/:environment_id", {
			params: environmentParams,
			payload: UpdateEnvironmentBody,
			success: [EnvironmentSnapshot, Pending],
			error: BodyErrors,
		}),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/v1/environments/:environment_id", {
			params: environmentParams,
			success: Schema.Struct({ id: Schema.String, type: Schema.Literal("environment_deleted") }),
			error: HandlerErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("archive", "/v1/environments/:environment_id/archive", {
			params: environmentParams,
			success: [EnvironmentSnapshot, Pending],
			error: HandlerErrors,
		}),
	)
	.middleware(Authentication)

const Sessions = HttpApiGroup.make("sessions")
	.add(
		withOptionalIdempotencyHeaders(
			HttpApiEndpoint.post("create", "/v1/sessions", {
				headers: OptionalIdempotencyHeaders,
				payload: CreateSessionBody,
				success: [SessionResource.pipe(HttpApiSchema.status(201)), Pending],
				error: BodyErrors,
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("get", "/v1/sessions/:session_id", {
			params: sessionParams,
			success: SessionResource,
			error: HandlerErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("archive", "/v1/sessions/:session_id/archive", {
			params: sessionParams,
			success: [SessionResource, Pending],
			error: HandlerErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("sendEvents", "/v1/sessions/:session_id/events", {
			params: sessionParams,
			headers: ContextualIdempotencyHeaders,
			payload: SendSessionEventsBody,
			success: Schema.Struct({ data: Schema.Array(Schema.Unknown) }),
			error: BodyErrors,
		}).middleware(EventBatchBodyLimit),
	)
	.add(
		HttpApiEndpoint.get("listEvents", "/v1/sessions/:session_id/events", {
			params: sessionParams,
			query: {
				after: Schema.optionalKey(CursorFromString),
				limit: Schema.optionalKey(EventListLimitFromString),
				order: Schema.optionalKey(Schema.Literals(["asc", "desc"])),
			},
			success: Schema.Struct({
				data: Schema.Array(SessionEvent),
				has_more: Schema.Boolean,
				next_cursor: Schema.NullOr(Schema.Finite),
			}),
			error: HandlerErrors,
		}),
	)
	.add(
		HttpApiEndpoint.get("streamEvents", "/v1/sessions/:session_id/events/stream", {
			params: sessionParams,
			// Keep `after` as a raw string here so `streamEvents` can give a non-empty
			// `Last-Event-ID` header precedence before decoding the selected cursor.
			query: { after: Schema.optionalKey(Schema.String) },
			success: [HttpApiSchema.StreamSse({ data: SessionEvent }), HttpApiSchema.NoContent],
			error: HandlerErrors,
		}),
	)
	.middleware(Authentication)

export const CheckfuApi = HttpApi.make("checkfu")
	.add(Health)
	.add(Agents)
	.add(Environments)
	.add(Sessions)
	.middleware(RequestValidation)

type OptionalIdempotencyCreateMethod<Endpoint extends HttpApiEndpoint.ConstraintRequest, E, R> = <
	Mode extends HttpApiClient.Client.ResponseMode = "decoded-only",
>(
	request: Simplify<
		HttpApiEndpoint.ClientRequest<
			Endpoint["~Params"],
			Endpoint["~Query"],
			Endpoint["~Payload"],
			never,
			Mode,
			never
		> & {
			readonly headers?: OptionalIdempotencyHeadersInput | undefined
		}
	>,
) => Effect.Effect<
	HttpApiClient.Client.Response<HttpApiClient.SuccessType<Endpoint["~Success"]>, Mode>,
	| HttpApiMiddleware.Error<Endpoint["~Middleware"]>
	| HttpApiMiddleware.ClientError<Endpoint["~Middleware"]>
	| E
	| HttpClientError.HttpClientError
	| Schema.SchemaError
	| ([Mode] extends ["response-only"] ? never : Endpoint["~Error"]["Type"]),
	| R
	| Endpoint["~Params"]["EncodingServices"]
	| Endpoint["~Query"]["EncodingServices"]
	| Endpoint["~Payload"]["EncodingServices"]
	| ([Mode] extends ["response-only"]
			? never
			: Endpoint["~Success"]["DecodingServices"] | Endpoint["~Error"]["DecodingServices"])
>

type GeneratedCheckfuClient<E = never, R = never> = HttpApiClient.ForApi<typeof CheckfuApi, E, R>

type CheckfuEndpoint<
	GroupId extends keyof (typeof CheckfuApi)["groups"],
	EndpointId extends keyof (typeof CheckfuApi)["groups"][GroupId]["endpoints"],
> = (typeof CheckfuApi)["groups"][GroupId]["endpoints"][EndpointId]

export type CheckfuClient<E = never, R = never> = Simplify<
	Omit<GeneratedCheckfuClient<E, R>, "agents" | "environments" | "sessions"> & {
		readonly agents: Simplify<
			Omit<GeneratedCheckfuClient<E, R>["agents"], "create"> & {
				readonly create: OptionalIdempotencyCreateMethod<CheckfuEndpoint<"agents", "create">, E, R>
			}
		>
		readonly environments: Simplify<
			Omit<GeneratedCheckfuClient<E, R>["environments"], "create"> & {
				readonly create: OptionalIdempotencyCreateMethod<
					CheckfuEndpoint<"environments", "create">,
					E,
					R
				>
			}
		>
		readonly sessions: Simplify<
			Omit<GeneratedCheckfuClient<E, R>["sessions"], "create"> & {
				readonly create: OptionalIdempotencyCreateMethod<
					CheckfuEndpoint<"sessions", "create">,
					E,
					R
				>
			}
		>
	}
>

export const makeCheckfuClient = (options?: {
	readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
	readonly transformResponse?:
		| ((
				effect: Effect.Effect<unknown, unknown, unknown>,
		  ) => Effect.Effect<unknown, unknown, unknown>)
		| undefined
	readonly baseUrl?: URL | string | undefined
}): Effect.Effect<CheckfuClient, never, HttpClient.HttpClient> =>
	// Re-expose optional `headers` on create methods backed by `OptionalIdempotencyHeaders` at runtime.
	// oxlint-disable-next-line quality/no-chained-type-assertions, typescript/no-unsafe-type-assertion
	HttpApiClient.make(CheckfuApi, options) as unknown as Effect.Effect<
		CheckfuClient,
		never,
		HttpClient.HttpClient
	>

export const makeCheckfuClientWith = <E, R>(options: {
	readonly httpClient: HttpClient.HttpClient.With<E, R>
	readonly transformResponse?:
		| ((
				effect: Effect.Effect<unknown, unknown, unknown>,
		  ) => Effect.Effect<unknown, unknown, unknown>)
		| undefined
	readonly baseUrl?: URL | string | undefined
}): Effect.Effect<CheckfuClient<Exclude<E, HttpClientError.HttpClientError>, R>> =>
	// Re-expose optional `headers` on create methods backed by `OptionalIdempotencyHeaders` at runtime.
	// oxlint-disable-next-line quality/no-chained-type-assertions, typescript/no-unsafe-type-assertion
	HttpApiClient.makeWith(CheckfuApi, options) as unknown as Effect.Effect<
		CheckfuClient<Exclude<E, HttpClientError.HttpClientError>, R>
	>
