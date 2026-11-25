import { parseJsonAs } from "./Boundary.ts"
import { SDK_OPERATION_BINDINGS } from "./generated/OperationBindings.ts"
import type { CheckfuOperations } from "./generated/Resources.ts"
import type { BodyOf, JsonResultOf, PathOf, QueryOf } from "./Runtime.ts"

export type OperationId = keyof CheckfuOperations

type Field<K extends string, T> = [T] extends [never]
	? Record<never, never>
	: Record<never, never> extends T
		? { readonly [P in K]?: T }
		: { readonly [P in K]: T }

export type FetchInput<Op extends OperationId> = Field<"path", PathOf<CheckfuOperations[Op]>> &
	Field<"query", QueryOf<CheckfuOperations[Op]>> &
	Field<"body", BodyOf<CheckfuOperations[Op]>> & {
		readonly idempotencyKey?: string
		readonly signal?: AbortSignal
	}

export type FetchResult<Op extends OperationId> = JsonResultOf<CheckfuOperations[Op]>

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
	readonly baseUrl?: string
	readonly fetch?: typeof globalThis.fetch
	readonly headers?: HeadersInit
}

export type FetchClient = <Op extends OperationId>(
	operationId: Op,
	...input: Record<never, never> extends FetchInput<Op>
		? [input?: FetchInput<Op>]
		: [input: FetchInput<Op>]
) => Promise<FetchResult<Op>>

type QueryValue = string | number | boolean | null | undefined

interface ErrorEnvelope {
	readonly error?: { readonly type?: unknown; readonly message?: unknown }
}

const bindings = new Map(SDK_OPERATION_BINDINGS.map((binding) => [binding.operationId, binding]))

export const operationUrl = (
	operationId: OperationId,
	path: Readonly<Record<string, string | number>> = {},
	query: Readonly<Record<string, QueryValue>> = {},
): string => {
	const binding = bindings.get(operationId)
	if (binding === undefined) {
		throw new Error(`Unknown operation ${operationId}.`)
	}
	const resolved = Object.entries(path).reduce(
		(url, [name, value]) => url.replace(`{${name}}`, encodeURIComponent(String(value))),
		binding.path,
	)
	const search = new URLSearchParams(
		Object.entries(query).flatMap(([name, value]) =>
			value === undefined || value === null ? [] : [[name, String(value)]],
		),
	).toString()
	return search === "" ? resolved : `${resolved}?${search}`
}

export const createFetchClient = (options: FetchClientOptions = {}): FetchClient => {
	const send = options.fetch ?? globalThis.fetch.bind(globalThis)
	const base = options.baseUrl ?? ""
	return async (operationId, ...[input]) => {
		const binding = bindings.get(operationId)
		if (binding === undefined) {
			throw new Error(`Unknown operation ${operationId}.`)
		}
		const fields: {
			readonly path?: Readonly<Record<string, string | number>>
			readonly query?: Readonly<Record<string, QueryValue>>
			readonly body?: unknown
			readonly idempotencyKey?: string
			readonly signal?: AbortSignal
		} = input ?? {}
		const headers = new Headers(options.headers)
		if (fields.body !== undefined) {
			headers.set("content-type", "application/json")
		}
		if (fields.idempotencyKey !== undefined) {
			headers.set("idempotency-key", fields.idempotencyKey)
		}
		const response = await send(`${base}${operationUrl(operationId, fields.path, fields.query)}`, {
			method: binding.httpMethod,
			headers,
			...(fields.signal === undefined ? {} : { signal: fields.signal }),
			...(fields.body === undefined ? {} : { body: JSON.stringify(fields.body) }),
		})
		const text = await response.text()
		if (!response.ok) {
			const envelope = ((): ErrorEnvelope => {
				try {
					return parseJsonAs<ErrorEnvelope>(text) ?? {}
				} catch {
					return {}
				}
			})()
			throw new CheckfuFetchError(
				response.status,
				typeof envelope.error?.type === "string" ? envelope.error.type : null,
				typeof envelope.error?.message === "string"
					? envelope.error.message
					: `Request failed with status ${response.status}.`,
			)
		}
		return parseJsonAs<FetchResult<typeof operationId>>(text)
	}
}
