import type { Field, Forge, Group, Json, Method, Name, Type } from "@cloudflare/forge"
import { PREAMBLE } from "@cloudflare/forge/ts"

export interface GeneratedFile {
	readonly path: string
	readonly content: string
}

export interface EndpointRef {
	readonly group: string
	readonly endpoint: string
}

export type SurfaceOperationKind = "unary" | "paginated" | "sse"
export type SurfaceRetrySafety = "idempotent" | "pre-commit-only" | "idempotency-key-gated"

export interface SurfaceParam {
	readonly wireName: string
	readonly camelName: string
	readonly pascalName: string
	readonly required: boolean
	readonly description: string
	readonly type: Type
}

export interface SurfacePaginationSpec {
	readonly itemsField: "data"
	readonly cursorParam: string
	readonly cursorType: "number" | "string"
	readonly hasOrderParam: boolean
}

export interface SurfaceSseSpec {
	readonly cursorParam: string | undefined
	readonly cursorType: "number" | "string"
}

export interface SurfaceOperation {
	readonly operationId: string
	readonly memberPath: ReadonlyArray<string>
	readonly groupPath: ReadonlyArray<Name>
	readonly groupPathCamel: ReadonlyArray<string>
	readonly groupPathPascal: ReadonlyArray<string>
	readonly cliGroup: string
	readonly cliMethod: string
	readonly cliCommand: string
	readonly methodName: string
	readonly methodPascal: string
	readonly apiGroup: string
	readonly apiEndpoint: string
	readonly httpMethod: string
	readonly path: string
	readonly summary: string
	readonly description: string
	readonly deprecated: boolean
	readonly pathParams: ReadonlyArray<SurfaceParam>
	readonly queryParams: ReadonlyArray<SurfaceParam>
	readonly hasRequiredQuery: boolean
	readonly hasBody: boolean
	readonly bodyRequired: boolean
	readonly headers: ReadonlyArray<SurfaceParam>
	readonly supportsIdempotencyKey: boolean
	readonly supportsPending: boolean
	readonly kind: SurfaceOperationKind
	readonly retrySafety: SurfaceRetrySafety
	readonly pagination: SurfacePaginationSpec | undefined
	readonly sse: SurfaceSseSpec | undefined
	readonly group: Group
	readonly method: Method
}

export interface SurfaceGroupNode {
	readonly name: string
	readonly pascalPath: string
	readonly path: ReadonlyArray<string>
	readonly cliName: string
	readonly description: string
	readonly children: ReadonlyArray<SurfaceGroupNode>
	readonly operations: ReadonlyArray<SurfaceOperation>
}

export interface SurfaceCatalog {
	readonly root: SurfaceGroupNode
	readonly operations: ReadonlyArray<SurfaceOperation>
}

const VALID_JS_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

const RESERVED_MEMBER_NAMES = new Set([
	"constructor",
	"prototype",
	"then",
	"catch",
	"finally",
	"__proto__",
	"toString",
	"valueOf",
	"toJSON",
])

const RESERVED_ROOT_MEMBERS = new Set([
	...RESERVED_MEMBER_NAMES,
	"baseUrl",
	"baseURL",
	"raw",
	"generateIdempotencyKey",
	"withOptions",
	"waitForPending",
	"close",
])

const IDEMPOTENT_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"])

export const isJsonRecord = (value: Json | undefined): value is Readonly<Record<string, Json>> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

export const isJsonArray = (value: Json | undefined): value is ReadonlyArray<Json> =>
	Array.isArray(value)

