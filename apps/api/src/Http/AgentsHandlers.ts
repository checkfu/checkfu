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
import { IdempotencyClaim } from "@checkfu/domain/IdempotencyClaim/IdempotencyClaim.aggregate"
import { CheckfuApi } from "./Api.ts"
import { makeLister } from "./Listing.ts"
import {
	claimIdempotency,
	commitForStream,
	createClaimId,
	createCommandId,
	createFingerprint,
	handled,
	idempotentId,
	isPending,
	normalizeModel,
	orPending,
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

export const AgentsLive = HttpApiBuilder.group(CheckfuApi, "agents", (handlers) =>
	Effect.gen(function* () {
		const agents = yield* Agent
		const createAgent = yield* CreateAgentDecision
		const updateAgent = yield* UpdateAgentDecision
		const agentViews = yield* AgentView
		const agentVersionsByNumber = yield* AgentVersionByNumberView
		const idempotencyClaims = yield* IdempotencyClaim
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom
		const isSupportedModel = yield* IsSupportedAgentModel
		const list = yield* makeLister
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
						const batchId = yield* createClaimId(digest, "agent", idempotencyKey)
						const fingerprint = yield* createFingerprint(digest, {
							name: payload.name,
							model,
							system,
							description,
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
					}
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
			.handle("list", ({ query }) =>
				list("agent", query, (id) => agentViews.get(Agent.ref(AgentId.make(id)))).pipe(handled),
			)
			.handle("get", ({ params }) =>
				Effect.gen(function* () {
					const id = params.agent_id
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
				}).pipe(handled),
			)
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
				Effect.gen(function* () {
					const id = params.agent_id
					const receipt = yield* agents.send(new ArchiveAgent({ agent_id: id }))
					const result = yield* agentViews
						.get(Agent.ref(id), { atLeast: receipt })
						.pipe(orPending(id, "agent"))
					if (isPending(result)) {
						return result
					}
					return yield* present(result, 404, `Agent ${id} not found.`)
				}).pipe(handled),
			)
	}),
)
