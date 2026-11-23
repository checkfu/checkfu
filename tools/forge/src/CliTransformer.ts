import type { Field, Forge, Group, Json, Method, Type } from "@cloudflare/forge"
import { PREAMBLE, file, module } from "@cloudflare/forge/ts"

export interface GeneratedFile {
	readonly path: string
	readonly content: string
}

interface EndpointRef {
	readonly group: string
	readonly endpoint: string
}

interface IntQuerySpec {
	readonly min?: number
	readonly max?: number
	readonly metavar?: string
}

interface RepeatArraySpec {
	readonly field: string
	readonly flag: string
	readonly max?: number
	readonly description?: string
}

interface ExampleSpec {
	readonly command: string
	readonly description?: string
}

interface CliExtension {
	readonly groupDescription?: string
	readonly fileFields?: ReadonlyArray<string>
	readonly textOrObjectFields?: ReadonlyArray<string>
	readonly repeatArrayField?: RepeatArraySpec
	readonly intQueryParams?: Readonly<Record<string, IntQuerySpec>>
	readonly examples?: ReadonlyArray<ExampleSpec>
}

interface FlagSpec {
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
	readonly description: string
	readonly metavar?: string
	readonly literals?: ReadonlyArray<string>
	readonly min?: number
	readonly max?: number
}

const isJsonRecord = (value: Json | undefined): value is Readonly<Record<string, Json>> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const isJsonArray = (value: Json | undefined): value is ReadonlyArray<Json> => Array.isArray(value)

const readEndpointRef = (method: Method): EndpointRef => {
	const ext = method.extension("x-checkfu-endpoint")
	if (
		isJsonRecord(ext) &&
		typeof ext["group"] === "string" &&
		typeof ext["endpoint"] === "string"
	) {
		return { group: ext["group"], endpoint: ext["endpoint"] }
	}
	return {
		group: method.group.path[0]?.camel() ?? "root",
		endpoint: method.name.camel(),
	}
}

const readCliExtension = (method: Method): CliExtension => {
	const raw = method.extension("x-checkfu-cli")
	if (!isJsonRecord(raw)) {
		return {}
	}
	const stringList = (key: string): ReadonlyArray<string> | undefined => {
		const val = raw[key]
		if (!Array.isArray(val)) {
			return undefined
		}
		return val.filter((item): item is string => typeof item === "string")
	}
	const repeatRaw = raw["repeatArrayField"]
	const repeatArrayField: RepeatArraySpec | undefined =
		isJsonRecord(repeatRaw) &&
		typeof repeatRaw["field"] === "string" &&
		typeof repeatRaw["flag"] === "string"
			? {
					field: repeatRaw["field"],
					flag: repeatRaw["flag"],
					...(typeof repeatRaw["max"] === "number" ? { max: repeatRaw["max"] } : {}),
					...(typeof repeatRaw["description"] === "string"
						? { description: repeatRaw["description"] }
						: {}),
				}
			: undefined

	const intQueryRaw = raw["intQueryParams"]
	let intQueryParams: Record<string, IntQuerySpec> | undefined
	if (isJsonRecord(intQueryRaw)) {
		intQueryParams = {}
		for (const [key, entry] of Object.entries(intQueryRaw)) {
			if (!isJsonRecord(entry)) {
				continue
			}
			intQueryParams[key] = {
				...(typeof entry["min"] === "number" ? { min: entry["min"] } : {}),
				...(typeof entry["max"] === "number" ? { max: entry["max"] } : {}),
				...(typeof entry["metavar"] === "string" ? { metavar: entry["metavar"] } : {}),
			}
		}
	}

	const examplesRaw = raw["examples"]
	let examples: Array<ExampleSpec> | undefined
	if (isJsonArray(examplesRaw)) {
		examples = []
		for (const item of examplesRaw) {
			if (!isJsonRecord(item) || typeof item["command"] !== "string") {
				continue
			}
			examples.push({
				command: item["command"],
				...(typeof item["description"] === "string" ? { description: item["description"] } : {}),
			})
		}
	}

	const fileFields = stringList("fileFields")
	const textOrObjectFields = stringList("textOrObjectFields")

	return {
		...(typeof raw["groupDescription"] === "string"
			? { groupDescription: raw["groupDescription"] }
			: {}),
		...(fileFields !== undefined ? { fileFields } : {}),
		...(textOrObjectFields !== undefined ? { textOrObjectFields } : {}),
		...(repeatArrayField !== undefined ? { repeatArrayField } : {}),
		...(intQueryParams !== undefined ? { intQueryParams } : {}),
		...(examples !== undefined ? { examples } : {}),
	}
}

