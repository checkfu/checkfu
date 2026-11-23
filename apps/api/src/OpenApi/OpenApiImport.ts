import * as Effect from "effect/Effect"
import type * as JsonSchema from "effect/JsonSchema"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import { dereference, loadDocument } from "./OpenApiDocument.ts"
import { makeSchemaBundler, truncate } from "./OpenApiSchemas.ts"
import type { ConvertedSchema } from "./OpenApiSchemas.ts"
import {
	CREDENTIAL_HEADERS,
	DEFAULT_OPENAPI_LIMITS,
	HEADER_NAME,
	HTTP_METHODS,
	MAX_TOOL_NAME_LENGTH,
	OpenApiImportError,
	READ_ONLY_METHODS,
	TRANSPORT_HEADERS,
	isJsonArray,
	isJsonObject,
} from "./OpenApiTypes.ts"
import type {
	HttpMethod,
	OpenApiLimits,
	OperationSummary,
	ParameterSpec,
	ParameterStyle,
	SecurityScheme,
	SkippedOperation,
	ToolDescriptor,
} from "./OpenApiTypes.ts"

export interface OpenApiSelection {
	readonly names?: ReadonlyArray<string>
	readonly tags?: ReadonlyArray<string>
}

export interface OpenApiImportOptions {
	/** Keep only operations with one of these names or tags. */
	readonly include?: OpenApiSelection
	/** Then drop operations with one of these names or tags. */
	readonly exclude?: OpenApiSelection
	readonly limits?: Partial<OpenApiLimits>
}

export interface OpenApiCatalog {
	readonly title: string
	readonly version: string
	/** Server URLs as the document gives them: possibly relative, possibly with `{variables}`. */
	readonly servers: ReadonlyArray<string>
	readonly security: ReadonlyArray<SecurityScheme>
	readonly operations: ReadonlyArray<OperationSummary>
	readonly skipped: ReadonlyArray<SkippedOperation>
	/** Built on each call: its schemas share the document's definitions instead of copying them. */
	readonly descriptor: (name: string) => Option.Option<ToolDescriptor>
}

interface Parameter {
	readonly spec: ParameterSpec
	readonly schema: Schema.Json | undefined
	readonly description: string | undefined
}

interface Body {
	readonly contentType: string
	readonly required: boolean
	readonly schema: Schema.Json | undefined
}

interface Operation {
	readonly summary: OperationSummary
	readonly parameters: ReadonlyArray<Parameter>
	readonly body: Body | undefined
	readonly responses: Schema.Json | undefined
}

interface Skip {
	readonly skip: string
}

interface Shape {
	readonly parameters: ReadonlyArray<Parameter>
	readonly body: Body | undefined
}

const MAX_SKIPPED = 100
const JSON_MEDIA_TYPE = /^application\/(?:[\w.-]+\+)?json$/i

const text = (value: Schema.Json | undefined): string | undefined =>
	typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined

