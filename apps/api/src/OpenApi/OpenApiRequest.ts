import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import {
	CREDENTIAL_HEADERS,
	HEADER_NAME,
	OpenApiRequestError,
	TRANSPORT_HEADERS,
	isJsonArray,
	isJsonObject,
} from "./OpenApiTypes.ts"
import type { HttpRequestDescription, ParameterSpec, ToolDescriptor } from "./OpenApiTypes.ts"

type Failure = OpenApiRequestError
type Json = Schema.Json | undefined

const fail = (reason: OpenApiRequestError["reason"], message: string, parameter?: string) =>
	Effect.fail(
		new OpenApiRequestError({
			reason,
			message,
			...(parameter === undefined ? {} : { parameter }),
		}),
	)

const own = (record: Schema.JsonObject, key: string): Json =>
	Object.hasOwn(record, key) ? record[key] : undefined

const absent = (value: Json): value is null | undefined => value === undefined || value === null

// encodeURIComponent throws on a lone surrogate, which JSON can carry.
const wellFormed = (text: string, parameter: string): Effect.Effect<string, Failure> =>
	text.isWellFormed()
		? Effect.succeed(text)
		: fail("unsupported_value", `"${parameter}" holds text that is not valid Unicode.`, parameter)

const scalar = (value: Json, parameter: string): Effect.Effect<string, Failure> =>
	typeof value === "string" ||
	typeof value === "boolean" ||
	(typeof value === "number" && Number.isFinite(value))
		? wellFormed(String(value), parameter)
		: fail("unsupported_value", `"${parameter}" takes text, numbers or booleans.`, parameter)

const scalars = (value: Json, parameter: string): Effect.Effect<Array<string>, Failure> =>
	isJsonArray(value)
		? Effect.forEach(value, (item) => scalar(item, parameter))
		: Effect.map(scalar(value, parameter), (item) => [item])

// A parameter described by a JSON media type is sent as its JSON text, in any location.
const serialized = (spec: ParameterSpec, value: Json): Effect.Effect<Array<string>, Failure> =>
	spec.style === "json"
		? Effect.map(wellFormed(JSON.stringify(value), spec.name), (text) => [text])
		: scalars(value, spec.name)

const group = (
	args: Schema.JsonObject,
	key: string,
	declared: ReadonlyArray<ParameterSpec>,
): Effect.Effect<Schema.JsonObject, Failure> => {
	const value = own(args, key)
	if (value === undefined) {
		return Effect.succeed({})
	}
	if (!isJsonObject(value)) {
		return fail("invalid_arguments", `"${key}" must be an object.`)
	}
	const unknown = Object.keys(value).find(
		(name) =>
			!declared.some((spec) => spec.name === name) &&
			!(key === "headers" && CREDENTIAL_HEADERS.has(name.toLowerCase())),
	)
	return unknown === undefined
		? Effect.succeed(value)
		: fail(
				"invalid_arguments",
				`"${unknown}" is not one of this tool's ${key} parameters.`,
				unknown,
			)
}

const queryPairs = (spec: ParameterSpec, value: Json): Effect.Effect<Array<string>, Failure> =>
	Effect.gen(function* () {
		const key = encodeURIComponent(yield* wellFormed(spec.name, spec.name))
		if (spec.style === "json") {
			return [`${key}=${encodeURIComponent(JSON.stringify(value))}`]
		}
		if (isJsonObject(value)) {
			const members = yield* Effect.forEach(Object.entries(value), ([name, member]) =>
				Effect.zip(wellFormed(name, spec.name), scalar(member, spec.name)),
			)
			if (spec.style === "deepObject") {
				return members.map(
					([name, text]) =>
						`${encodeURIComponent(`${spec.name}[${name}]`)}=${encodeURIComponent(text)}`,
				)
			}
			if (spec.style !== "form") {
				return yield* fail(
					"unsupported_value",
					`"${spec.name}" does not take an object.`,
					spec.name,
				)
			}
			return spec.explode
				? members.map(([name, text]) => `${encodeURIComponent(name)}=${encodeURIComponent(text)}`)
				: [`${key}=${members.flat().map(encodeURIComponent).join(",")}`]
		}
		if (spec.style === "deepObject") {
			return yield* fail("unsupported_value", `"${spec.name}" takes an object.`, spec.name)
		}
		const values = (yield* scalars(value, spec.name)).map(encodeURIComponent)
		if (!isJsonArray(value) || spec.explode) {
			return values.map((text) => `${key}=${text}`)
		}
		const separator =
			spec.style === "spaceDelimited" ? "%20" : spec.style === "pipeDelimited" ? "%7C" : ","
		return [`${key}=${values.join(separator)}`]
	})

const isHeaderText = (text: string): boolean => {
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index)
		if (code !== 9 && (code < 32 || code === 127 || code > 255)) {
			return false
		}
	}
	return true
}

