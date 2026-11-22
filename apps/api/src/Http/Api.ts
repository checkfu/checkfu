import { AgentId } from "@checkfu/agents/Agent/Agent.id"
import { AgentSnapshot } from "@checkfu/agents/Agent/AgentView.view"
import { AgentModel, NonEmptyString, PositiveInt } from "@checkfu/agents/AgentTypes"
import { EnvironmentId } from "@checkfu/environments/Environment/Environment.id"
import { EnvironmentSnapshot } from "@checkfu/environments/Environment/EnvironmentView.view"
import { EnvironmentConfig } from "@checkfu/environments/EnvironmentTypes"
import { SessionId } from "@checkfu/sessions/Session/Session.id"
import { ResourceId, SessionTitle } from "@checkfu/sessions/Session/SessionTypes"
import { SessionSnapshot } from "@checkfu/sessions/Session/SessionView.view"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware"
import * as HttpApiSchema from "effect/http-api/HttpApiSchema"
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity"
import * as Schema from "effect/Schema"
import * as Struct from "effect/Struct"

const errorEnvelope = <const T extends string>(status: number, type: T) =>
	Schema.Struct({
		type: Schema.Literal("error"),
		error: Schema.Struct({ type: Schema.Literal(type), message: Schema.String }),
		accepted: Schema.optionalKey(Schema.Array(Schema.Unknown)),
		failed_index: Schema.optionalKey(Schema.Number),
		unconfirmed_index: Schema.optionalKey(Schema.Number),
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

const ERROR_TYPES: Readonly<Record<ErrorStatus, ApiError["error"]["type"]>> = {
	400: "invalid_request_error",
	401: "authentication_error",
	404: "not_found_error",
	409: "conflict_error",
	413: "payload_too_large",
	415: "unsupported_media_type",
	429: "rate_limit_error",
	500: "internal_error",
	503: "service_unavailable",
}

export const apiError = <S extends ErrorStatus>(
	status: S,
	message: string,
	extra?: {
		readonly accepted?: ReadonlyArray<unknown>
		readonly failed_index?: number
		readonly unconfirmed_index?: number
	},
): (typeof ERRORS)[S]["Type"] =>
	({
		type: "error",
		error: { type: ERROR_TYPES[status], message },
		...extra,
	}) as (typeof ERRORS)[S]["Type"]

const STATUS_OF_TYPE: Readonly<Record<ApiError["error"]["type"], ErrorStatus>> = {
	invalid_request_error: 400,
	authentication_error: 401,
	not_found_error: 404,
	conflict_error: 409,
	payload_too_large: 413,
	unsupported_media_type: 415,
	rate_limit_error: 429,
	internal_error: 500,
	service_unavailable: 503,
}

export const statusOf = (error: ApiError): ErrorStatus => STATUS_OF_TYPE[error.error.type]

export type HandlerErrorStatus = 400 | 404 | 409 | 429 | 500 | 503
export type HandlerError = (typeof ERRORS)[HandlerErrorStatus]["Type"]

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

export class EventBatchBodyLimit extends HttpApiMiddleware.Service<EventBatchBodyLimit>()(
	"@checkfu/api/EventBatchBodyLimit",
) {}

const ModelInput = Schema.Union([NonEmptyString, AgentModel])

export const CreateAgentBody = Schema.Struct({
	name: NonEmptyString,
	model: ModelInput,
	system: Schema.optionalKey(Schema.NullOr(Schema.String)),
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

export const UpdateAgentBody = Schema.Struct({
	version: PositiveInt,
	name: Schema.optionalKey(NonEmptyString),
	model: Schema.optionalKey(ModelInput),
	system: Schema.optionalKey(Schema.NullOr(Schema.String)),
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

export const CreateEnvironmentBody = Schema.Struct({
	name: NonEmptyString,
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	config: Schema.optionalKey(EnvironmentConfig),
})

export const UpdateEnvironmentBody = Schema.Struct({
	version: PositiveInt,
	name: Schema.optionalKey(NonEmptyString),
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
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

const ClientEventId = Schema.String.check(
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

const SessionEvent = Schema.Record(Schema.String, Schema.Unknown)

const Digits = Schema.String.check(Schema.isPattern(/^\d{1,15}$/))

const agentParams = { agent_id: AgentId }
const environmentParams = { environment_id: EnvironmentId }
const sessionParams = { session_id: SessionId }

const Health = HttpApiGroup.make("health").add(
	HttpApiEndpoint.get("health", "/health", {
		success: Schema.Struct({ status: Schema.Literal("ok") }),
	}),
)

const Agents = HttpApiGroup.make("agents")
	.add(
		HttpApiEndpoint.post("create", "/v1/agents", {
			payload: CreateAgentBody,
			success: [AgentResource.pipe(HttpApiSchema.status(201)), Pending],
			error: BodyErrors,
		}),
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
		}),
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
		HttpApiEndpoint.post("create", "/v1/environments", {
			payload: CreateEnvironmentBody,
			success: [EnvironmentSnapshot.pipe(HttpApiSchema.status(201)), Pending],
			error: BodyErrors,
		}),
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
		HttpApiEndpoint.post("create", "/v1/sessions", {
			payload: CreateSessionBody,
			success: [SessionResource.pipe(HttpApiSchema.status(201)), Pending],
			error: BodyErrors,
		}),
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
			headers: { "idempotency-key": Schema.optionalKey(ClientEventId) },
			payload: SendSessionEventsBody,
			success: Schema.Struct({ data: Schema.Array(Schema.Unknown) }),
			error: BodyErrors,
		}).middleware(EventBatchBodyLimit),
	)
	.add(
		HttpApiEndpoint.get("listEvents", "/v1/sessions/:session_id/events", {
			params: sessionParams,
			query: {
				after: Schema.optionalKey(Digits),
				limit: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^(?:[1-9]\d?|100)$/))),
				order: Schema.optionalKey(Schema.Literals(["asc", "desc"])),
			},
			success: Schema.Struct({
				data: Schema.Array(SessionEvent),
				has_more: Schema.Boolean,
				next_cursor: Schema.NullOr(Schema.Number),
			}),
			error: HandlerErrors,
		}),
	)
	.add(
		HttpApiEndpoint.get("streamEvents", "/v1/sessions/:session_id/events/stream", {
			params: sessionParams,
			query: { after: Schema.optionalKey(Schema.String) },
			success: [
				HttpApiSchema.StreamUint8Array({ contentType: "text/event-stream" }),
				HttpApiSchema.NoContent,
			],
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