const unwrapNullableType = (ty: Type): Type => {
	if (ty.kind === "union") {
		const nonNull = ty.members.filter(
			(member) => !(member.kind === "scalar" && member.scalar === "null"),
		)
		if (nonNull.length === 1 && nonNull[0] !== undefined) {
			return nonNull[0]
		}
	}
	return ty
}

const collectFieldsFromType = (ty: Type | undefined, out: Map<string, Field>): void => {
	if (ty === undefined) {
		return
	}
	switch (ty.kind) {
		case "object": {
			for (const field of ty.fields) {
				if (!out.has(field.wireName)) {
					out.set(field.wireName, field)
				}
			}
			return
		}
		case "intersection":
		case "union": {
			for (const member of ty.members) {
				collectFieldsFromType(member, out)
			}
			return
		}
		case "model": {
			collectFieldsFromType(ty.model.type, out)
			return
		}
		default:
			return
	}
}

const isIntegerScalar = (ty: Type): boolean => {
	const unwrapped = unwrapNullableType(ty)
	if (unwrapped.kind === "scalar" && unwrapped.scalar === "number") {
		return unwrapped.number !== "float" && unwrapped.number !== "double"
	}
	return false
}

const isBooleanScalar = (ty: Type): boolean => {
	const unwrapped = unwrapNullableType(ty)
	return unwrapped.kind === "scalar" && unwrapped.scalar === "boolean"
}

const extractStringLiterals = (ty: Type): ReadonlyArray<string> | undefined => {
	const unwrapped = unwrapNullableType(ty)
	if (unwrapped.kind === "enum" && unwrapped.values.every((v) => typeof v === "string")) {
		return unwrapped.values
	}
	return undefined
}

const extractArrayMaxItems = (ty: Type): number | undefined => {
	const unwrapped = unwrapNullableType(ty)
	if (unwrapped.kind === "array") {
		return unwrapped.maxItems
	}
	if (unwrapped.kind === "model") {
		return extractArrayMaxItems(unwrapped.model.type)
	}
	return undefined
}

const isObjectOrComplexUnion = (ty: Type): boolean => {
	const unwrapped = unwrapNullableType(ty)
	if (unwrapped.kind === "object" || unwrapped.kind === "array") {
		return true
	}
	if (unwrapped.kind === "model") {
		return isObjectOrComplexUnion(unwrapped.model.type)
	}
	if (unwrapped.kind === "union") {
		return unwrapped.members.some((m) => isObjectOrComplexUnion(m))
	}
	return false
}

const RESERVED_GLOBAL_FLAG_NAMES = new Set([
	"help",
	"version",
	"wizard",
	"completions",
	"log-level",
	"base-url",
	"format",
	"transform",
	"raw-output",
])

const resolveCliFlagName = (field: Field): string => {
	const raw = field.name.kebab()
	if (raw === "version") {
		return "current-version"
	}
	if (RESERVED_GLOBAL_FLAG_NAMES.has(raw)) {
		return `param-${raw}`
	}
	return raw
}

const defaultMetavar = (flag: FlagSpec): string | undefined => {
	if (flag.metavar !== undefined) {
		return flag.metavar
	}
	if (flag.location === "path" || flag.flagName.endsWith("-id")) {
		return "ID"
	}
	if (flag.kind === "int") {
		return "INT"
	}
	if (flag.kind === "file-text") {
		return "TEXT|@FILE"
	}
	if (flag.kind === "text-or-object") {
		return "VALUE|JSON|@FILE"
	}
	if (flag.kind === "structured" || flag.kind === "repeat-structured") {
		return "JSON|YAML|@FILE"
	}
	if (flag.location === "header") {
		return "KEY"
	}
	return undefined
}

