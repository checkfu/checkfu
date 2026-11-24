import { Agent } from "@checkfu/domain/Agent/Agent.aggregate"
import { AgentId } from "@checkfu/domain/Agent/Agent.id"
import { AgentVersionId } from "@checkfu/domain/Agent/AgentVersion.id"
import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "@checkfu/domain/Agent/AgentVersionByNumberView.view"
import { AgentView } from "@checkfu/domain/Agent/AgentView.view"
import { ArchiveAgent } from "@checkfu/domain/Agent/ArchiveAgent.command"
import { CreateAgent } from "@checkfu/domain/Agent/CreateAgent.command"
import { CreateAgentDecision } from "@checkfu/domain/Agent/CreateAgent.decision"
import { UpdateAgent } from "@checkfu/domain/Agent/UpdateAgent.command"
import { UpdateAgentDecision } from "@checkfu/domain/Agent/UpdateAgent.decision"
import { RepublishAgent } from "@checkfu/domain/Agent/RepublishAgent.command"
import { RepublishAgentDecision } from "@checkfu/domain/Agent/RepublishAgent.decision"
import type { AgentModel } from "@checkfu/domain/Agent/AgentTypes"
import {
	ApiServerList,
	MAX_API_SPEC_JSON_BYTES,
	apiServerSetId,
} from "@checkfu/domain/Mcp/ApiServers"
import type { ApiSelection, ApiServer } from "@checkfu/domain/Mcp/ApiServers"
import {
	CustomToolList,
	MAX_CUSTOM_TOOLS,
	MAX_CUSTOM_TOOL_INPUT_SCHEMA_LENGTH,
	customToolSetId,
} from "@checkfu/domain/Mcp/CustomTools"
import type { CustomTool } from "@checkfu/domain/Mcp/CustomTools"
import {
	McpServerSet,
	McpServerSetId,
	RecordMcpServers,
} from "@checkfu/domain/Mcp/McpServerSet.aggregate"
import { MAX_MCP_SERVERS_TEXT_LENGTH, McpServerList } from "@checkfu/domain/Mcp/McpServers"
import type { McpServer, McpToolPermissions } from "@checkfu/domain/Mcp/McpServers"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import { ApiCatalogExecutor } from "../OpenApi/ApiCatalogExecutor.ts"
import type { CatalogConfig } from "../OpenApi/ApiCatalogStore.ts"
import { ApiSpecCheck } from "../OpenApi/ApiSpecCheck.ts"
import { isReservedToolName } from "../Pi/PiToolNames.ts"
import { ToolSchemaCheck, externalReference } from "../Pi/PiToolSchemaCheck.ts"
import { resolveCatalogModel } from "../Pi/PiCatalog.ts"
import { IdempotencyClaim } from "@checkfu/domain/IdempotencyClaim/IdempotencyClaim.aggregate"
import { CheckfuApi } from "./Api.ts"
import {
	claimIdempotency,
	commitForStream,
	createClaimId,
	createCommandId,
	createFingerprint,
	handled,
	idempotentId,
	isPending,
	normalizeApiBaseUrl,
	normalizeModel,
	orPending,
	normalizeMcpServerUrl,
	present,
	randomId,
	reject,
} from "./HttpHelpers.ts"

export const AgentVersionWaitTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/AgentVersionWaitTimeout",
	{ defaultValue: () => "5 seconds" },
)

export const IsSupportedAgentModel = Context.Reference<(modelId: string) => boolean>(
	"@checkfu/api/IsSupportedAgentModel",
	{ defaultValue: () => (modelId) => resolveCatalogModel(modelId) !== null },
)

const unsupportedModel = (model: AgentModel) => reject(400, `Unsupported model "${model.id}".`)

