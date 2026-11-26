import {
	ArchiveAgentIfCurrent,
	ArchiveAgentIfCurrentDecision,
} from "@checkfu/domain/Automation/GuardedArchives"
import { AutomationView } from "@checkfu/domain/Automation/AutomationView.view"
import { normalizeAgentCreateBody, normalizeAgentModel } from "@checkfu/sdk/AgentInput"
import { MAX_MODEL_ID_LENGTH } from "@checkfu/pi-providers/catalog"
import { Agent } from "@checkfu/domain/Agent/Agent.aggregate"
import { AgentId } from "@checkfu/domain/Agent/Agent.id"
import { AgentVersionId } from "@checkfu/domain/Agent/AgentVersion.id"
import {
	AgentVersionByNumberView,
	agentVersionLookupKey,
} from "@checkfu/domain/Agent/AgentVersionByNumberView.view"
import type { AgentSnapshot } from "@checkfu/domain/Agent/AgentView.view"
import { AgentView } from "@checkfu/domain/Agent/AgentView.view"
import { ArchiveAgent } from "@checkfu/domain/Agent/ArchiveAgent.command"
import { CreateAgent } from "@checkfu/domain/Agent/CreateAgent.command"
import { CreateAgentDecision } from "@checkfu/domain/Agent/CreateAgent.decision"
import { AgentArchivedError } from "@checkfu/domain/Agent/AgentArchived.rejection"
import { AgentNotFound } from "@checkfu/domain/Agent/AgentNotFound.rejection"
import { AgentVersionConflict, UpdateAgent } from "@checkfu/domain/Agent/UpdateAgent.command"
import { UpdateAgentDecision } from "@checkfu/domain/Agent/UpdateAgent.decision"
import type { AgentModel } from "@checkfu/domain/Agent/AgentTypes"
import {
	MAX_AGENT_TOOLS_TEXT_LENGTH,
	decodeAgentTools,
	decodeMcpServers,
	encodeAgentTools,
	encodeMcpServers,
} from "@checkfu/domain/Mcp/McpServers"
import type { AgentTool, McpServer } from "@checkfu/domain/Mcp/McpServers"
import { RESERVED_TOOL_NAMES } from "@checkfu/sdk/Api"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Option from "effect/Option"
import { configuredApiCustomProviders, resolveCatalogModel } from "../Pi/PiCatalog.ts"
import { CheckfuApi } from "./Api.ts"
import { makeLister } from "./Listing.ts"
import { CustomToolFaults } from "./ToolSchemas.ts"
import {
	IDEMPOTENCY_KEY_REUSED,
	commitForStream,
	createIdentity,
	handled,
	idempotentId,
	isPending,
	orPending,
	present,
	randomId,
	reject,
} from "./HttpHelpers.ts"

export const AgentVersionWaitTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/AgentVersionWaitTimeout",
	{ defaultValue: () => "5 seconds" },
)

const defaultIsSupportedModel = (modelId: string) => resolveCatalogModel(modelId) !== null

export const IsSupportedAgentModel = Context.Reference<(modelId: string) => boolean>(
	"@checkfu/api/IsSupportedAgentModel",
	{ defaultValue: () => defaultIsSupportedModel },
)

const unsupportedModel = (model: AgentModel, emptyCreate = false) =>
	reject(
		400,
		model.id.length > MAX_MODEL_ID_LENGTH
			? `Model id must be at most ${MAX_MODEL_ID_LENGTH} characters.`
			: `Unsupported model "${model.id}".`,
		emptyCreate ? { code: "agent_model_unavailable" } : undefined,
	)

const versionPage = (id: AgentId, version: number): string =>
	`page_${encodeURIComponent(id)}:${version}`

const declaredMcpServers = (servers: ReadonlyArray<McpServer>) =>
	Effect.gen(function* () {
		const text = encodeMcpServers(servers)
		if (text === undefined) {
			return yield* reject(400, "The MCP servers are too long once their URLs are normalized.")
		}
		return { servers, text }
	})

const toolsetsNameServers = (tools: ReadonlyArray<AgentTool>, servers: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		for (const tool of tools) {
			if (tool.type === "mcp_toolset" && !servers.includes(tool.mcp_server_name)) {
				return yield* reject(
					400,
					`mcp_toolset names "${tool.mcp_server_name}", which is not one of the agent's MCP servers.`,
				)
			}
		}
	})

const declaredTools = (tools: ReadonlyArray<AgentTool>, servers: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		yield* toolsetsNameServers(tools, servers)
		const customTools = tools.filter((tool) => tool.type === "custom")
		if (customTools.length > 0) {
			const faults = yield* (yield* CustomToolFaults)(
				customTools.map(({ name, input_schema }) => ({ name, input_schema })),
				RESERVED_TOOL_NAMES,
			).pipe(
				Effect.catchTag("CustomToolsUncheckable", () =>
					reject(503, "The custom tools could not be checked. Try again."),
				),
			)
			for (const [index, tool] of customTools.entries()) {
				const fault = faults[index]
				if (fault !== null && fault !== undefined) {
					return yield* reject(400, `The custom tool "${tool.name}" cannot be declared: ${fault}`)
				}
			}
		}
		const text = encodeAgentTools(tools)
		if (text === undefined) {
			return yield* reject(
				400,
				`The agent's tools are more than ${MAX_AGENT_TOOLS_TEXT_LENGTH} characters of JSON.`,
			)
		}
		return { tools, text }
	})