const formatCliFlagDescription = (base: string, kind: FlagSpec["kind"]): string => {
	switch (kind) {
		case "file-text":
			return `${base} (supports @file)`
		case "text-or-object":
			return `${base} (accepts value, JSON/YAML object, or @file)`
		case "structured":
			return `${base} (JSON, YAML, or @file)`
		default:
			return base
	}
}

const formatCliCommandDescription = (base: string, hasBody: boolean): string => {
	if (!hasBody) {
		return base
	}
	if (base.endsWith(")")) {
		return `${base.slice(0, -1)}; accepts flags and/or JSON/YAML on stdin)`
	}
	return `${base} (accepts flags and/or JSON/YAML on stdin)`
}

const collectMethodFlags = (method: Method, cliExt: CliExtension): ReadonlyArray<FlagSpec> => {
	const flags: Array<FlagSpec> = []
	const seenFlagNames = new Set<string>()
	const fileFields = new Set(cliExt.fileFields ?? [])
	const textOrObjectFields = new Set(cliExt.textOrObjectFields ?? [])
	const intQueryParams = cliExt.intQueryParams ?? {}

	const allRequestFields = new Map<string, Field>()
	collectFieldsFromType(method.request, allRequestFields)

	const pathFields: Array<Field> = []
	const queryFields: Array<Field> = []
	const bodyFields: Array<Field> = []

	for (const field of allRequestFields.values()) {
		const loc = method.location(field)
		if (loc?.in === "path") {
			pathFields.push(field)
		} else if (loc?.in === "query") {
			queryFields.push(field)
		} else {
			bodyFields.push(field)
		}
	}

	// If Forge placed body fields separately in method.body.json, include any not yet collected
	if (method.body?.json !== undefined) {
		const extraBodyFields = new Map<string, Field>()
		collectFieldsFromType(method.body.json.type, extraBodyFields)
		for (const [wireName, field] of extraBodyFields) {
			if (!allRequestFields.has(wireName)) {
				bodyFields.push(field)
			}
		}
	}

	const pushFlag = (spec: FlagSpec) => {
		if (seenFlagNames.has(spec.flagName)) {
			return
		}
		seenFlagNames.add(spec.flagName)
		flags.push(spec)
	}

	for (const field of pathFields) {
		pushFlag({
			propName: field.name.camel(),
			flagName: resolveCliFlagName(field),
			wireName: field.wireName,
			location: "path",
			kind: "string",
			required: true,
			description: field.description || `${field.name.toString()} parameter`,
			metavar: "ID",
		})
	}

	for (const field of queryFields) {
		const intSpec = intQueryParams[field.wireName]
		const literals = extractStringLiterals(field.type)
		const flagName = resolveCliFlagName(field)
		if (intSpec !== undefined || isIntegerScalar(field.type)) {
			pushFlag({
				propName: field.name.camel(),
				flagName,
				wireName: field.wireName,
				location: "query",
				kind: "int",
				required: false,
				description: field.description || `Query parameter ${field.wireName}`,
				...(intSpec?.metavar !== undefined ? { metavar: intSpec.metavar } : {}),
				...(intSpec?.min !== undefined ? { min: intSpec.min } : {}),
				...(intSpec?.max !== undefined ? { max: intSpec.max } : {}),
			})
		} else if (literals !== undefined) {
			pushFlag({
				propName: field.name.camel(),
				flagName,
				wireName: field.wireName,
				location: "query",
				kind: "literals",
				required: false,
				description: field.description || `Query parameter ${field.wireName}`,
				literals,
			})
		} else if (isBooleanScalar(field.type)) {
			pushFlag({
				propName: field.name.camel(),
				flagName,
				wireName: field.wireName,
				location: "query",
				kind: "boolean",
				required: false,
				description: field.description || `Query parameter ${field.wireName}`,
			})
		} else {
			pushFlag({
				propName: field.name.camel(),
				flagName,
				wireName: field.wireName,
				location: "query",
				kind: "string",
				required: false,
				description: field.description || `Query parameter ${field.wireName}`,
			})
		}
	}

	for (const field of bodyFields) {
		const repeat = cliExt.repeatArrayField
		if (repeat !== undefined && repeat.field === field.wireName) {
			const repeatMax = repeat.max ?? extractArrayMaxItems(field.type)
			pushFlag({
				propName: field.name.camel(),
				flagName: repeat.flag,
				wireName: field.wireName,
				location: "body",
				kind: "repeat-structured",
				required: false,
				description: repeat.description ?? field.description ?? `Repeatable ${repeat.flag}`,
				min: 0,
				...(repeatMax !== undefined ? { max: repeatMax } : {}),
			})
			continue
		}

		const literals = extractStringLiterals(field.type)
		const flagName = resolveCliFlagName(field)
		if (fileFields.has(field.wireName)) {
			pushFlag({
				propName: field.name.camel(),
				flagName,
				wireName: field.wireName,
				location: "body",
				kind: "file-text",
				required: false,
				description: formatCliFlagDescription(
					field.description || `Body field ${field.wireName}`,
					"file-text",
				),
			})
		} else if (textOrObjectFields.has(field.wireName)) {
			pushFlag({
				propName: field.name.camel(),
				flagName,
				wireName: field.wireName,
				location: "body",
				kind: "text-or-object",
				required: false,
				description: formatCliFlagDescription(
					field.description || `Body field ${field.wireName}`,
					"text-or-object",
				),
			})
		} else if (isIntegerScalar(field.type)) {
			pushFlag({
				propName: field.name.camel(),
				flagName,
				wireName: field.wireName,
				location: "body",
				kind: "int",
				required: false,
				description: field.description || `Body field ${field.wireName}`,
			})
		} else if (isBooleanScalar(field.type)) {
			pushFlag({
				propName: field.name.camel(),
				flagName,
				wireName: field.wireName,
				location: "body",
				kind: "boolean",
				required: false,
				description: field.description || `Body field ${field.wireName}`,
			})
		} else if (literals !== undefined) {
			pushFlag({
				propName: field.name.camel(),
				flagName,
				wireName: field.wireName,
				location: "body",
				kind: "literals",
				required: false,
				description: field.description || `Body field ${field.wireName}`,
				literals,
			})
		} else if (isObjectOrComplexUnion(field.type)) {
			pushFlag({
				propName: field.name.camel(),
				flagName,
				wireName: field.wireName,
				location: "body",
				kind: "structured",
				required: false,
				description: formatCliFlagDescription(
					field.description || `Body field ${field.wireName}`,
					"structured",
				),
			})
		} else {
			pushFlag({
				propName: field.name.camel(),
				flagName,
				wireName: field.wireName,
				location: "body",
				kind: "string",
				required: false,
				description: field.description || `Body field ${field.wireName}`,
			})
		}
	}

	if (method.headers !== undefined) {
		for (const header of method.headers.fields) {
			pushFlag({
				propName: header.name.camel(),
				flagName: resolveCliFlagName(header),
				wireName: header.wireName.toLowerCase(),
				location: "header",
				kind: "string",
				required: false,
				description: header.description || `Header ${header.wireName}`,
				metavar: "KEY",
			})
		}
	}

	return flags
}