interface ToolsetConfig {
	readonly default_config?: { readonly permission_policy?: { readonly type: McpPolicy } }
	readonly configs?: ReadonlyArray<{
		readonly name: string
		readonly permission_policy?: { readonly type: McpPolicy }
	}>
}
interface McpToolset extends ToolsetConfig {
	readonly type: "mcp_toolset"
	readonly mcp_server_name: string
}
interface ApiToolset extends ToolsetConfig {
	readonly type: "api_toolset"
	readonly api_server_name: string
}
type McpPolicy = NonNullable<McpToolPermissions["default"]>

// A toolset that sets nothing is the same as none.
const permissionsOf = (toolset: ToolsetConfig): McpToolPermissions | undefined => {
	const policy = toolset.default_config?.permission_policy?.type
	const tools = (toolset.configs ?? []).flatMap((config) =>
		config.permission_policy === undefined
			? []
			: [{ name: config.name, permission_policy: config.permission_policy.type }],
	)
	return policy === undefined && tools.length === 0
		? undefined
		: {
				...(policy === undefined ? {} : { default: policy }),
				...(tools.length === 0 ? {} : { tools }),
			}
}

const toolsetConfigOf = (permissions: McpToolPermissions): ToolsetConfig => ({
	...(permissions.default === undefined
		? {}
		: { default_config: { permission_policy: { type: permissions.default } } }),
	...(permissions.tools === undefined
		? {}
		: {
				configs: permissions.tools.map((tool) => ({
					name: tool.name,
					permission_policy: { type: tool.permission_policy },
				})),
			}),
})

const toolsetsOf = (servers: ReadonlyArray<McpServer>): Array<McpToolset> =>
	servers.flatMap((server) =>
		server.permissions === undefined
			? []
			: [
					{
						type: "mcp_toolset" as const,
						mcp_server_name: server.name,
						...toolsetConfigOf(server.permissions),
					},
				],
	)

const apiToolsetsOf = (servers: ReadonlyArray<ApiServer>): Array<ApiToolset> =>
	servers.flatMap((server) =>
		server.permissions === undefined
			? []
			: [
					{
						type: "api_toolset" as const,
						api_server_name: server.name,
						...toolsetConfigOf(server.permissions),
					},
				],
	)

interface ApiServerDeclaration {
	readonly name: string
	readonly base_url: string
	readonly spec: Schema.JsonObject
	readonly include?: ApiSelection
	readonly exclude?: ApiSelection
}

export interface ApiCatalogUpload {
	readonly catalog_id: string
	readonly document: string
	readonly config: CatalogConfig
}

const checkApiToolsets = (names: ReadonlyArray<string>, toolsets: ReadonlyArray<ApiToolset>) =>
	Effect.gen(function* () {
		for (const [index, toolset] of toolsets.entries()) {
			if (!names.includes(toolset.api_server_name)) {
				return yield* reject(
					400,
					`tools names API server "${toolset.api_server_name}", which is not in api_servers.`,
				)
			}
			if (
				toolsets.findIndex((other) => other.api_server_name === toolset.api_server_name) !== index
			) {
				return yield* reject(
					400,
					`API server "${toolset.api_server_name}" has more than one api_toolset.`,
				)
			}
			const configured = (toolset.configs ?? []).map((config) => config.name)
			if (new Set(configured).size !== configured.length) {
				return yield* reject(
					400,
					`The api_toolset of "${toolset.api_server_name}" configures a tool more than once.`,
				)
			}
		}
	})

const withApiPermissions = (
	servers: ReadonlyArray<ApiServer>,
	toolsets: ReadonlyArray<ApiToolset>,
): Array<ApiServer> =>
	servers.map(({ permissions: _replaced, ...server }) => {
		const toolset = toolsets.find((entry) => entry.api_server_name === server.name)
		const permissions = toolset === undefined ? undefined : permissionsOf(toolset)
		return permissions === undefined ? server : { ...server, permissions }
	})

