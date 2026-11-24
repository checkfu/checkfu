import { CheckfuApi } from "@checkfu/sdk/Api"
import type { ApiError } from "@checkfu/sdk/Api"
import { APIConnectionError } from "@checkfu/sdk/Errors"
import type { ApiSseError } from "@checkfu/sdk/Sse"
import { validatePathSegment as sdkValidatePathSegment } from "@checkfu/sdk/Transport"
import type * as Command from "effect/cli/Command"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientError from "effect/http/HttpClientError"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Option from "effect/Option"
import type * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import type * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { formatClientError, isApiErrorEnvelope, usageError } from "./Errors.ts"
import type { CliFailure } from "./Errors.ts"
import { diagnoseSessionCreateNotFound, ensureIdempotencyKeyHeader } from "./Hooks.ts"
import {
	emitYamlWarnings,
	isPlainRecord,
	parseJsonOrYamlDocument,
	readPipedStdin,
	readPipedStdinRecord,
	resolveStructuredInput,
	resolveTextOrFile,
} from "./Input.ts"
import type { StructuredRecord, StructuredValue } from "./Input.ts"
import { getClient, renderOutput } from "./RootCommand.ts"

export interface GeneratedFlagDescriptor {
	readonly propName: string
	readonly flagName: string
	readonly wireName: string
	readonly location: "path" | "query" | "header" | "body"
	readonly kind:
		| "string"
		| "int"
		| "boolean"
		| "literals"
		| "file-text"
		| "text-or-object"
		| "structured"
		| "repeat-structured"
	readonly required: boolean
	readonly min?: number
	readonly max?: number
}

export interface GeneratedOperationDescriptor {
	readonly cliLabel: string
	readonly apiGroup: string
	readonly apiEndpoint: string
	readonly hasBody: boolean
	readonly flags: ReadonlyArray<GeneratedFlagDescriptor>
}

type CheckfuApiGroup = (typeof CheckfuApi.groups)[keyof typeof CheckfuApi.groups]
type EndpointValues<G> = G extends { readonly endpoints: infer E } ? E[keyof E] : never
type CheckfuApiEndpoint = EndpointValues<CheckfuApiGroup>

const lookupEndpoint = (
	groupName: string,
	endpointName: string,
): Effect.Effect<CheckfuApiEndpoint, CliFailure> => {
	for (const [name, group] of Object.entries(CheckfuApi.groups)) {
		if (name !== groupName) {
			continue
		}
		const endpoints: Readonly<Record<string, CheckfuApiEndpoint>> = group.endpoints
		const endpoint = endpoints[endpointName]
		if (endpoint !== undefined) {
			return Effect.succeed(endpoint)
		}
	}
	return Effect.fail(usageError(`Unknown CheckfuApi endpoint ${groupName}.${endpointName}.`))
}

const validatePathSegment = (value: string, label: string): Effect.Effect<string, CliFailure> => {
	const err = sdkValidatePathSegment(value, label)
	return err === undefined ? Effect.succeed(value) : Effect.fail(usageError(err))
}

const decodeWithTop = (
	schema: Schema.Top,
	raw: unknown,
	label: string,
	options?: { readonly onExcessProperty?: "ignore" | "error" },
): Effect.Effect<unknown, CliFailure> =>
	Schema.decodeUnknownEffect(schema as Schema.Codec<unknown, unknown, never, unknown>)(
		raw,
		options,
	).pipe(Effect.mapError((err) => usageError(`Invalid ${label}: ${err.message}`)))