const isSseMethod = (method: Method): boolean =>
	method.responses.some((res) => res.contents.some((c) => c.mediaType === "text/event-stream"))

const cliGroupName = (group: Group): string => group.path.map((part) => part.kebab()).join(":")

const groupExtrasTypeParam = (group: Group): string =>
	`${group.path.map((part) => part.pascal()).join("")}Extras`

const methodVarName = (group: Group, method: Method): string =>
	`${group.path.map((part, idx) => (idx === 0 ? part.camel() : part.pascal())).join("")}${method.name.pascal()}Command`

const splitInlineTypeImports = (content: string): string =>
	content.replaceAll(
		/^import\s*\{([^}]+)\}\s*from\s*("[^"]+")/gm,
		(fullMatch, specifiers: string, source: string) => {
			const parts = specifiers
				.split(",")
				.map((part) => part.trim())
				.filter((part) => part.length > 0)
			const typeSpecs: Array<string> = []
			const valueSpecs: Array<string> = []
			for (const part of parts) {
				if (part.startsWith("type ")) {
					typeSpecs.push(part.slice("type ".length).trim())
				} else {
					valueSpecs.push(part)
				}
			}
			if (typeSpecs.length === 0) {
				return fullMatch
			}
			const lines: Array<string> = []
			if (valueSpecs.length > 0) {
				lines.push(`import { ${valueSpecs.join(", ")} } from ${source}`)
			}
			lines.push(`import type { ${typeSpecs.join(", ")} } from ${source}`)
			return lines.join("\n")
		},
	)

