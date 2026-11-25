import { parseJsonAs } from "./Boundary.ts"
import { CLIENT_EVENT_ID_MESSAGE, isClientEventId } from "./IdempotencyKey.ts"
import { SDK_OPERATION_BINDINGS } from "./generated/OperationBindings.ts"
import type { CheckfuOperations } from "./generated/Resources.ts"
import { SINGLE_PATH_SEGMENT_MESSAGE, isSinglePathSegment } from "./PathSegment.ts"
import type { BodyOf, JsonResultOf, PathOf, QueryOf } from "./Runtime.ts"

type Binding = (typeof SDK_OPERATION_BINDINGS)[number]
type BindingOf<Op extends OperationId> = Extract<Binding, { readonly operationId: Op }>

export type OperationId = Binding["operationId"] & keyof CheckfuOperations
export type JsonOperationId = Extract<
	Binding,
	{ readonly kind: "unary" | "paginated" }
>["operationId"] &
	OperationId

type Shape<Op extends OperationId> = CheckfuOperations[Op]

type PathField<Op extends OperationId> = BindingOf<Op>["pathParams"] extends readonly []
	? { readonly path?: never }
	: { readonly path: PathOf<Shape<Op>> }

type QueryField<Op extends OperationId> = BindingOf<Op>["queryParams"] extends readonly []
	? { readonly query?: never }
	: Record<never, never> extends QueryOf<Shape<Op>>
		? { readonly query?: QueryOf<Shape<Op>> }
		: { readonly query: QueryOf<Shape<Op>> }

type BodyField<Op extends OperationId> = BindingOf<Op>["hasBody"] extends false
	? { readonly body?: never }
	: BindingOf<Op>["bodyRequired"] extends true
		? { readonly body: BodyOf<Shape<Op>> }
		: { readonly body?: BodyOf<Shape<Op>> }

type KeyField<Op extends OperationId> = BindingOf<Op>["requiresIdempotencyKey"] extends true
	? { readonly idempotencyKey: string }
	: BindingOf<Op>["supportsIdempotencyKey"] extends true
		? { readonly idempotencyKey?: string }
		: { readonly idempotencyKey?: never }

export type UrlInput<Op extends OperationId> = PathField<Op> &
	QueryField<Op> & {
		readonly body?: never
		readonly idempotencyKey?: never
		readonly signal?: never
	}

export type FetchInput<Op extends JsonOperationId> = PathField<Op> &
	QueryField<Op> &
	BodyField<Op> &
	KeyField<Op> & { readonly signal?: AbortSignal }

export type FetchResult<Op extends JsonOperationId> = JsonResultOf<Shape<Op>>

type OptionalWhenEmpty<Input> =
	Record<never, never> extends Input ? [input?: Input] : [input: Input]

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (
	value: infer I,
) => void
	? I
	: never

type IsUnion<T> = [T] extends [UnionToIntersection<T>] ? false : true

export type FetchInputArgs<Op extends JsonOperationId> =
	IsUnion<Op> extends true ? [input: never] : OptionalWhenEmpty<FetchInput<Op>>

export type UrlInputArgs<Op extends OperationId> =
	IsUnion<Op> extends true ? [input: never] : OptionalWhenEmpty<UrlInput<Op>>

export type FetchClient = <Op extends JsonOperationId>(
	operationId: Op,
	...input: FetchInputArgs<Op>
) => Promise<FetchResult<Op>>

export class CheckfuFetchError extends Error {
	readonly status: number
	readonly type: string | null

	constructor(status: number, type: string | null, message: string) {
		super(message)
		this.name = "CheckfuFetchError"
		this.status = status
		this.type = type
	}
}

export interface FetchClientOptions {
	readonly fetch?: typeof globalThis.fetch
	readonly headers?: HeadersInit
}

type QueryValue = string | number | boolean | null | undefined

interface RawInput {
	readonly path?: Readonly<Record<string, string | number>>
	readonly query?: Readonly<Record<string, QueryValue>>
	readonly body?: unknown
	readonly idempotencyKey?: string
	readonly signal?: AbortSignal
}

interface ErrorEnvelope {
	readonly error?: { readonly type?: unknown; readonly message?: unknown }
}

const bindings: ReadonlyMap<string, Binding> = new Map(
	SDK_OPERATION_BINDINGS.map((binding) => [binding.operationId, binding]),
)

const bindingOf = (operationId: string): Binding => {
	const binding = bindings.get(operationId)
	if (binding === undefined) {
		throw new Error(`Unknown operation ${operationId}.`)
	}
	return binding
}