const apiServersText = (servers: ReadonlyArray<ApiServer>) =>
	Effect.try({
		try: () => ApiServerList.encode(servers),
		catch: () => undefined,
	}).pipe(
		Effect.filterOrFail(
			(text) => text.length <= MAX_MCP_SERVERS_TEXT_LENGTH,
			() => undefined,
		),
		Effect.catch(() => reject(400, "api_servers and tools are too large together.")),
	)

/**
 * Reads each declared API server's document and says what to store for it.
 * The document itself goes to the server's catalog; what is recorded with the
 * agent version only names it.
 */
const declaredApiServers = (
	digest: Digest.Digest["Service"],
	versionId: string,
	declared: ReadonlyArray<ApiServerDeclaration>,
	mcpServerNames: ReadonlyArray<string>,
) =>
	Effect.gen(function* () {
		const servers: Array<ApiServer> = []
		const uploads: Array<ApiCatalogUpload> = []
		for (const server of declared) {
			if (servers.some((other) => other.name === server.name)) {
				return yield* reject(400, `API server name "${server.name}" is used more than once.`)
			}
			if (mcpServerNames.includes(server.name)) {
				return yield* reject(
					400,
					`"${server.name}" names both an API server and an MCP server. Names must be unique across both.`,
				)
			}
			const base_url = normalizeApiBaseUrl(server.base_url)
			if (base_url === undefined) {
				return yield* reject(
					400,
					`API server "${server.name}" has an invalid base_url: it must be a URL without a query string.`,
				)
			}
			const document = JSON.stringify(server.spec)
			const bytes = new TextEncoder().encode(document)
			if (bytes.length > MAX_API_SPEC_JSON_BYTES) {
				return yield* reject(
					400,
					`The spec of API server "${server.name}" is larger than ${MAX_API_SPEC_JSON_BYTES} bytes of JSON.`,
				)
			}
			const selection = {
				...(server.include === undefined ? {} : { include: server.include }),
				...(server.exclude === undefined ? {} : { exclude: server.exclude }),
			}
			const imported = yield* (yield* ApiSpecCheck).check(document, selection)
			if (!imported.ok) {
				return yield* reject(400, `The spec of API server "${server.name}": ${imported.message}`)
			}
			const fingerprint = `sha256:${yield* digest.digestHex(Digest.sha256, bytes)}`
			const catalog_id = `${versionId}/${server.name}`
			servers.push({
				type: "openapi",
				name: server.name,
				base_url,
				catalog_id,
				...selection,
				spec: {
					title: imported.title,
					version: imported.version,
					operations: imported.operations,
					digest: fingerprint,
				},
			})
			uploads.push({
				catalog_id,
				document,
				config: { base_url, digest: fingerprint, ...selection },
			})
		}
		return { servers, uploads }
	})

const mcpServersText = (
	servers: ReadonlyArray<Pick<McpServer, "type" | "name" | "url">>,
	toolsets: ReadonlyArray<McpToolset>,
) =>
	Effect.gen(function* () {
		const normalized: Array<McpServer> = []
		for (const [index, toolset] of toolsets.entries()) {
			if (!servers.some((server) => server.name === toolset.mcp_server_name)) {
				return yield* reject(
					400,
					`tools names MCP server "${toolset.mcp_server_name}", which is not in mcp_servers.`,
				)
			}
			if (
				toolsets.findIndex((other) => other.mcp_server_name === toolset.mcp_server_name) !== index
			) {
				return yield* reject(
					400,
					`MCP server "${toolset.mcp_server_name}" has more than one mcp_toolset.`,
				)
			}
			const names = (toolset.configs ?? []).map((config) => config.name)
			if (new Set(names).size !== names.length) {
				return yield* reject(
					400,
					`The mcp_toolset of "${toolset.mcp_server_name}" configures a tool more than once.`,
				)
			}
		}
		for (const server of servers) {
			const url = normalizeMcpServerUrl(server.url)
			if (url === undefined) {
				return yield* reject(400, `MCP server "${server.name}" has an invalid url.`)
			}
			if (normalized.some((other) => other.name === server.name)) {
				return yield* reject(400, `MCP server name "${server.name}" is used more than once.`)
			}
			const toolset = toolsets.find((entry) => entry.mcp_server_name === server.name)
			const permissions = toolset === undefined ? undefined : permissionsOf(toolset)
			normalized.push({
				type: "url",
				name: server.name,
				url,
				...(permissions === undefined ? {} : { permissions }),
			})
		}
		const text = yield* Effect.try({
			try: () => McpServerList.encode(normalized),
			catch: () => undefined,
		}).pipe(Effect.catch(() => reject(400, "mcp_servers and tools are too large together.")))
		if (text.length > MAX_MCP_SERVERS_TEXT_LENGTH) {
			return yield* reject(
				400,
				`The agent's mcp_servers and tools take ${text.length} characters; at most ${MAX_MCP_SERVERS_TEXT_LENGTH} fit.`,
			)
		}
		return text
	})