const parseTextOrObjectFlag = (
	raw: string,
	flagName: string,
): Effect.Effect<StructuredValue, CliFailure, FileSystem.FileSystem | Stdio.Stdio> =>
	Effect.gen(function* () {
		const isFile = raw.startsWith("@") && !raw.startsWith("@@") && raw.length > 1
		const text = yield* resolveTextOrFile(raw)
		const trimmed = text.trim()
		const structuredSyntax =
			trimmed.startsWith("{") || trimmed.includes("\n") || /:(?:\s|$)/.test(trimmed)
		const parsedResult = yield* Effect.result(parseJsonOrYamlDocument(trimmed, `--${flagName}`))
		if (parsedResult._tag === "Success") {
			const parsed = parsedResult.success
			if (isPlainRecord(parsed.value)) {
				yield* emitYamlWarnings(`--${flagName}`, parsed.warnings)
				return parsed.value
			}
			if (trimmed.startsWith("{") || trimmed.includes("\n")) {
				yield* emitYamlWarnings(`--${flagName}`, parsed.warnings)
				return parsed.value
			}
			return isFile ? trimmed : text
		}
		if (structuredSyntax) {
			return yield* parsedResult.failure
		}
		return isFile ? trimmed : text
	})

type RawFlagValue =
	| string
	| number
	| boolean
	| ReadonlyArray<string>
	| Option.Option<string | number | boolean>
type RawFlagsRecord = Readonly<Record<string, RawFlagValue>>

interface RequestParts {
	readonly params: Record<string, string>
	readonly query: Record<string, string>
	readonly headers: Record<string, string>
	readonly body: StructuredRecord | undefined
}

const unwrapFlagValue = (
	raw: RawFlagValue | undefined,
): Option.Option<string | number | boolean | ReadonlyArray<string>> =>
	raw === undefined ? Option.none() : Option.isOption(raw) ? raw : Option.some(raw)

const collectRequestParts = (
	spec: GeneratedOperationDescriptor,
	rawFlags: RawFlagsRecord,
): Effect.Effect<RequestParts, CliFailure, FileSystem.FileSystem | Stdio.Stdio> =>
	Effect.gen(function* () {
		const params: Record<string, string> = {}
		const query: Record<string, string> = {}
		const headers: Record<string, string> = {}
		let body: StructuredRecord | undefined

		const repeatFlag = spec.flags.find((fl) => fl.kind === "repeat-structured")
		if (spec.hasBody) {
			if (repeatFlag !== undefined) {
				const rawList = rawFlags[repeatFlag.propName]
				const items = Array.isArray(rawList) ? rawList : []
				const stdinVal = yield* readPipedStdin
				if (items.length > 0 && Option.isSome(stdinVal)) {
					return yield* usageError(
						`Provide ${repeatFlag.wireName} via either --${repeatFlag.flagName} or stdin, not both.`,
					)
				}
				if (items.length > 0) {
					const parsed: Array<StructuredValue> = []
					for (const [index, entry] of items.entries()) {
						parsed.push(
							yield* resolveStructuredInput(String(entry), `--${repeatFlag.flagName}[${index}]`),
						)
					}
					body = { [repeatFlag.wireName]: parsed }
				} else if (Option.isSome(stdinVal)) {
					const val = stdinVal.value
					if (Array.isArray(val)) {
						body = { [repeatFlag.wireName]: val }
					} else if (isPlainRecord(val) && repeatFlag.wireName in val) {
						body = { ...val }
					} else if (isPlainRecord(val) && "type" in val) {
						body = { [repeatFlag.wireName]: [val] }
					} else if (isPlainRecord(val) && !repeatFlag.required) {
						body = { ...val }
					} else {
						return yield* usageError(
							`Expected stdin to be { ${repeatFlag.wireName}: [...] }, an array, or a single item object.`,
						)
					}
				} else if (repeatFlag.required) {
					return yield* usageError(
						`Provide at least one item via --${repeatFlag.flagName} or stdin.`,
					)
				} else {
					body = {}
				}
			} else {
				body = { ...(yield* readPipedStdinRecord(spec.cliLabel)) }
			}
		}

		for (const fl of spec.flags) {
			if (fl.kind === "repeat-structured") {
				continue
			}
			const maybeVal = unwrapFlagValue(rawFlags[fl.propName])
			if (Option.isNone(maybeVal)) {
				continue
			}
			const value = maybeVal.value

			if (fl.kind === "int" && typeof value === "number") {
				if (fl.min !== undefined && value < fl.min) {
					return yield* usageError(`--${fl.flagName} must be an integer >= ${fl.min}.`)
				}
				if (fl.max !== undefined && value > fl.max) {
					return yield* usageError(
						`--${fl.flagName} must be an integer between ${fl.min ?? 0} and ${fl.max}.`,
					)
				}
			}

			if (fl.location === "path") {
				params[fl.wireName] = yield* validatePathSegment(String(value), `--${fl.flagName}`)
				continue
			}
			if (fl.location === "query") {
				query[fl.wireName] = String(value)
				continue
			}
			if (fl.location === "header") {
				headers[fl.wireName] = String(value)
				continue
			}
			if (body !== undefined) {
				if (fl.kind === "file-text") {
					body[fl.wireName] = yield* resolveTextOrFile(String(value))
				} else if (fl.kind === "text-or-object") {
					body[fl.wireName] = yield* parseTextOrObjectFlag(String(value), fl.flagName)
				} else if (fl.kind === "structured") {
					body[fl.wireName] = yield* resolveStructuredInput(String(value), `--${fl.flagName}`)
				} else {
					body[fl.wireName] = value
				}
			}
		}

		return { params, query, headers, body }
	})