const parseBase = (baseUrl: string): Effect.Effect<URL, Failure> => {
	const base = URL.canParse(baseUrl) ? new URL(baseUrl) : undefined
	return base === undefined ||
		(base.protocol !== "https:" && base.protocol !== "http:") ||
		base.username !== "" ||
		base.password !== "" ||
		base.search !== "" ||
		base.hash !== ""
		? fail(
				"invalid_base_url",
				"The base URL must be an http or https URL without credentials, query or fragment.",
			)
		: Effect.succeed(base)
}

/**
 * Turns a tool call into the request to send. It sends only what the
 * descriptor declares, never a credential: whoever sends the request attaches
 * those. The URL always stays on the base URL's origin and under its path.
 */
export const buildRequest = (
	descriptor: ToolDescriptor,
	args: Schema.Json | undefined,
	baseUrl: string,
): Effect.Effect<HttpRequestDescription, OpenApiRequestError> =>
	Effect.gen(function* () {
		const base = yield* parseBase(baseUrl)
		const input = args ?? {}
		if (!isJsonObject(input)) {
			return yield* fail("invalid_arguments", "The arguments must be an object.")
		}
		const body = own(input, "body")
		const stray = Object.keys(input).find(
			(key) => key !== "path" && key !== "query" && key !== "headers" && key !== "body",
		)
		if (stray !== undefined || (descriptor.body === undefined && body !== undefined)) {
			return yield* fail(
				"invalid_arguments",
				`"${stray ?? "body"}" is not part of this tool's arguments.`,
			)
		}
		const declared = (location: ParameterSpec["in"]) =>
			descriptor.parameters.filter((spec) => spec.in === location)
		const pathArgs = yield* group(input, "path", declared("path"))
		const queryArgs = yield* group(input, "query", declared("query"))
		const headerArgs = yield* group(input, "headers", declared("header"))

		if (!descriptor.pathTemplate.startsWith("/")) {
			return yield* fail("unsafe_path", "The path template must start with a slash.")
		}
		const pathSpecs = new Map(declared("path").map((spec) => [spec.name, spec]))
		const segments = new Map<string, string>()
		for (const [, name = ""] of descriptor.pathTemplate.matchAll(/\{([^{}]*)\}/g)) {
			const value = own(pathArgs, name)
			if (absent(value)) {
				return yield* fail("missing_argument", `The path parameter "${name}" is required.`, name)
			}
			const spec = pathSpecs.get(name)
			const text = (yield* spec === undefined ? scalars(value, name) : serialized(spec, value))
				.map(encodeURIComponent)
				.join(",")
			if (text === "") {
				return yield* fail("unsafe_path", `The path parameter "${name}" cannot be empty.`, name)
			}
			segments.set(name, text)
		}
		const prefix = base.pathname.replace(/\/+$/, "")
		const path = `${prefix}${descriptor.pathTemplate.replaceAll(
			/\{([^{}]*)\}/g,
			(_match, name: string) => segments.get(name) ?? "",
		)}`
		const target = `${base.origin}${path}`
		const url = URL.canParse(target) ? new URL(target) : undefined
		// The parser resolves dot segments and treats a backslash as a slash. Either would change how
		// many segments the path has, or empty one that was not empty.
		const expected = path.split("/")
		const parsed = url?.pathname.split("/") ?? []
		if (
			url === undefined ||
			url.origin !== base.origin ||
			url.search !== "" ||
			url.hash !== "" ||
			parsed.length !== expected.length ||
			parsed.some((segment, index) => (segment === "") !== (expected[index] === "")) ||
			!url.pathname.startsWith(`${prefix}/`)
		) {
			return yield* fail("unsafe_path", "The arguments do not fit this tool's path.")
		}

		const query: Array<string> = []
		for (const spec of declared("query")) {
			const value = own(queryArgs, spec.name)
			if (!absent(value)) {
				query.push(...(yield* queryPairs(spec, value)))
			} else if (spec.required) {
				return yield* fail(
					"missing_argument",
					`The query parameter "${spec.name}" is required.`,
					spec.name,
				)
			}
		}
		url.search = query.join("&")

		const headers = new Map<string, string>()
		for (const spec of declared("header")) {
			const name = spec.name.toLowerCase()
			if (CREDENTIAL_HEADERS.has(name) || TRANSPORT_HEADERS.has(name)) {
				continue
			}
			const value = own(headerArgs, spec.name)
			if (absent(value)) {
				if (spec.required) {
					return yield* fail(
						"missing_argument",
						`The header "${spec.name}" is required.`,
						spec.name,
					)
				}
				continue
			}
			const text = (yield* serialized(spec, value)).join(",")
			if (!HEADER_NAME.test(spec.name) || !isHeaderText(text)) {
				return yield* fail(
					"unsupported_value",
					`The header "${spec.name}" holds characters a header cannot carry.`,
					spec.name,
				)
			}
			headers.set(name, text)
		}

		if (descriptor.body !== undefined && body === undefined && descriptor.body.required) {
			return yield* fail("missing_argument", "This tool requires a body.", "body")
		}
		if (descriptor.body !== undefined && body !== undefined) {
			headers.set("content-type", descriptor.body.contentType)
		}

		return {
			method: descriptor.method.toUpperCase(),
			url: url.href,
			headers: Object.fromEntries(headers),
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}
	})