const identifier = (value: string): string =>
	value.replaceAll(/[^A-Za-z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "")

// Spelled out so a tool's name never changes with a dependency upgrade.
const fnv1a = (value: string): string => {
	let hash = 0x81_1c_9d_c5
	for (let index = 0; index < value.length; index += 1) {
		hash = Math.imul(hash ^ value.charCodeAt(index), 0x01_00_01_93)
	}
	return (hash >>> 0).toString(16).padStart(8, "0")
}

const nameOperations = (
	entries: ReadonlyArray<{
		readonly method: string
		readonly path: string
		readonly operationId: Schema.Json | undefined
	}>,
): Array<string> => {
	const taken = new Set<string>()
	return entries.map(({ method, path, operationId }) => {
		const fromId = typeof operationId === "string" ? identifier(operationId) : ""
		const chosen = /[A-Za-z]/.test(fromId) ? fromId : identifier(`${method}_${path}`)
		const base = /^[0-9]/.test(chosen) ? `_${chosen}` : chosen
		const hash = fnv1a(`${method} ${path}`)
		let name =
			base.length <= MAX_TOOL_NAME_LENGTH && !taken.has(base)
				? base
				: `${base.slice(0, MAX_TOOL_NAME_LENGTH - 9)}_${hash}`
		for (let attempt = 2; taken.has(name); attempt += 1) {
			const suffix = `_${hash}_${attempt}`
			name = `${base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`
		}
		taken.add(name)
		return name
	})
}

const jsonMedia = (content: Schema.Json | undefined) => {
	if (!isJsonObject(content)) {
		return undefined
	}
	const types = Object.keys(content)
		.map((key) => ({ key, type: (key.split(";")[0] ?? "").trim().toLowerCase() }))
		.filter(({ type }) => JSON_MEDIA_TYPE.test(type))
	const chosen = types.find(({ type }) => type === "application/json") ?? types[0]
	if (chosen === undefined) {
		return undefined
	}
	const media = content[chosen.key]
	return { contentType: chosen.type, schema: isJsonObject(media) ? media["schema"] : undefined }
}

const parameterStyle = (
	location: ParameterSpec["in"],
	style: Schema.Json | undefined,
): ParameterStyle | undefined => {
	if (style === undefined) {
		return location === "query" ? "form" : "simple"
	}
	if (location === "query") {
		return style === "form" ||
			style === "spaceDelimited" ||
			style === "pipeDelimited" ||
			style === "deepObject"
			? style
			: undefined
	}
	return style === "simple" ? "simple" : undefined
}

const selects = (selection: OpenApiSelection, name: string, tags: ReadonlyArray<string>) =>
	(selection.names?.includes(name) ?? false) ||
	(selection.tags?.some((tag) => tags.includes(tag)) ?? false)

export const importOpenApi = (
	input: string | Schema.JsonObject,
	options: OpenApiImportOptions = {},
): Effect.Effect<OpenApiCatalog, OpenApiImportError> =>
	Effect.gen(function* () {
		const limits = { ...DEFAULT_OPENAPI_LIMITS, ...options.limits }
		const document = yield* loadDocument(input, limits)
		const { root } = document
		const bundler = makeSchemaBundler(document, limits)

		const components = isJsonObject(root["components"]) ? root["components"] : {}
		const schemes = isJsonObject(components["securitySchemes"]) ? components["securitySchemes"] : {}
		const security = Object.entries(schemes).flatMap(([id, raw]): Array<SecurityScheme> => {
			const scheme = dereference(root, raw)
			const type = scheme?.["type"]
			if (scheme === undefined || typeof type !== "string") {
				return []
			}
			const location = scheme["in"]
			const name = text(scheme["name"])
			const httpScheme = text(scheme["scheme"])
			return [
				{
					id,
					type,
					...(location === "header" || location === "query" || location === "cookie"
						? { in: location }
						: {}),
					...(name === undefined ? {} : { name }),
					...(httpScheme === undefined ? {} : { scheme: httpScheme }),
				},
			]
		})
		const credentialHeaders = new Set([
			...CREDENTIAL_HEADERS,
			...security.flatMap((scheme) =>
				scheme.in === "header" && scheme.name !== undefined ? [scheme.name.toLowerCase()] : [],
			),
		])
		const credentialQueries = new Set(
			security.flatMap((scheme) =>
				scheme.in === "query" && scheme.name !== undefined ? [scheme.name] : [],
			),
		)

		const readParameters = (
			pathItem: Schema.JsonObject,
			operation: Schema.JsonObject,
			pathTemplate: string,
		): ReadonlyArray<Parameter> | Skip => {
			const declared = new Map<string, Schema.JsonObject>()
			for (const list of [pathItem["parameters"], operation["parameters"]]) {
				for (const raw of isJsonArray(list) ? list : []) {
					const parameter = dereference(root, raw)
					if (parameter !== undefined) {
						declared.set(`${String(parameter["in"])}:${String(parameter["name"])}`, parameter)
					}
				}
			}
			const variables = new Set(
				[...pathTemplate.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] ?? ""),
			)
			const parameters: Array<Parameter> = []
			for (const parameter of declared.values()) {
				const location = parameter["in"]
				const name = parameter["name"]
				if (
					typeof name !== "string" ||
					(location !== "path" && location !== "query" && location !== "header") ||
					(location === "path" && !variables.has(name))
				) {
					continue
				}
				const lower = name.toLowerCase()
				if (
					(location === "header" &&
						(credentialHeaders.has(lower) || TRANSPORT_HEADERS.has(lower))) ||
					(location === "query" && credentialQueries.has(name))
				) {
					continue
				}
				const required = location === "path" || parameter["required"] === true
				const media = jsonMedia(parameter["content"])
				const style =
					parameter["schema"] === undefined && media !== undefined
						? "json"
						: parameterStyle(location, parameter["style"])
				if (
					style === undefined ||
					(parameter["schema"] === undefined && media === undefined) ||
					(location === "header" && !HEADER_NAME.test(name))
				) {
					if (required) {
						return {
							skip: `The ${location} parameter "${name}" is sent in a way that is not supported.`,
						}
					}
					continue
				}
				parameters.push({
					spec: {
						name,
						in: location,
						required,
						style,
						explode:
							typeof parameter["explode"] === "boolean" ? parameter["explode"] : style === "form",
					},
					schema: parameter["schema"] ?? media?.schema,
					description: text(parameter["description"]),
				})
				if (location === "path") {
					variables.delete(name)
				}
			}
			for (const name of variables) {
				parameters.push({
					spec: { name, in: "path", required: true, style: "simple", explode: false },
					schema: { type: "string" },
					description: undefined,
				})
			}
			return parameters
		}

		const readShape = (
			path: string,
			pathItem: Schema.JsonObject,
			operation: Schema.JsonObject,
		): Shape | Skip => {
			if (!path.startsWith("/") || /[?#]/.test(path)) {
				return { skip: "The path is not a plain path template." }
			}
			const parameters = readParameters(pathItem, operation, path)
			if ("skip" in parameters) {
				return parameters
			}
			const body = dereference(root, operation["requestBody"])
			const media = jsonMedia(body?.["content"])
			const required = body?.["required"] === true
			if (body !== undefined && media === undefined && required) {
				return { skip: "The request body is not JSON." }
			}
			return {
				parameters,
				body:
					media === undefined
						? undefined
						: { contentType: media.contentType, required, schema: media.schema },
			}
		}

		const found: Array<{
			readonly method: HttpMethod
			readonly path: string
			readonly pathItem: Schema.JsonObject
			readonly operation: Schema.JsonObject
		}> = []
		for (const [path, rawItem] of Object.entries(
			isJsonObject(root["paths"]) ? root["paths"] : {},
		)) {
			const pathItem = dereference(root, rawItem)
			if (pathItem === undefined) {
				continue
			}
			for (const method of HTTP_METHODS) {
				const operation = pathItem[method]
				if (isJsonObject(operation)) {
					found.push({ method, path, pathItem, operation })
				}
			}
		}
		// Named before anything is filtered or skipped, so a name does not depend on the selection.
		const names = nameOperations(
			found.map(({ method, path, operation }) => ({
				method,
				path,
				operationId: operation["operationId"],
			})),
		)

		const operations = new Map<string, Operation>()
		const skipped: Array<SkippedOperation> = []
		for (const [index, { method, path, pathItem, operation }] of found.entries()) {
			const name = names[index] ?? ""
			const tags = (isJsonArray(operation["tags"]) ? operation["tags"] : []).filter(
				(tag) => typeof tag === "string",
			)
			if (
				(options.include !== undefined && !selects(options.include, name, tags)) ||
				(options.exclude !== undefined && selects(options.exclude, name, tags))
			) {
				continue
			}
			const shape = readShape(path, pathItem, operation)
			if ("skip" in shape) {
				if (skipped.length < MAX_SKIPPED) {
					skipped.push({ method, path, reason: shape.skip })
				}
				continue
			}
			const summary = text(operation["summary"])
			const description = text(operation["description"])
			operations.set(name, {
				summary: {
					name,
					description: truncate(
						[summary, description === summary ? undefined : description]
							.filter((part) => part !== undefined)
							.join("\n\n") || `${method.toUpperCase()} ${path}`,
						limits.maxDescriptionLength,
					),
					method,
					pathTemplate: path,
					readOnly: READ_ONLY_METHODS.has(method),
					tags,
				},
				parameters: shape.parameters,
				body: shape.body,
				responses: operation["responses"],
			})
		}
		if (operations.size > limits.maxOperations) {
			return yield* new OpenApiImportError({
				reason: "too_many_operations",
				message: `The selection holds ${operations.size} operations; at most ${limits.maxOperations} can be imported. Narrow it with include or exclude.`,
			})
		}

		const bundle = (
			schema: JsonSchema.JsonSchema,
			roots: ReadonlyArray<ConvertedSchema>,
		): JsonSchema.JsonSchema => {
			const definitions = bundler.definitions(roots)
			return definitions === undefined ? schema : { ...schema, $defs: definitions }
		}

		const outputSchema = (responses: Schema.Json | undefined) => {
			const schemas = Object.entries(isJsonObject(responses) ? responses : {}).flatMap(
				([status, raw]) => {
					const media = /^2(?:\d\d|XX)$/i.test(status)
						? jsonMedia(dereference(root, raw)?.["content"])
						: undefined
					return media?.schema === undefined ? [] : [media.schema]
				},
			)
			if (schemas.length !== 1) {
				return undefined
			}
			const converted = bundler.convert(schemas[0])
			return bundle(converted.schema, [converted])
		}

		const describe = ({ summary, parameters, body, responses }: Operation): ToolDescriptor => {
			const roots: Array<ConvertedSchema> = []
			const groups = new Map<
				string,
				{ properties: Array<[string, JsonSchema.JsonSchema]>; required: Array<string> }
			>()
			for (const { spec, schema, description } of parameters) {
				const converted = bundler.convert(schema)
				roots.push(converted)
				const key = spec.in === "header" ? "headers" : spec.in
				const group = groups.get(key) ?? { properties: [], required: [] }
				groups.set(key, group)
				group.properties.push([
					spec.name,
					description === undefined || converted.schema["description"] !== undefined
						? converted.schema
						: {
								...converted.schema,
								description: truncate(description, limits.maxSchemaDescriptionLength),
							},
				])
				if (spec.required) {
					group.required.push(spec.name)
				}
			}
			const properties: Array<[string, JsonSchema.JsonSchema]> = []
			const required: Array<string> = []
			for (const [key, group] of ["path", "query", "headers"].flatMap((name) => {
				const group = groups.get(name)
				return group === undefined ? [] : [[name, group] as const]
			})) {
				properties.push([
					key,
					{
						type: "object",
						properties: Object.fromEntries(group.properties),
						...(group.required.length === 0 ? {} : { required: group.required }),
						additionalProperties: false,
					},
				])
				if (group.required.length > 0) {
					required.push(key)
				}
			}
			if (body !== undefined) {
				const converted = bundler.convert(body.schema)
				roots.push(converted)
				properties.push(["body", converted.schema])
				if (body.required) {
					required.push("body")
				}
			}
			const output = outputSchema(responses)
			return {
				name: summary.name,
				description: summary.description,
				inputSchema: bundle(
					{
						type: "object",
						properties: Object.fromEntries(properties),
						...(required.length === 0 ? {} : { required }),
						additionalProperties: false,
					},
					roots,
				),
				...(output === undefined ? {} : { outputSchema: output }),
				method: summary.method,
				pathTemplate: summary.pathTemplate,
				readOnly: summary.readOnly,
				parameters: parameters.map(({ spec }) => spec),
				...(body === undefined
					? {}
					: { body: { contentType: body.contentType, required: body.required } }),
			}
		}

		const info = isJsonObject(root["info"]) ? root["info"] : {}
		return {
			title: truncate(text(info["title"]) ?? "", limits.maxDescriptionLength),
			version: truncate(text(info["version"]) ?? "", limits.maxDescriptionLength),
			servers: (isJsonArray(root["servers"]) ? root["servers"] : []).flatMap((server) => {
				const url = isJsonObject(server) ? text(server["url"]) : undefined
				return url === undefined ? [] : [url]
			}),
			security,
			operations: [...operations.values()].map(({ summary }) => summary),
			skipped,
			descriptor: (name) => Option.map(Option.fromNullishOr(operations.get(name)), describe),
		}
	})