const cleanGeneratedHeader = (content: string): string => {
	const header = "// Code generated by @cloudflare/forge. DO NOT EDIT.\n\n"
	const withHeader = content.startsWith(PREAMBLE)
		? `${header}${content.slice(PREAMBLE.length)}`
		: content
	return splitInlineTypeImports(withHeader)
}

export const generateCliFiles = (forge: Forge): ReadonlyArray<GeneratedFile> => {
	const commandMod = module("effect/cli/Command")
	const flagMod = module("effect/cli/Flag")
	const runtimeMod = module("../GeneratedRuntime.ts")

	const CommandMake = commandMod.ident("make").as("CommandMake")
	const CommandWithDescription = commandMod.ident("withDescription").as("CommandWithDescription")
	const CommandWithExamples = commandMod.ident("withExamples").as("CommandWithExamples")
	const CommandWithSubcommands = commandMod.ident("withSubcommands").as("CommandWithSubcommands")
	const CommandType = commandMod.ident("Command").ty()
	const FlagString = flagMod.ident("String").as("FlagString")
	const FlagInt = flagMod.ident("Int").as("FlagInt")
	const FlagBoolean = flagMod.ident("Boolean").as("FlagBoolean")
	const FlagLiterals = flagMod.ident("Literals").as("FlagLiterals")
	const FlagOptional = flagMod.ident("optional").as("FlagOptional")
	const FlagAtLeast = flagMod.ident("atLeast").as("FlagAtLeast")
	const FlagBetween = flagMod.ident("between").as("FlagBetween")
	const FlagWithDescription = flagMod.ident("withDescription").as("FlagWithDescription")
	const FlagWithMetavar = flagMod.ident("withMetavar").as("FlagWithMetavar")
	const invokeGeneratedOperation = runtimeMod.ident("invokeGeneratedOperation")
	const invokeGeneratedStream = runtimeMod.ident("invokeGeneratedStream")
	const GeneratedOperationDescriptor = runtimeMod.ident("GeneratedOperationDescriptor").ty()

	const activeGroups = forge.groups.filter((g) => g.path.length > 0 && g.methods.length > 0)

	const groupEntries: Array<{
		readonly cliName: string
		readonly description: string
		readonly extrasTypeParam: string
		readonly methodVars: ReadonlyArray<string>
	}> = []

	const out = file("Commands.ts")
	for (const group of activeGroups) {
		const cliName = cliGroupName(group)
		const methodVars: Array<string> = []
		let groupDescription = group.description

		for (const method of group.methods) {
			const endpointRef = readEndpointRef(method)
			const cliExt = readCliExtension(method)
			if (!groupDescription && cliExt.groupDescription) {
				groupDescription = cliExt.groupDescription
			}
			const flags = collectMethodFlags(method, cliExt)
			const varName = methodVarName(group, method)
			const streaming = isSseMethod(method)
			if (streaming && (method.httpMethod.toUpperCase() !== "GET" || method.body !== undefined)) {
				throw new Error(
					`Unsupported SSE endpoint ${endpointRef.group}.${endpointRef.endpoint}: generated streaming commands only support GET endpoints without a request body.`,
				)
			}
			const descriptorVar = `${varName}Spec`
			methodVars.push(varName)

			const flagSpecsJson = flags.map((fl) => ({
				propName: fl.propName,
				flagName: fl.flagName,
				wireName: fl.wireName,
				location: fl.location,
				kind: fl.kind,
				required: fl.required,
				...(fl.min !== undefined ? { min: fl.min } : {}),
				...(fl.max !== undefined ? { max: fl.max } : {}),
			}))

			out("const ", descriptorVar, ": ", GeneratedOperationDescriptor, " = {")
			out.indent(() => {
				out("cliLabel: ", JSON.stringify(`${cliName} ${method.name.kebab()}`), ",")
				out("apiGroup: ", JSON.stringify(endpointRef.group), ",")
				out("apiEndpoint: ", JSON.stringify(endpointRef.endpoint), ",")
				out("hasBody: ", method.body !== undefined, ",")
				out("flags: ", JSON.stringify(flagSpecsJson), ",")
			})
			out("}")
			out()

			out("const ", varName, " = ", CommandMake, "(")
			out.indent(() => {
				out(JSON.stringify(method.name.kebab()), ",")
				out("{")
				out.indent(() => {
					for (const fl of flags) {
						const metavar = defaultMetavar(fl)
						const hasPipes =
							metavar !== undefined ||
							fl.description.length > 0 ||
							fl.kind === "repeat-structured" ||
							!fl.required

						const baseIdent =
							fl.kind === "int"
								? FlagInt
								: fl.kind === "boolean"
									? FlagBoolean
									: fl.kind === "literals"
										? FlagLiterals
										: FlagString

						if (!hasPipes) {
							if (fl.kind === "literals") {
								out(
									fl.propName,
									": ",
									baseIdent,
									"(",
									JSON.stringify(fl.flagName),
									", ",
									JSON.stringify(fl.literals ?? []),
									"),",
								)
							} else {
								out(fl.propName, ": ", baseIdent, "(", JSON.stringify(fl.flagName), "),")
							}
						} else {
							if (fl.kind === "literals") {
								out(
									fl.propName,
									": ",
									baseIdent,
									"(",
									JSON.stringify(fl.flagName),
									", ",
									JSON.stringify(fl.literals ?? []),
									").pipe(",
								)
							} else {
								out(fl.propName, ": ", baseIdent, "(", JSON.stringify(fl.flagName), ").pipe(")
							}
							out.indent(() => {
								if (metavar !== undefined) {
									out(FlagWithMetavar, "(", JSON.stringify(metavar), "),")
								}
								if (fl.description.length > 0) {
									out(FlagWithDescription, "(", JSON.stringify(fl.description), "),")
								}
								if (fl.kind === "repeat-structured") {
									if (fl.max !== undefined) {
										out(FlagBetween, "(", fl.min ?? 0, ", ", fl.max, "),")
									} else {
										out(FlagAtLeast, "(", fl.min ?? 0, "),")
									}
								} else if (!fl.required) {
									out(FlagOptional, ",")
								}
							})
							out("),")
						}
					}
				})
				out("},")
				if (streaming) {
					out("(flags) => ", invokeGeneratedStream, "(", descriptorVar, ", flags),")
				} else {
					out("(flags) => ", invokeGeneratedOperation, "(", descriptorVar, ", flags),")
				}
			})
			const description = formatCliCommandDescription(
				method.description || method.summary || `${cliName} ${method.name.kebab()}`,
				method.body !== undefined,
			)
			const examples = cliExt.examples ?? []
			out(").pipe(")
			out.indent(() => {
				out(CommandWithDescription, "(", JSON.stringify(description), "),")
				if (examples.length > 0) {
					out(CommandWithExamples, "(", JSON.stringify(examples), "),")
				}
			})
			out(")")
			out()
		}

		groupEntries.push({
			cliName,
			description: groupDescription || `Manage ${cliName}`,
			extrasTypeParam: groupExtrasTypeParam(group),
			methodVars,
		})
	}

	out("export const buildGeneratedResourceCommands = <")
	out.indent(() => {
		for (const entry of groupEntries) {
			out(
				"const ",
				entry.extrasTypeParam,
				" extends ReadonlyArray<",
				CommandType,
				".Any> = readonly [],",
			)
		}
	})
	out(">(extras?: {")
	out.indent(() => {
		for (const entry of groupEntries) {
			out("readonly ", JSON.stringify(entry.cliName), "?: ", entry.extrasTypeParam)
		}
	})
	out("}) => [")
	out.indent(() => {
		for (const entry of groupEntries) {
			out(CommandMake, "(", JSON.stringify(entry.cliName), ").pipe(")
			out.indent(() => {
				out(CommandWithDescription, "(", JSON.stringify(entry.description), "),")
				out(CommandWithSubcommands, "([")
				out.indent(() => {
					for (const methodVar of entry.methodVars) {
						out(methodVar, ",")
					}
					out("...(extras?.[", JSON.stringify(entry.cliName), "] ?? ([] as const)),")
				})
				out("]),")
			})
			out("),")
		}
	})
	out("] as const")

	return [{ path: "Commands.ts", content: cleanGeneratedHeader(out.content) }]
}