export const AgentsLive = HttpApiBuilder.group(CheckfuApi, "agents", (handlers) =>
	Effect.gen(function* () {
		const agents = yield* Agent
		const createAgent = yield* CreateAgentDecision
		const updateAgent = yield* UpdateAgentDecision
		const agentViews = yield* AgentView
		const agentVersionsByNumber = yield* AgentVersionByNumberView
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom
		const customProviders = yield* configuredApiCustomProviders
		const providedIsSupportedModel = yield* IsSupportedAgentModel
		const isSupportedModel =
			providedIsSupportedModel === defaultIsSupportedModel
				? (modelId: string) => resolveCatalogModel(modelId, customProviders) !== null
				: providedIsSupportedModel
		const list = yield* makeLister
		const automationViews = yield* AutomationView
		const guardedArchive = yield* ArchiveAgentIfCurrentDecision

		const retrieve = (id: AgentId) =>
			Effect.gen(function* () {
				const ref = Agent.ref(id)
				const found = Option.getOrNull(yield* agentViews.get(ref))
				if (found !== null) {
					return found
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
				return projected
			})
		const readVersion = (head: AgentSnapshot, version: number) =>
			Effect.gen(function* () {
				const id = head.id
				const key = agentVersionLookupKey(id, version)
				const existing = Option.getOrNull(yield* agentVersionsByNumber.get(key))
				const snapshot =
					existing ??
					(yield* agentVersionsByNumber.waitFor(
						key,
						{ version },
						{
							timeout: yield* AgentVersionWaitTimeout,
						},
					))
				if (snapshot === null) {
					return yield* reject(503, `Agent ${id} version ${version} projection is not ready.`)
				}
				return {
					...head,
					version,
					name: snapshot.name,
					model: snapshot.model,
					system: snapshot.system,
					description: snapshot.description,
					mcp_servers: snapshot.mcp_servers,
					tools: snapshot.tools,
					updated_at: snapshot.created_at,
				}
			})

		const retrieveVersion = (id: AgentId, version: number) =>
			Effect.gen(function* () {
				const head = yield* retrieve(id)
				const committed = yield* agents.get(id)
				if (version > committed.version) {
					return yield* reject(404, `Agent ${id} version ${version} not found.`)
				}
				return yield* readVersion(head, version)
			})

		const supported = (model: AgentModel) =>
			model.id.length <= MAX_MODEL_ID_LENGTH && isSupportedModel(model.id)
				? Effect.void
				: unsupportedModel(model)

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
					mcp_servers: minted.mcp_servers,
					tools: minted.tools,
					created_at: head.created_at,
					updated_at: minted.created_at,
					archived_at: null,
				}
			})

		const archiveCommit = Effect.fnUntraced(function* (id: AgentId, version?: number) {
			if (version === undefined) {
				return yield* agents.send(new ArchiveAgent({ agent_id: id }))
			}
			const { withArchiveInventory } = yield* Effect.promise(() => import("./ArchiveInventory.ts"))
			const receipt = yield* withArchiveInventory(list, automationViews, (inventory) =>
				guardedArchive.send(
					new ArchiveAgentIfCurrent({ agent_id: id, expected_version: version, inventory }),
				),
			)
			return commitForStream(receipt.commits, `Agent/${id}`)
		})

		const archive = (id: AgentId, version?: number) =>
			Effect.gen(function* () {
				const commit = yield* archiveCommit(id, version)
				const result = yield* agentViews
					.get(Agent.ref(id), commit === undefined ? {} : { atLeast: commit })
					.pipe(orPending(id, "agent"))
				if (isPending(result)) {
					return result
				}
				return yield* present(result, 404, `Agent ${id} not found.`)
			}).pipe(handled)

		return handlers
			.handle("create", ({ payload, headers }) =>
				Effect.gen(function* () {
					const idempotencyKey = headers["idempotency-key"]
					const {
						name,
						model,
						system,
						description,
						mcp_servers,
						tools: toolInput,
					} = normalizeAgentCreateBody(payload)
					const mcpServers = yield* declaredMcpServers(mcp_servers ?? [])
					const tools = yield* declaredTools(
						toolInput ?? [],
						mcpServers.servers.map((server) => server.name),
					)
					const identity = yield* createIdentity(digest, random, {
						resource: "agent",
						prefix: "agent",
						key: idempotencyKey,
						body: {
							name,
							model,
							system,
							description,
							mcp_servers: mcpServers.servers,
							tools: tools.tools,
						},
					})
					const id = AgentId.make(identity.id)
					const versionId = AgentVersionId.make(
						idempotencyKey === undefined
							? yield* randomId(random, "aver")
							: yield* idempotentId(digest, "aver", ["create", "agent", "version", idempotencyKey]),
					)
					if (idempotencyKey === undefined) {
						yield* supported(model)
					} else if (
						(model.id.length > MAX_MODEL_ID_LENGTH || !isSupportedModel(model.id)) &&
						(yield* agents.get(id)).status === ""
					) {
						return yield* unsupportedModel(model, true)
					}
					const sendOptions = identity.options
					const receipt = yield* createAgent
						.send(
							new CreateAgent({
								agent_id: id,
								version_id: versionId,
								name,
								model,
								system,
								description,
								mcp_servers: mcpServers.text,
								tools: tools.text,
							}),
							sendOptions,
						)
						.pipe(
							Effect.catchTag("AgentAlreadyExists", () =>
								reject(409, IDEMPOTENCY_KEY_REUSED, { code: "idempotency_key_reused" }),
							),
						)
					return yield* loadCommittedAgentVersion(
						id,
						receipt.reply.version,
						commitForStream(receipt.commits, `Agent/${id}`),
						"Failed to load created agent.",
					)
				}).pipe(handled),
			)
			.handle("list", ({ query }) =>
				list("agent", query, (id) => retrieve(AgentId.make(id))).pipe(handled),
			)
			.handle("get", ({ params, query }) =>
				(query.version === undefined
					? retrieve(params.agent_id)
					: retrieveVersion(params.agent_id, query.version)
				).pipe(handled),
			)
			.handle("listVersions", ({ params, query }) =>
				Effect.gen(function* () {
					const id = params.agent_id
					const head = yield* retrieve(id)
					const committed = yield* agents.get(id)
					const start =
						query.page === undefined
							? committed.version
							: Number(query.page.slice(query.page.lastIndexOf(":") + 1))
					if (
						query.page !== undefined &&
						(!Number.isSafeInteger(start) ||
							start < 1 ||
							start > committed.version ||
							versionPage(id, start) !== query.page)
					) {
						return yield* reject(400, "Invalid agent version page.")
					}
					const size = Math.min(start, query.limit ?? 50)
					const data = yield* Effect.forEach(
						Array.from({ length: size }, (_, index) => start - index),
						(version) => readVersion(head, version),
						{ concurrency: 8 },
					)
					const next = start - size
					return { data, next_page: next > 0 ? versionPage(id, next) : null }
				}).pipe(handled),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const id = params.agent_id
					const {
						version,
						model: modelInput,
						mcp_servers: servers,
						tools: toolsInput,
						...named
					} = payload
					const model = modelInput === undefined ? undefined : normalizeAgentModel(modelInput)
					if (model !== undefined) {
						yield* supported(model)
					}
					const declared = servers === undefined ? undefined : yield* declaredMcpServers(servers)
					const head =
						servers === undefined && toolsInput === undefined ? undefined : yield* agents.get(id)
					if (head !== undefined) {
						if (head.status === "") {
							return yield* new AgentNotFound({ agent_id: id })
						}
						if (head.status !== "active") {
							return yield* new AgentArchivedError({ agent_id: id })
						}
						if (version !== undefined && head.version !== version) {
							return yield* new AgentVersionConflict({
								agent_id: id,
								expected_version: version,
								current_version: head.version,
							})
						}
					}
					const serverNames = (
						declared?.servers ?? (head === undefined ? [] : decodeMcpServers(head.mcp_servers))
					).map((server) => server.name)
					const tools =
						toolsInput === undefined ? undefined : yield* declaredTools(toolsInput, serverNames)
					if (toolsInput === undefined && head !== undefined) {
						yield* toolsetsNameServers(decodeAgentTools(head.tools), serverNames)
					}
					const fields = {
						...named,
						...(declared === undefined ? {} : { mcp_servers: declared.text }),
						...(tools === undefined ? {} : { tools: tools.text }),
					}
					const expectedVersion = version ?? head?.version
					const receipt = yield* updateAgent.send(
						new UpdateAgent({
							agent_id: id,
							...(expectedVersion === undefined ? {} : { expected_version: expectedVersion }),
							next_version_id: AgentVersionId.make(yield* randomId(random, "aver")),
							changes: model === undefined ? fields : { ...fields, model },
						}),
					)
					return yield* loadCommittedAgentVersion(
						id,
						receipt.reply.version,
						commitForStream(receipt.commits, `Agent/${id}`),
						"Failed to load updated agent.",
					)
				}).pipe(handled),
			)
			.handle("archive", ({ params }) => archive(params.agent_id))
			.handle("archiveIfCurrent", ({ params, payload }) =>
				archive(params.agent_id, payload.version),
			)
	}),
)