/**
 * Whether an update changes the head's configuration, as `UpdateAgentDecision`
 * decides it. Only such an update, or one that replaces the servers, mints a
 * version, so only then are the next version's servers staged.
 */
const changesConfiguration = (
	head: {
		readonly name: string
		readonly model_id: string
		readonly has_system: boolean
		readonly system: string
		readonly has_description: boolean
		readonly description: string
	},
	changes: {
		readonly name?: string | undefined
		readonly model?: { readonly id: string } | undefined
		readonly system?: string | null | undefined
		readonly description?: string | null | undefined
	},
): boolean =>
	![
		changes.name === undefined || changes.name === head.name,
		changes.model === undefined || changes.model.id === head.model_id,
		changes.system === undefined ||
			(changes.system === null
				? !head.has_system
				: head.has_system && changes.system === head.system),
		changes.description === undefined ||
			(changes.description === null
				? !head.has_description
				: head.has_description && changes.description === head.description),
	].every(Boolean)

type AgentTool = McpToolset | ApiToolset | CustomTool

const toolsetsIn = (tools: ReadonlyArray<AgentTool>) =>
	tools.filter((tool): tool is McpToolset => tool.type === "mcp_toolset")
const apiToolsetsIn = (tools: ReadonlyArray<AgentTool>) =>
	tools.filter((tool): tool is ApiToolset => tool.type === "api_toolset")
const customToolsIn = (tools: ReadonlyArray<AgentTool>) =>
	tools.filter((tool): tool is CustomTool => tool.type === "custom")

const customToolsText = (tools: ReadonlyArray<CustomTool>) =>
	Effect.gen(function* () {
		if (tools.length > MAX_CUSTOM_TOOLS) {
			return yield* reject(400, `An agent has at most ${MAX_CUSTOM_TOOLS} custom tools.`)
		}
		for (const [index, tool] of tools.entries()) {
			if (tools.findIndex((other) => other.name === tool.name) !== index) {
				return yield* reject(400, `Custom tool name "${tool.name}" is used more than once.`)
			}
			if (isReservedToolName(tool.name)) {
				return yield* reject(
					400,
					`Custom tool name "${tool.name}" is reserved: it starts with mcp__ or api__, or names a built-in tool.`,
				)
			}
			if (tool.input_schema["type"] !== "object") {
				return yield* reject(
					400,
					`The input_schema of custom tool "${tool.name}" must have type "object".`,
				)
			}
			if (JSON.stringify(tool.input_schema).length > MAX_CUSTOM_TOOL_INPUT_SCHEMA_LENGTH) {
				return yield* reject(
					400,
					`The input_schema of custom tool "${tool.name}" is longer than ${MAX_CUSTOM_TOOL_INPUT_SCHEMA_LENGTH} characters of JSON.`,
				)
			}
			const reference = externalReference(tool.input_schema)
			if (reference !== undefined) {
				return yield* reject(
					400,
					`The input_schema of custom tool "${tool.name}" references "${reference}", which cannot be resolved: only references within the schema (starting with #) are supported.`,
				)
			}
		}
		// Pi checks every call's arguments against its tool's schema, so a schema Pi cannot compile
		// is refused now rather than failing the agent's calls later.
		const checkable =
			tools.length === 0
				? []
				: yield* (yield* ToolSchemaCheck).checkable(tools.map((tool) => tool.input_schema))
		const uncheckable = tools.find((_, index) => checkable[index] !== true)
		if (uncheckable !== undefined) {
			return yield* reject(
				400,
				`The input_schema of custom tool "${uncheckable.name}" is not a valid JSON Schema: check its $ref and pattern keywords.`,
			)
		}
		const text = CustomToolList.encode(
			tools.map(({ type, name, description, input_schema }) => ({
				type,
				name,
				description,
				input_schema,
			})),
		)
		return text.length > MAX_MCP_SERVERS_TEXT_LENGTH
			? yield* reject(400, "The agent's custom tools are too large together.")
			: text
	})

