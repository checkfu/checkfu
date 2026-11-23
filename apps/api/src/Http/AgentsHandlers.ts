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
import type { AgentModel } from "@checkfu/domain/Agent/AgentTypes"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Option from "effect/Option"
import { resolveCatalogModel } from "../Pi/PiCatalog.ts"
import { CheckfuApi } from "./Api.ts"
import { makeLister } from "./Listing.ts"
import {
	IDEMPOTENCY_KEY_REUSED,
	archiveAndRead,
	commitForStream,
	createCommandId,
	handled,
	idempotentId,
	isPending,
	normalizeModel,
	orPending,
	randomId,
	readExisting,
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

export const AgentsLive = HttpApiBuilder.group(CheckfuApi, "agents", (handlers) =>
	Effect.gen(function* () {
		const agents = yield* Agent
		const createAgent = yield* CreateAgentDecision
		const updateAgent = yield* UpdateAgentDecision
		const agentViews = yield* AgentView
		const agentVersionsByNumber = yield* AgentVersionByNumberView
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom
		const isSupportedModel = yield* IsSupportedAgentModel
		const list = yield* makeLister

		const retrieve = (id: AgentId) => {
			const ref = Agent.ref(id)
			return readExisting({
				current: agentViews.get(ref),
				missing: Effect.flatMap(agents.get(id), (committed) =>
					committed.status === "" ? reject(404, `Agent ${id} not found.`) : Effect.void,
				),
				projected: Effect.flatMap(AgentVersionWaitTimeout, (timeout) =>
					agentViews.waitFor(ref, { version: { gte: 1 } }, { timeout }),
				),
			})
		}
		const supported = (model: AgentModel) =>
			isSupportedModel(model.id) ? Effect.void : unsupportedModel(model)

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
					let id: AgentId
					let versionId: AgentVersionId
					let sendOptions: { readonly commandId: string } | undefined
					if (idempotencyKey !== undefined) {
						id = AgentId.make(
							yield* idempotentId(digest, "agent", ["create", "agent", "id", idempotencyKey]),
						)
						versionId = AgentVersionId.make(
							yield* idempotentId(digest, "aver", ["create", "agent", "version", idempotencyKey]),
						)
						if (!isSupportedModel(model.id) && (yield* agents.get(id)).status === "") {
							return yield* unsupportedModel(model)
						}
						sendOptions = {
							commandId: yield* createCommandId(digest, "agent", idempotencyKey, {
								name: payload.name,
								model,
								system,
								description,
							}),
						}
					} else {
						yield* supported(model)
						id = AgentId.make(yield* randomId(random, "agent"))
						versionId = AgentVersionId.make(yield* randomId(random, "aver"))
					}
					const receipt = yield* createAgent
						.send(
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
						.pipe(Effect.catchTag("AgentAlreadyExists", () => reject(409, IDEMPOTENCY_KEY_REUSED)))
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
			.handle("get", ({ params }) => retrieve(params.agent_id).pipe(handled))
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const id = params.agent_id
					const { version, model: modelInput, ...fields } = payload
					const model = modelInput === undefined ? undefined : normalizeModel(modelInput)
					if (model !== undefined) {
						yield* supported(model)
					}
					const receipt = yield* updateAgent.send(
						new UpdateAgent({
							agent_id: id,
							expected_version: version,
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
			.handle("archive", ({ params }) =>
				archiveAndRead(
					params.agent_id,
					"agent",
					"Agent",
					agents.send(new ArchiveAgent({ agent_id: params.agent_id })),
					(receipt) => agentViews.get(Agent.ref(params.agent_id), { atLeast: receipt }),
				).pipe(handled),
			)
	}),
)