const undeclaredIn = <Value>(
	supplied: Readonly<Record<string, Value>> | undefined,
	declared: ReadonlyArray<string>,
): ReadonlyArray<string> => Object.keys(supplied ?? {}).filter((name) => !declared.includes(name))

const urlOf = (binding: Binding, input: RawInput): string => {
	const extraPath = undeclaredIn(input.path, binding.pathParams)
	if (extraPath.length > 0) {
		throw new Error(`${binding.operationId} takes no path parameter ${extraPath.join(", ")}.`)
	}
	const extraQuery = undeclaredIn(input.query, binding.queryParams)
	if (extraQuery.length > 0) {
		throw new Error(`${binding.operationId} takes no query parameter ${extraQuery.join(", ")}.`)
	}
	const requiredQuery: ReadonlyArray<string> = binding.requiredQueryParams
	const missingQuery = requiredQuery.filter(
		(name) => input.query?.[name] === undefined || input.query[name] === null,
	)
	if (missingQuery.length > 0) {
		throw new Error(`Missing ${missingQuery.join(", ")} for ${binding.operationId}.`)
	}
	const path = binding.pathParams.reduce<string>((url, name) => {
		const value = input.path?.[name]
		if (value === undefined) {
			throw new Error(`Missing ${name} for ${binding.operationId}.`)
		}
		if (!isSinglePathSegment(String(value))) {
			throw new Error(`Invalid ${name}: ${SINGLE_PATH_SEGMENT_MESSAGE}.`)
		}
		return url.replace(`{${name}}`, encodeURIComponent(String(value)))
	}, binding.path)
	const search = new URLSearchParams(
		Object.entries(input.query ?? {}).flatMap(([name, value]) =>
			value === undefined || value === null ? [] : [[name, String(value)]],
		),
	).toString()
	return search === "" ? path : `${path}?${search}`
}

export const operationUrl = <Op extends OperationId>(
	operationId: Op,
	...[input]: UrlInputArgs<Op>
): string => urlOf(bindingOf(operationId), input ?? {})

export const createFetchClient = (options: FetchClientOptions = {}): FetchClient => {
	const send = options.fetch ?? globalThis.fetch.bind(globalThis)
	const defaults = new Headers(options.headers)
	if (defaults.has("idempotency-key")) {
		throw new Error(
			"An idempotency key identifies one request; pass idempotencyKey with each call, not in the client's headers.",
		)
	}
	return async (operationId, ...[input]) => {
		const binding = bindingOf(operationId)
		if (binding.kind === "sse") {
			throw new Error(
				`${operationId} streams events; open operationUrl("${operationId}") with an EventSource.`,
			)
		}
		const fields: RawInput = input ?? {}
		const headers = new Headers(defaults)
		if (fields.idempotencyKey !== undefined) {
			if (!binding.supportsIdempotencyKey) {
				throw new Error(
					`${operationId} takes no idempotency key; retrying it with one would not prevent a duplicate.`,
				)
			}
			if (!isClientEventId(fields.idempotencyKey)) {
				throw new Error(`Invalid idempotencyKey: ${CLIENT_EVENT_ID_MESSAGE}.`)
			}
			headers.set("idempotency-key", fields.idempotencyKey)
		} else if (binding.requiresIdempotencyKey) {
			throw new Error(`${operationId} needs an idempotency key.`)
		}
		if (!binding.hasBody && fields.body !== undefined) {
			throw new Error(`${operationId} takes no body.`)
		}
		if (binding.bodyRequired && fields.body === undefined) {
			throw new Error(`${operationId} needs a body.`)
		}
		if (fields.body !== undefined) {
			headers.set("content-type", "application/json")
		}
		const response = await send(urlOf(binding, fields), {
			method: binding.httpMethod,
			headers,
			...(fields.signal === undefined ? {} : { signal: fields.signal }),
			...(fields.body === undefined ? {} : { body: JSON.stringify(fields.body) }),
		})
		if (!response.ok) {
			const envelope = await response
				.text()
				.then((text) => parseJsonAs<ErrorEnvelope | null>(text) ?? {})
				.catch((): ErrorEnvelope => ({}))
			throw new CheckfuFetchError(
				response.status,
				typeof envelope.error?.type === "string" ? envelope.error.type : null,
				typeof envelope.error?.message === "string"
					? envelope.error.message
					: `Request failed with status ${response.status}.`,
			)
		}
		const text = await response.text()
		if (text === "") {
			throw new Error(`${operationId} answered ${response.status} with an empty body.`)
		}
		return parseJsonAs<FetchResult<typeof operationId>>(text)
	}
}