const toolFields = (servers: string, apiServers: string, customTools: string) => {
	const decoded = McpServerList.decode(servers)
	const apis = ApiServerList.decode(apiServers)
	return {
		mcp_servers: decoded.map((server) => ({
			type: server.type,
			name: server.name,
			url: server.url,
		})),
		api_servers: apis.map((server) => ({
			type: server.type,
			name: server.name,
			base_url: server.base_url,
			...(server.include === undefined ? {} : { include: server.include }),
			...(server.exclude === undefined ? {} : { exclude: server.exclude }),
			spec: server.spec,
		})),
		tools: [...toolsetsOf(decoded), ...apiToolsetsOf(apis), ...CustomToolList.decode(customTools)],
	}
}

export const AgentsLive = HttpApiBuilder.group(CheckfuApi, "agents", (handlers) =>
	Effect.gen(function* () {
		const agents = yield* Agent
		const createAgent = yield* CreateAgentDecision
		const updateAgent = yield* UpdateAgentDecision
		const republishAgent = yield* RepublishAgentDecision
		const agentViews = yield* AgentView
		const agentVersionsByNumber = yield* AgentVersionByNumberView
		const serverSets = yield* McpServerSet
		const catalogs = yield* ApiCatalogExecutor
		const idempotencyClaims = yield* IdempotencyClaim
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom
		const isSupportedModel = yield* IsSupportedAgentModel
		const supported = (model: AgentModel) =>
			isSupportedModel(model.id) ? Effect.void : unsupportedModel(model)

		// A version's servers and custom tools are recorded under its id before the version is minted.
		const recorded = (set_id: McpServerSetId) =>
			Effect.map(serverSets.get(set_id), (set) => set.servers)
		const record = (set_id: McpServerSetId, servers: string) =>
			servers === "" ? Effect.void : serverSets.send(new RecordMcpServers({ set_id, servers }))
		const serversOf = (versionId: string) => recorded(McpServerSetId.make(versionId))
		const apiServersOf = (versionId: string) => recorded(apiServerSetId(versionId))
		const customToolsOf = (versionId: string) => recorded(customToolSetId(versionId))
		const recordTools = (
			versionId: string,
			servers: string,
			apiServers: string,
			customTools: string,
		) =>
			Effect.all(
				[
					record(McpServerSetId.make(versionId), servers),
					record(apiServerSetId(versionId), apiServers),
					record(customToolSetId(versionId), customTools),
				],
				{ discard: true },
			)
		// A document is stored before the version that names it is recorded, and confirmed after.
		const storeCatalogs = (uploads: ReadonlyArray<ApiCatalogUpload>) =>
			Effect.forEach(
				uploads,
				(upload) =>
					catalogs.store(upload.catalog_id, upload.document, upload.config).pipe(
						Effect.catchTag("ApiCatalogCallFailed", () =>
							reject(503, "API document storage is unavailable. Try again."),
						),
						Effect.flatMap((stored) =>
							stored
								? Effect.void
								: reject(409, "A different document is already stored for this API server."),
						),
					),
				{ discard: true },
			)
		const toolFieldsOf = (versionId: string) =>
			Effect.map(
				Effect.all([serversOf(versionId), apiServersOf(versionId), customToolsOf(versionId)]),
				([servers, apiServers, customTools]) => toolFields(servers, apiServers, customTools),
			)
		const serializeAgent = <A extends { readonly current_version_id: string }>(agent: A) =>
			Effect.map(toolFieldsOf(agent.current_version_id), (fields) => ({ ...agent, ...fields }))

		const loadCommittedAgentVersion = (
			id: AgentId,
			version: number,
			agentCommit: { readonly stream: string; readonly version: number } | undefined,
			missingMessage: string,
		) =>
			Effect.gen(function* () {
				const waitTimeout = yield* AgentVersionWaitTimeout
				const headResult = yield* agentViews
					.get(Agent.ref(id), agentCommit === undefined ? {} : { atLeast: agentCommit })
					.pipe(orPending(id, "agent"))
				if (isPending(headResult)) {
					return headResult
				}
				let head = Option.getOrNull(headResult)
				if (head === null && agentCommit === undefined) {
					const waitedHead = yield* agentViews
						.waitFor(Agent.ref(id), { version: { gte: version } }, { timeout: waitTimeout })
						.pipe(orPending(id, "agent"))
					if (isPending(waitedHead)) {
						return waitedHead
					}
					head = waitedHead
				}
				const lookupKey = agentVersionLookupKey(id, version)
				const versionResult = yield* agentVersionsByNumber
					.get(
						lookupKey,
						agentCommit === undefined ? {} : { atLeast: agentCommit, timeout: waitTimeout },
					)
					.pipe(orPending(id, "agent"))
				if (isPending(versionResult)) {
					return versionResult
				}
				let minted = Option.getOrNull(versionResult)
				if (minted === null && agentCommit === undefined) {
					const waitedVersion = yield* agentVersionsByNumber
						.waitFor(lookupKey, { version }, { timeout: waitTimeout })
						.pipe(orPending(id, "agent"))
					if (isPending(waitedVersion)) {
						return waitedVersion
					}
					minted = waitedVersion
				}
				if (head === null || minted === null) {
					return yield* reject(500, missingMessage)
				}
				return {
					id,
					type: "agent" as const,
					version: minted.version,
					name: minted.name,
					model: minted.model,
					system: minted.system,
					description: minted.description,
					...(yield* toolFieldsOf(minted.id)),
					created_at: head.created_at,
					updated_at: minted.created_at,
					archived_at: null,
				}
			})

		return handlers
			.handle("create", ({ payload, headers }) =>
				Effect.gen(function* () {
					const idempotencyKey = headers["idempotency-key"]
					const model = normalizeModel(payload.model)
					const system = payload.system ?? null
					const description = payload.description ?? null
					const tools = payload.tools ?? []
					const mcpServers = yield* mcpServersText(payload.mcp_servers ?? [], toolsetsIn(tools))
					const customTools = yield* customToolsText(customToolsIn(tools))
					const declaredApis = payload.api_servers ?? []
					const apiToolsets = apiToolsetsIn(tools)
					yield* checkApiToolsets(
						declaredApis.map((server) => server.name),
						apiToolsets,
					)
					const apiPlan = (forVersion: string) =>
						Effect.gen(function* () {
							const plan = yield* declaredApiServers(
								digest,
								forVersion,
								declaredApis,
								(payload.mcp_servers ?? []).map((server) => server.name),
							)
							return {
								uploads: plan.uploads,
								text: yield* apiServersText(withApiPermissions(plan.servers, apiToolsets)),
							}
						})
					let id: AgentId
					let versionId: AgentVersionId
					let apis: Effect.Success<ReturnType<typeof apiPlan>>
					let sendOptions: { readonly commandId: string } | undefined
					if (idempotencyKey !== undefined) {
						id = AgentId.make(
							yield* idempotentId(digest, "agent", ["create", "agent", "id", idempotencyKey]),
						)
						versionId = AgentVersionId.make(
							yield* idempotentId(digest, "aver", ["create", "agent", "version", idempotencyKey]),
						)
						apis = yield* apiPlan(versionId)
						const batchId = yield* createClaimId(digest, "agent", idempotencyKey)
						const fingerprint = yield* createFingerprint(digest, {
							name: payload.name,
							model,
							system,
							description,
							...(mcpServers === "" ? {} : { mcp_servers: mcpServers }),
							...(apis.text === "" ? {} : { api_servers: apis.text }),
							...(customTools === "" ? {} : { custom_tools: customTools }),
						})
						if (!isSupportedModel(model.id)) {
							const claim = yield* idempotencyClaims.get(batchId)
							if (claim._tag === "Unclaimed") {
								return yield* unsupportedModel(model)
							}
							if (claim.fingerprint !== fingerprint) {
								yield* claimIdempotency(idempotencyClaims, batchId, fingerprint)
							}
							const committed = yield* agents.get(id)
							if (committed.status === "") {
								return yield* unsupportedModel(model)
							}
						} else {
							yield* claimIdempotency(idempotencyClaims, batchId, fingerprint)
						}
						sendOptions = { commandId: yield* createCommandId(digest, "agent", idempotencyKey) }
					} else {
						yield* supported(model)
						id = AgentId.make(yield* randomId(random, "agent"))
						versionId = AgentVersionId.make(yield* randomId(random, "aver"))
						apis = yield* apiPlan(versionId)
					}
					yield* storeCatalogs(apis.uploads)
					yield* recordTools(versionId, mcpServers, apis.text, customTools)
					const receipt = yield* createAgent.send(
						new CreateAgent({
							agent_id: id,
							version_id: versionId,
							name: payload.name,
							model,
							system,
							description,
						}),
						sendOptions,
					)
					return yield* loadCommittedAgentVersion(
						id,
						receipt.reply.version,
						commitForStream(receipt.commits, `Agent/${id}`),
						"Failed to load created agent.",
					)
				}).pipe(handled),
			)
			.handle("get", ({ params }) =>
				Effect.gen(function* () {
					const id = params.agent_id
					const ref = Agent.ref(id)
					const found = Option.getOrNull(yield* agentViews.get(ref))
					if (found !== null) {
						return yield* serializeAgent(found)
					}
					const committed = yield* agents.get(id)
					if (committed.status === "") {
						return yield* reject(404, `Agent ${id} not found.`)
					}
					const projected = yield* agentViews.waitFor(
						ref,
						{ version: { gte: 1 } },
						{ timeout: yield* AgentVersionWaitTimeout },
					)
					if (projected === null) {
						return yield* reject(503, `Agent ${id} projection is not ready.`)
					}
					return yield* serializeAgent(projected)
				}).pipe(handled),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const id = params.agent_id
					const {
						version,
						model: modelInput,
						mcp_servers: servers,
						api_servers: declaredApis,
						tools,
						...fields
					} = payload
					const toolsets = tools === undefined ? undefined : toolsetsIn(tools)
					const model = modelInput === undefined ? undefined : normalizeModel(modelInput)
					if (model !== undefined) {
						yield* supported(model)
					}
					// The next version keeps this version's servers unless the request replaces them.
					// An update of anything but the head is refused below and records nothing here.
					const head = yield* agents.get(id)
					const isHead = head.status === "active" && head.version === version
					const current = isHead ? yield* serversOf(head.current_version_id) : ""
					// Replaced servers keep the policies of the ones that stay; replaced tools replace them all.
					const kept = McpServerList.decode(current)
					const nextServers = servers ?? kept
					const next =
						servers === undefined && toolsets === undefined
							? current
							: yield* mcpServersText(
									nextServers,
									toolsets ??
										toolsetsOf(kept).filter((toolset) =>
											nextServers.some((server) => server.name === toolset.mcp_server_name),
										),
								)
					// Replaced tools replace the custom tools too; otherwise the next version keeps them.
					const currentCustomTools = isHead ? yield* customToolsOf(head.current_version_id) : ""
					const nextCustomTools =
						tools === undefined ? currentCustomTools : yield* customToolsText(customToolsIn(tools))
					const nextVersionId = AgentVersionId.make(yield* randomId(random, "aver"))
					// Replaced API servers bring their documents again; kept ones keep the documents they have.
					const currentApis = isHead ? yield* apiServersOf(head.current_version_id) : ""
					const keptApis = ApiServerList.decode(currentApis)
					const nextMcpNames = McpServerList.decode(next).map((server) => server.name)
					const replacedApis =
						declaredApis === undefined
							? undefined
							: yield* declaredApiServers(digest, nextVersionId, declaredApis, nextMcpNames)
					const nextApiServers = replacedApis?.servers ?? keptApis
					const collision = nextApiServers.find((server) => nextMcpNames.includes(server.name))
					if (collision !== undefined) {
						return yield* reject(
							400,
							`"${collision.name}" names both an API server and an MCP server. Names must be unique across both.`,
						)
					}
					const nextApiToolsets =
						tools === undefined
							? apiToolsetsOf(keptApis).filter((toolset) =>
									nextApiServers.some((server) => server.name === toolset.api_server_name),
								)
							: apiToolsetsIn(tools)
					yield* checkApiToolsets(
						nextApiServers.map((server) => server.name),
						nextApiToolsets,
					)
					const nextApis =
						declaredApis === undefined && tools === undefined
							? currentApis
							: yield* apiServersText(withApiPermissions(nextApiServers, nextApiToolsets))
					const uploads = replacedApis?.uploads ?? []
					const changes = model === undefined ? fields : { ...fields, model }
					// Servers and tools are staged only for a version that will be minted, so an update
					// that changes nothing leaves nothing behind.
					const staged =
						isHead &&
						(next !== current ||
							nextApis !== currentApis ||
							nextCustomTools !== currentCustomTools ||
							changesConfiguration(head, changes))
					if (staged) {
						yield* storeCatalogs(uploads)
						yield* recordTools(nextVersionId, next, nextApis, nextCustomTools)
					}
					const updated = yield* updateAgent.send(
						new UpdateAgent({
							agent_id: id,
							expected_version: version,
							next_version_id: nextVersionId,
							changes,
						}),
					)
					if (!staged && updated.reply.version !== version) {
						yield* recordTools(updated.reply.version_id, next, nextApis, nextCustomTools)
					}
					// An update that changed nothing else mints no version, so new servers or tools get their own.
					const receipt =
						(next !== current ||
							nextApis !== currentApis ||
							nextCustomTools !== currentCustomTools) &&
						updated.reply.version === version
							? yield* republishAgent.send(
									new RepublishAgent({
										agent_id: id,
										expected_version: version,
										next_version_id: nextVersionId,
									}),
								)
							: updated
					return yield* loadCommittedAgentVersion(
						id,
						receipt.reply.version,
						commitForStream(receipt.commits, `Agent/${id}`),
						"Failed to load updated agent.",
					)
				}).pipe(handled),
			)
			.handle("archive", ({ params }) =>
				Effect.gen(function* () {
					const id = params.agent_id
					const receipt = yield* agents.send(new ArchiveAgent({ agent_id: id }))
					const result = yield* agentViews
						.get(Agent.ref(id), { atLeast: receipt })
						.pipe(orPending(id, "agent"))
					if (isPending(result)) {
						return result
					}
					return yield* serializeAgent(yield* present(result, 404, `Agent ${id} not found.`))
				}).pipe(handled),
			)
	}),
)