interface RuntimeClientRequest {
	params?: unknown
	query?: unknown
	headers?: unknown
	payload?: unknown
}

type UntypedClientMethod = (
	req: RuntimeClientRequest,
) => Effect.Effect<unknown, ApiError | HttpClientError.HttpClientError | Schema.SchemaError>

export const invokeGeneratedOperation = (
	spec: GeneratedOperationDescriptor,
	rawFlags: RawFlagsRecord,
): Effect.Effect<
	void,
	CliFailure,
	| Command.CommandContext<"checkfu">
	| FileSystem.FileSystem
	| Path.Path
	| HttpClient.HttpClient
	| SecureRandom.SecureRandom
	| Stdio.Stdio
> =>
	Effect.gen(function* () {
		const endpoint = yield* lookupEndpoint(spec.apiGroup, spec.apiEndpoint)
		const parts = yield* collectRequestParts(spec, rawFlags)

		const request: RuntimeClientRequest = {}
		if (endpoint.params !== undefined) {
			request.params = yield* decodeWithTop(
				endpoint.params,
				parts.params,
				`${spec.cliLabel} params`,
			)
		}
		if (endpoint.query !== undefined) {
			request.query = yield* decodeWithTop(endpoint.query, parts.query, `${spec.cliLabel} query`)
		}
		if (spec.hasBody) {
			const jsonEntry = endpoint.payload.get("application/json")
			if (jsonEntry !== undefined) {
				const schema =
					jsonEntry.schemas.length === 1 ? jsonEntry.schemas[0] : Schema.Union(jsonEntry.schemas)
				request.payload = yield* decodeWithTop(schema, parts.body, `${spec.cliLabel} payload`, {
					onExcessProperty: "error",
				})
			} else {
				request.payload = parts.body
			}
		}

		const client = yield* getClient

		if (endpoint.headers !== undefined) {
			const effectiveHeaders =
				(spec.apiGroup === "sessions" && spec.apiEndpoint === "sendEvents") ||
				(spec.apiGroup === "automations" && spec.apiEndpoint === "create")
					? yield* ensureIdempotencyKeyHeader(client, parts.headers)
					: parts.headers
			request.headers = yield* decodeWithTop(
				endpoint.headers,
				effectiveHeaders,
				`${spec.cliLabel} headers`,
			)
		}

		const clientGroups = client.api as unknown as Record<
			string,
			Record<string, UntypedClientMethod> | undefined
		>
		const method = clientGroups[spec.apiGroup]?.[spec.apiEndpoint]
		if (method === undefined) {
			return yield* usageError(`Client method ${spec.apiGroup}.${spec.apiEndpoint} is unavailable.`)
		}

		const result = yield* method(request).pipe(
			Effect.catch((error) => {
				if (
					spec.apiGroup === "sessions" &&
					spec.apiEndpoint === "create" &&
					isApiErrorEnvelope(error) &&
					error.error.type === "not_found_error"
				) {
					return Effect.flatMap(
						diagnoseSessionCreateNotFound(client, request.payload, error.error.message),
						Effect.fail,
					)
				}
				return Effect.fail(formatClientError(error))
			}),
		)

		yield* renderOutput(result)
	})

