import type { ApiSelection } from "@checkfu/domain/Mcp/ApiServers"
import {
	MAX_API_SERVER_DESCRIPTORS_JSON_BYTES,
	MAX_API_SERVER_OPERATIONS,
	MAX_API_SPEC_JSON_BYTES,
} from "@checkfu/domain/Mcp/ApiServers"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { McpToolDescriptor } from "../Connection/McpUpstream.ts"
import type { OpenApiCatalog } from "./OpenApiImport.ts"
import type { HttpRequestDescription } from "./OpenApiTypes.ts"
import type { ApiSpecSummary } from "./ApiSpecCheck.ts"

export const UNCONFIRMED_CATALOG_TTL_MS = 24 * 60 * 60 * 1000

const STATUS = "status"
const CONFIG = "config"
const DOCUMENT = "document"

/** What a stored document is served with: where its API is, and which operations are kept. */
export const CatalogConfig = Schema.Struct({
	base_url: Schema.String,
	digest: Schema.String,
	include: Schema.optionalKey(
		Schema.Struct({
			names: Schema.optionalKey(Schema.Array(Schema.String)),
			tags: Schema.optionalKey(Schema.Array(Schema.String)),
		}),
	),
	exclude: Schema.optionalKey(
		Schema.Struct({
			names: Schema.optionalKey(Schema.Array(Schema.String)),
			tags: Schema.optionalKey(Schema.Array(Schema.String)),
		}),
	),
})
export type CatalogConfig = typeof CatalogConfig.Type

const ConfigJson = Schema.fromJsonString(CatalogConfig)
const decodeConfig = Schema.decodeUnknownOption(ConfigJson)
const encodeConfig = Schema.encodeSync(ConfigJson)
const isJsonObject = Schema.is(Schema.JsonObject)

export type CatalogTools =
	| { readonly ok: true; readonly tools: ReadonlyArray<McpToolDescriptor> }
	| { readonly ok: false; readonly message: string }

export type CatalogRequest =
	| { readonly ok: true; readonly request: HttpRequestDescription }
	| { readonly ok: false; readonly message: string }

export type ApiSpecRefusal = { readonly ok: false; readonly message: string }

export interface ImportedApi {
	readonly ok: true
	readonly catalog: OpenApiCatalog
	readonly tools: ReadonlyArray<McpToolDescriptor>
}

const refuse = (message: string): ApiSpecRefusal => ({ ok: false, message })

/** An operation as a session is offered it. Only the HTTP method can mark it a read. */
const served = (catalog: OpenApiCatalog): Array<McpToolDescriptor> =>
	catalog.operations.flatMap((operation) =>
		Option.match(catalog.descriptor(operation.name), {
			onNone: () => [],
			onSome: (descriptor): Array<McpToolDescriptor> =>
				isJsonObject(descriptor.inputSchema)
					? [
							{
								name: descriptor.name,
								description: descriptor.description,
								inputSchema: descriptor.inputSchema,
								...(isJsonObject(descriptor.outputSchema)
									? { outputSchema: descriptor.outputSchema }
									: {}),
								...(descriptor.readOnly ? { readOnly: true as const } : {}),
							},
						]
					: [],
		}),
	)

/**
 * Reads an OpenAPI document as one API server's tools, or says why it cannot
 * be one: the document, the operations picked from it and what they come to
 * as tools each have a bound.
 */
/** `importApiServer`, as what it tells the API about the document. */
export const checkApiServer = (
	document: string,
	selection: { readonly include?: ApiSelection; readonly exclude?: ApiSelection },
): Effect.Effect<ApiSpecSummary> =>
	Effect.map(importApiServer(document, selection), (imported) =>
		imported.ok
			? {
					ok: true as const,
					title: imported.catalog.title,
					version: imported.catalog.version,
					operations: imported.tools.length,
				}
			: imported,
	)

