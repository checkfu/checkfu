import type * as Brand from "effect/Brand"
import type * as DateTime from "effect/DateTime"
import type * as Effect from "effect/Effect"
import type * as HttpApiClient from "effect/http-api/HttpApiClient"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import type * as Schema from "effect/Schema"
import type * as Stream from "effect/Stream"
import type { CheckfuApi, CheckfuHttpApiClient, SessionEvent } from "./Api.ts"
import type { CheckfuSdkError } from "./Errors.ts"
import type { ApiSseError } from "./Sse.ts"

export type IsoDateTimes<T> = T extends DateTime.Utc
	? string
	: T extends Brand.Brand<infer _K>
		? T extends string
			? string
			: T extends number
				? number
				: T
		: T extends string | number | boolean | null | undefined | symbol | bigint
			? T
			: T extends ReadonlyArray<infer U>
				? ReadonlyArray<IsoDateTimes<U>>
				: T extends object
					? { readonly [K in keyof T]: IsoDateTimes<T[K]> }
					: T

export type ApiGroupName = keyof (typeof CheckfuApi)["groups"]
export type ApiEndpointName<G extends ApiGroupName> =
	keyof (typeof CheckfuApi)["groups"][G]["endpoints"]
export type ApiEndpoint<
	G extends ApiGroupName,
	E extends ApiEndpointName<G>,
> = (typeof CheckfuApi)["groups"][G]["endpoints"][E]

export type EndpointProp<Ep, K extends string> = Ep extends { readonly [P in K]: infer V }
	? V
	: never

export type SchemaTypeOrNever<S> = S extends Schema.Top ? S["Type"] : never

type UnwrapStreamElement<T> =
	T extends Stream.Stream<infer Event, infer _E, infer _R> ? Event : never

export type EndpointDecodedParams<
	G extends ApiGroupName,
	E extends ApiEndpointName<G>,
> = SchemaTypeOrNever<EndpointProp<ApiEndpoint<G, E>, "~Params">>

export type EndpointSuccess<
	G extends ApiGroupName,
	E extends ApiEndpointName<G>,
> = HttpApiClient.SuccessType<EndpointProp<ApiEndpoint<G, E>, "~Success">>

export type EndpointSseEvent<
	G extends ApiGroupName,
	E extends ApiEndpointName<G>,
> = UnwrapStreamElement<EndpointSuccess<G, E>>

export type RawSseMethod = (request: {
	readonly params?: unknown
	readonly query?: unknown
	readonly responseMode: "response-only"
}) => Effect.Effect<HttpClientResponse.HttpClientResponse, ApiSseError>

export const asIsoDateTimes = <T>(json: Schema.Json): IsoDateTimes<T> => json as IsoDateTimes<T>

export const parseJsonAs = <T>(text: string): T => JSON.parse(text) as T

export const endpointParamsCodec = <G extends ApiGroupName, E extends ApiEndpointName<G>>(
	schema: Schema.Top,
): Schema.Codec<EndpointDecodedParams<G, E>, unknown, never, never> =>
	schema as Schema.Codec<EndpointDecodedParams<G, E>, unknown, never, never>

export const lookupRawSseMethod = (
	raw: CheckfuHttpApiClient,
	group: string,
	endpoint: string,
): RawSseMethod | undefined => {
	for (const [groupName, groupClient] of Object.entries(raw)) {
		if (groupName !== group || typeof groupClient !== "object" || groupClient === null) {
			continue
		}
		for (const [endpointName, fn] of Object.entries(groupClient)) {
			if (endpointName === endpoint && typeof fn === "function") {
				return fn as RawSseMethod
			}
		}
	}
	return undefined
}

export const asEndpointSseStream = <G extends ApiGroupName, E extends ApiEndpointName<G>>(
	stream: Stream.Stream<SessionEvent, CheckfuSdkError>,
): Stream.Stream<EndpointSseEvent<G, E>, CheckfuSdkError> =>
	stream as Stream.Stream<EndpointSseEvent<G, E>, CheckfuSdkError>

export const asEndpointSseEvent = <G extends ApiGroupName, E extends ApiEndpointName<G>>(
	parsed: Schema.Json,
): EndpointSseEvent<G, E> => parsed as EndpointSseEvent<G, E>