type UntypedStreamMethod = (request: {
	readonly params?: unknown
	readonly query?: unknown
	readonly headers?: unknown
	readonly responseMode: "response-only"
}) => Effect.Effect<HttpClientResponse.HttpClientResponse, ApiSseError>

const decodeGenericStreamJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

export const invokeGeneratedStream = (
	spec: GeneratedOperationDescriptor,
	rawFlags: RawFlagsRecord,
): Effect.Effect<
	void,
	CliFailure,
	| Command.CommandContext<"checkfu">
	| FileSystem.FileSystem
	| Path.Path
	| HttpClient.HttpClient
	| SecureRandom.SecureRandom
	| Stdio.Stdio
> =>
	Effect.gen(function* () {
		const endpoint = yield* lookupEndpoint(spec.apiGroup, spec.apiEndpoint)
		const parts = yield* collectRequestParts(spec, rawFlags)

		const decodedParams =
			endpoint.params !== undefined
				? yield* decodeWithTop(endpoint.params, parts.params, `${spec.cliLabel} params`)
				: undefined
		const decodedQuery =
			endpoint.query !== undefined
				? yield* decodeWithTop(endpoint.query, parts.query, `${spec.cliLabel} query`)
				: undefined
		const decodedHeaders =
			endpoint.headers !== undefined
				? yield* decodeWithTop(endpoint.headers, parts.headers, `${spec.cliLabel} headers`)
				: undefined

		const client = yield* getClient
		if (spec.apiGroup === "sessions" && spec.apiEndpoint === "streamEvents") {
			const sessionId = parts.params["session_id"] ?? ""
			const afterRaw = parts.query["after"]
			const after = afterRaw === undefined ? undefined : Number(afterRaw)
			yield* client
				.streamSessionEvents(sessionId, {
					...(after === undefined ? {} : { after }),
					...(Object.keys(parts.headers).length > 0 ? { headers: parts.headers } : {}),
				})
				.pipe(Stream.runForEach((event) => renderOutput(event, { streaming: true })))
			return
		}

		const clientGroups = client.api as unknown as Record<
			string,
			Record<string, UntypedStreamMethod> | undefined
		>
		const method = clientGroups[spec.apiGroup]?.[spec.apiEndpoint]
		if (method === undefined) {
			return yield* usageError(`Client method ${spec.apiGroup}.${spec.apiEndpoint} is unavailable.`)
		}
		yield* client
			.streamApiSse({
				open: () =>
					method({
						...(decodedParams === undefined ? {} : { params: decodedParams }),
						...(decodedQuery === undefined ? {} : { query: decodedQuery }),
						...(decodedHeaders === undefined ? {} : { headers: decodedHeaders }),
						responseMode: "response-only",
					}),
				decodeEvent: (rawData) =>
					decodeGenericStreamJson(rawData).pipe(
						Effect.mapError(
							(err) =>
								new APIConnectionError({
									message: `Invalid SSE event payload: ${err.message}`,
									cause: err,
								}),
						),
					),
				...(Object.keys(parts.headers).length > 0 ? { options: { headers: parts.headers } } : {}),
			})
			.pipe(Stream.runForEach((event) => renderOutput(event, { streaming: true })))
	})