export const importApiServer = (
	document: string | Schema.JsonObject,
	selection: { readonly include?: ApiSelection; readonly exclude?: ApiSelection },
): Effect.Effect<ImportedApi | ApiSpecRefusal> =>
	Effect.gen(function* () {
		// The importer loads with the first document, so isolates that never read one skip it.
		const { importOpenApi } = yield* Effect.promise(() => import("./OpenApiImport.ts"))
		const limits = { maxDocumentLength: MAX_API_SPEC_JSON_BYTES }
		const whole = yield* importOpenApi(document, { limits })
		for (const [field, picked] of [
			["include", selection.include],
			["exclude", selection.exclude],
		] as const) {
			const name = picked?.names?.find(
				(entry) => !whole.operations.some((operation) => operation.name === entry),
			)
			if (name !== undefined) {
				return refuse(`${field}.names lists "${name}", which is not an operation of the document.`)
			}
			const tag = picked?.tags?.find(
				(entry) => !whole.operations.some((operation) => operation.tags.includes(entry)),
			)
			if (tag !== undefined) {
				return refuse(`${field}.tags lists "${tag}", which no operation of the document has.`)
			}
		}
		const catalog =
			selection.include === undefined && selection.exclude === undefined
				? whole
				: yield* importOpenApi(document, { ...selection, limits })
		if (catalog.operations.length === 0) {
			return refuse("The document has no operation that can be a tool after include and exclude.")
		}
		if (catalog.operations.length > MAX_API_SERVER_OPERATIONS) {
			return refuse(
				`The document has ${catalog.operations.length} operations after include and exclude; an API server has at most ${MAX_API_SERVER_OPERATIONS}. Narrow it with include or exclude.`,
			)
		}
		const tools = served(catalog)
		if (
			new TextEncoder().encode(JSON.stringify(tools)).length > MAX_API_SERVER_DESCRIPTORS_JSON_BYTES
		) {
			return refuse(
				`The picked operations come to more than ${MAX_API_SERVER_DESCRIPTORS_JSON_BYTES} bytes of tool descriptions. Narrow them with include or exclude.`,
			)
		}
		return { ok: true as const, catalog, tools }
	}).pipe(
		Effect.catchTag("OpenApiImportError", (error) =>
			Effect.succeed(
				refuse(
					error.pointer === undefined ? error.message : `${error.message} (at ${error.pointer})`,
				),
			),
		),
	)

export interface CatalogStorage {
	readonly get: (key: string) => string | undefined
	readonly put: (key: string, value: string) => void
	readonly clear: () => Promise<void>
	readonly setAlarm: (at: number) => Promise<void>
	readonly deleteAlarm: () => Promise<void>
}

const GONE = "This API's document is no longer stored."

/**
 * Custody of one API server's OpenAPI document. It arrives before the agent
 * version that declares it exists, so it is held unconfirmed and erases itself
 * unless that version, or a session using it, confirms it. What it serves is
 * read from the document each time the object wakes, never stored beside it.
 */
export const makeApiCatalog = (storage: CatalogStorage, now: () => number) => {
	let imported: ImportedApi | undefined

	const config = (): CatalogConfig | null => {
		const stored = storage.get(CONFIG)
		return stored === undefined ? null : Option.getOrNull(decodeConfig(stored))
	}
	const keep = async (): Promise<void> => {
		if (storage.get(STATUS) === "unconfirmed") {
			storage.put(STATUS, "kept")
			await storage.deleteAlarm()
		}
	}
	const open = async (): Promise<
		{ readonly api: ImportedApi; readonly config: CatalogConfig } | ApiSpecRefusal
	> => {
		const held = config()
		if (held === null) {
			return refuse(GONE)
		}
		if (imported === undefined) {
			const document = storage.get(DOCUMENT)
			if (document === undefined) {
				return refuse(GONE)
			}
			const read = await Effect.runPromise(importApiServer(document, held))
			if (!read.ok) {
				return read
			}
			imported = read
		}
		return { api: imported, config: held }
	}

	return {
		/** Holds the document. False when another document is already held under this name. */
		store: async (document: string, held: CatalogConfig): Promise<boolean> => {
			const current = config()
			if (current !== null) {
				return current.digest === held.digest && current.base_url === held.base_url
			}
			storage.put(DOCUMENT, document)
			storage.put(CONFIG, encodeConfig(held))
			storage.put(STATUS, "unconfirmed")
			await storage.setAlarm(now() + UNCONFIRMED_CATALOG_TTL_MS)
			return true
		},
		keep,
		expire: async (): Promise<void> => {
			if (storage.get(STATUS) === "unconfirmed") {
				imported = undefined
				await storage.clear()
				await storage.deleteAlarm()
			}
		},
		/** The API's tools. Only a session of an agent that declared the API asks, so asking confirms it. */
		tools: async (): Promise<CatalogTools> => {
			const opened = await open()
			if ("ok" in opened) {
				return opened
			}
			await keep()
			return { ok: true, tools: opened.api.tools }
		},
		request: async (name: string, args: Schema.JsonObject): Promise<CatalogRequest> => {
			const opened = await open()
			if ("ok" in opened) {
				return opened
			}
			const descriptor = Option.getOrUndefined(opened.api.catalog.descriptor(name))
			if (descriptor === undefined) {
				return refuse(`This API has no operation named "${name}".`)
			}
			const { buildRequest } = await import("./OpenApiRequest.ts")
			return Effect.runPromise(
				buildRequest(descriptor, args, opened.config.base_url).pipe(
					Effect.map((request) => ({ ok: true as const, request })),
					Effect.catchTag("OpenApiRequestError", (error) => Effect.succeed(refuse(error.message))),
				),
			)
		},
	}
}

export type ApiCatalogCustody = ReturnType<typeof makeApiCatalog>