export const readEndpointRef = (method: Method): EndpointRef => {
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

export const unwrapNullableType = (ty: Type): Type => {
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

export const collectFieldsFromType = (ty: Type | undefined, out: Map<string, Field>): void => {
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

export const isIntegerScalar = (ty: Type): boolean => {
	const unwrapped = unwrapNullableType(ty)
	if (unwrapped.kind === "scalar" && unwrapped.scalar === "number") {
		return unwrapped.number !== "float" && unwrapped.number !== "double"
	}
	return false
}

export const isNumberScalar = (ty: Type): boolean => {
	const unwrapped = unwrapNullableType(ty)
	return unwrapped.kind === "scalar" && unwrapped.scalar === "number"
}

export const isBooleanScalar = (ty: Type): boolean => {
	const unwrapped = unwrapNullableType(ty)
	return unwrapped.kind === "scalar" && unwrapped.scalar === "boolean"
}

export const extractStringLiterals = (ty: Type): ReadonlyArray<string> | undefined => {
	const unwrapped = unwrapNullableType(ty)
	if (unwrapped.kind === "enum" && unwrapped.values.every((v) => typeof v === "string")) {
		return unwrapped.values
	}
	return undefined
}

export const extractArrayMaxItems = (ty: Type): number | undefined => {
	const unwrapped = unwrapNullableType(ty)
	if (unwrapped.kind === "array") {
		return unwrapped.maxItems
	}
	if (unwrapped.kind === "model") {
		return extractArrayMaxItems(unwrapped.model.type)
	}
	return undefined
}

export const isObjectOrComplexUnion = (ty: Type): boolean => {
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

export const isSseMethod = (method: Method): boolean =>
	method.responses.some((res) => res.contents.some((c) => c.mediaType === "text/event-stream"))

export const splitInlineTypeImports = (content: string): string =>
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

export const cleanGeneratedHeader = (content: string): string => {
	const header = "// Code generated by @cloudflare/forge. DO NOT EDIT.\n\n"
	const withHeader = content.startsWith(PREAMBLE)
		? `${header}${content.slice(PREAMBLE.length)}`
		: content
	return splitInlineTypeImports(withHeader)
}

const assertValidIdentifier = (value: string, context: string, isRootMember = false): void => {
	if (!VALID_JS_IDENT.test(value)) {
		throw new Error(`Invalid generated identifier "${value}" for ${context}.`)
	}
	const reserved = isRootMember ? RESERVED_ROOT_MEMBERS : RESERVED_MEMBER_NAMES
	if (reserved.has(value)) {
		throw new Error(`Reserved generated member name "${value}" for ${context}.`)
	}
}

const extractPathParamOrder = (pathTemplate: string): ReadonlyArray<string> => {
	const order: Array<string> = []
	for (const match of pathTemplate.matchAll(/\{([^}]+)\}/g)) {
		const name = match[1]?.trim()
		if (name !== undefined && name.length > 0) {
			order.push(name)
		}
	}
	return order
}

const fieldToParam = (field: Field): SurfaceParam => ({
	wireName: field.wireName,
	camelName: field.name.camel(),
	pascalName: field.name.pascal(),
	required: field.required,
	description: field.description,
	type: field.type,
})

const hasIntQueryHint = (method: Method, wireName: string): boolean => {
	const cliExt = method.extension("x-checkfu-cli")
	if (!isJsonRecord(cliExt)) {
		return false
	}
	const intQueryParams = cliExt["intQueryParams"]
	return isJsonRecord(intQueryParams) && intQueryParams[wireName] !== undefined
}

const detectPagination = (
	method: Method,
	queryParams: ReadonlyArray<SurfaceParam>,
): SurfacePaginationSpec | undefined => {
	if (method.httpMethod.toUpperCase() !== "GET" || isSseMethod(method)) {
		return undefined
	}
	const cursorField = queryParams.find((q) => q.wireName === "after")
	if (cursorField === undefined) {
		return undefined
	}
	const okResponse = method.responses.find((r) => r.status === "200") ?? method.responses[0]
	if (okResponse?.json === undefined) {
		return undefined
	}
	const responseFields = new Map<string, Field>()
	collectFieldsFromType(okResponse.json.type, responseFields)
	const dataField = responseFields.get("data")
	const hasMoreField = responseFields.get("has_more")
	const nextCursorField = responseFields.get("next_cursor")
	if (dataField === undefined || hasMoreField === undefined || nextCursorField === undefined) {
		return undefined
	}
	const unwrappedData = unwrapNullableType(dataField.type)
	if (unwrappedData.kind !== "array") {
		return undefined
	}
	if (!isBooleanScalar(hasMoreField.type)) {
		return undefined
	}
	const cursorType = isNumberScalar(nextCursorField.type) ? "number" : "string"
	return {
		itemsField: "data",
		cursorParam: cursorField.wireName,
		cursorType,
		hasOrderParam: queryParams.some((q) => q.wireName === "order"),
	}
}

const detectSse = (
	method: Method,
	queryParams: ReadonlyArray<SurfaceParam>,
	endpointRef: EndpointRef,
): SurfaceSseSpec | undefined => {
	if (!isSseMethod(method)) {
		return undefined
	}
	if (method.httpMethod.toUpperCase() !== "GET" || method.body !== undefined) {
		throw new Error(
			`Unsupported SSE endpoint ${endpointRef.group}.${endpointRef.endpoint}: streaming endpoints must use GET without a request body.`,
		)
	}
	const cursorField = queryParams.find((q) => q.wireName === "after")
	const cursorType =
		cursorField !== undefined &&
		(isIntegerScalar(cursorField.type) || hasIntQueryHint(method, cursorField.wireName))
			? "number"
			: "string"
	return {
		cursorParam: cursorField?.wireName,
		cursorType,
	}
}

const buildOperation = (group: Group, method: Method): SurfaceOperation => {
	const groupPathCamel = group.path.map((part) => part.camel())
	const groupPathPascal = group.path.map((part) => part.pascal())
	const methodName = method.name.camel()
	const methodPascal = method.name.pascal()
	const cliGroup = group.path.map((part) => part.kebab()).join(":")
	const cliMethod = method.name.kebab()
	const cliCommand = cliGroup.length > 0 ? `${cliGroup} ${cliMethod}` : cliMethod
	const memberPath = [...groupPathCamel, methodName]
	const operationId = memberPath.join(".")

	for (const [idx, seg] of groupPathCamel.entries()) {
		assertValidIdentifier(seg, `group "${operationId}"`, idx === 0)
	}
	assertValidIdentifier(methodName, `method "${operationId}"`, groupPathCamel.length === 0)

	const endpointRef = readEndpointRef(method)
	assertValidIdentifier(endpointRef.group, `x-checkfu-endpoint.group for "${operationId}"`)
	assertValidIdentifier(endpointRef.endpoint, `x-checkfu-endpoint.endpoint for "${operationId}"`)

	const httpMethod = method.httpMethod.toUpperCase()

	const allRequestFields = new Map<string, Field>()
	collectFieldsFromType(method.request, allRequestFields)

	const pathFieldMap = new Map<string, SurfaceParam>()
	const queryParams: Array<SurfaceParam> = []

	for (const field of allRequestFields.values()) {
		const loc = method.location(field)
		if (loc?.in === "path") {
			pathFieldMap.set(field.wireName, fieldToParam(field))
		} else if (loc?.in === "query") {
			queryParams.push(fieldToParam(field))
		}
	}

	const pathOrder = extractPathParamOrder(method.path)
	const pathParams: Array<SurfaceParam> = []
	for (const wireName of pathOrder) {
		const param = pathFieldMap.get(wireName)
		if (param !== undefined) {
			pathParams.push(param)
			pathFieldMap.delete(wireName)
		}
	}
	for (const remaining of pathFieldMap.values()) {
		pathParams.push(remaining)
	}

	const headers = (method.headers?.fields ?? []).map(fieldToParam)
	const supportsIdempotencyKey = headers.some((h) => h.wireName.toLowerCase() === "idempotency-key")
	const supportsPending = method.responses.some((r) => r.status === "202")

	const sse = detectSse(method, queryParams, endpointRef)
	const pagination = detectPagination(method, queryParams)
	const kind: SurfaceOperationKind =
		sse !== undefined ? "sse" : pagination !== undefined ? "paginated" : "unary"

	const explicitIdempotent = method.extension("x-checkfu-idempotent") === true
	const retrySafety: SurfaceRetrySafety =
		explicitIdempotent || IDEMPOTENT_HTTP_METHODS.has(httpMethod)
			? "idempotent"
			: supportsIdempotencyKey
				? "idempotency-key-gated"
				: "pre-commit-only"

	return {
		operationId,
		memberPath,
		groupPath: group.path,
		groupPathCamel,
		groupPathPascal,
		cliGroup,
		cliMethod,
		cliCommand,
		methodName,
		methodPascal,
		apiGroup: endpointRef.group,
		apiEndpoint: endpointRef.endpoint,
		httpMethod,
		path: method.path,
		summary: method.summary,
		description: method.description,
		deprecated: method.deprecated,
		pathParams,
		queryParams,
		hasRequiredQuery: queryParams.some((q) => q.required),
		hasBody: method.body !== undefined,
		bodyRequired: method.body?.required ?? false,
		headers,
		supportsIdempotencyKey,
		supportsPending,
		kind,
		retrySafety,
		pagination,
		sse,
		group,
		method,
	}
}

const buildGroupNode = (
	group: Group,
	seenOperationIds: Set<string>,
	allOperations: Array<SurfaceOperation>,
): SurfaceGroupNode | undefined => {
	const isRoot = group.path.length === 0
	const name = isRoot ? "" : (group.path.at(-1)?.camel() ?? "")
	const path = group.path.map((part) => part.camel())
	const pascalPath = group.path.map((part) => part.pascal()).join("")
	const cliName = group.path.map((part) => part.kebab()).join(":")

	const operations: Array<SurfaceOperation> = []
	const seenMethodNames = new Set<string>()
	for (const method of group.methods) {
		const op = buildOperation(group, method)
		if (seenMethodNames.has(op.methodName)) {
			throw new Error(
				`Duplicate method name "${op.methodName}" in group "${path.join(".") || "<root>"}".`,
			)
		}
		if (seenOperationIds.has(op.operationId)) {
			throw new Error(`Duplicate operationId "${op.operationId}" in OpenAPI surface catalog.`)
		}
		seenMethodNames.add(op.methodName)
		seenOperationIds.add(op.operationId)
		operations.push(op)
		allOperations.push(op)
	}

	const children: Array<SurfaceGroupNode> = []
	const seenChildNames = new Set<string>()
	for (const childGroup of group.children) {
		const childNode = buildGroupNode(childGroup, seenOperationIds, allOperations)
		if (childNode === undefined) {
			continue
		}
		if (seenChildNames.has(childNode.name)) {
			throw new Error(
				`Duplicate child group "${childNode.name}" under "${path.join(".") || "<root>"}".`,
			)
		}
		if (seenMethodNames.has(childNode.name)) {
			throw new Error(
				`Collision between subgroup "${childNode.name}" and method "${childNode.name}" in group "${path.join(".") || "<root>"}".`,
			)
		}
		seenChildNames.add(childNode.name)
		children.push(childNode)
	}

	// Also detect collision with Effect pagination helper names (`<method>Pages`, `<method>Stream`)
	for (const op of operations) {
		if (op.kind !== "paginated") {
			continue
		}
		for (const companion of [`${op.methodName}Pages`, `${op.methodName}Stream`]) {
			if (seenMethodNames.has(companion) || seenChildNames.has(companion)) {
				throw new Error(
					`Pagination companion "${companion}" collides with an existing member in group "${path.join(".") || "<root>"}".`,
				)
			}
		}
	}

	if (!isRoot && operations.length === 0 && children.length === 0) {
		return undefined
	}

	return {
		name,
		pascalPath,
		path,
		cliName,
		description: group.description,
		children,
		operations,
	}
}

export const buildSurfaceCatalog = (forge: Forge): SurfaceCatalog => {
	const rootGroup = forge.groups.find((g) => g.path.length === 0)
	if (rootGroup === undefined) {
		return {
			root: {
				name: "",
				pascalPath: "",
				path: [],
				cliName: "",
				description: "",
				children: [],
				operations: [],
			},
			operations: [],
		}
	}
	const seenOperationIds = new Set<string>()
	const operations: Array<SurfaceOperation> = []
	const root = buildGroupNode(rootGroup, seenOperationIds, operations) ?? {
		name: "",
		pascalPath: "",
		path: [],
		cliName: "",
		description: "",
		children: [],
		operations: [],
	}
	return { root, operations }
}
