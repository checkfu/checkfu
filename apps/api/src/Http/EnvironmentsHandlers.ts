import { ArchiveEnvironment } from "@checkfu/domain/Environment/ArchiveEnvironment.command"
import { CreateEnvironment } from "@checkfu/domain/Environment/CreateEnvironment.command"
import { DeleteEnvironment } from "@checkfu/domain/Environment/DeleteEnvironment.command"
import { Environment } from "@checkfu/domain/Environment/Environment.aggregate"
import { EnvironmentId } from "@checkfu/domain/Environment/Environment.id"
import { EnvironmentView } from "@checkfu/domain/Environment/EnvironmentView.view"
import { UpdateEnvironment } from "@checkfu/domain/Environment/UpdateEnvironment.command"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Option from "effect/Option"
import { IdempotencyClaim } from "@checkfu/domain/IdempotencyClaim/IdempotencyClaim.aggregate"
import { CheckfuApi } from "./Api.ts"
import { makeLister } from "./Listing.ts"
import {
	DEFAULT_ENVIRONMENT_CONFIG,
	bestEffortAfterCommit,
	claimCreate,
	handled,
	idempotentId,
	isPending,
	orPending,
	present,
	randomId,
	reject,
} from "./HttpHelpers.ts"

export const EnvironmentReadWaitTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/EnvironmentReadWaitTimeout",
	{ defaultValue: () => "5 seconds" },
)

export const EnvironmentsLive = HttpApiBuilder.group(CheckfuApi, "environments", (handlers) =>
	Effect.gen(function* () {
		const environments = yield* Environment
		const environmentViews = yield* EnvironmentView
		const idempotencyClaims = yield* IdempotencyClaim
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom
		const list = yield* makeLister

		return handlers
			.handle("create", ({ payload, headers }) =>
				Effect.gen(function* () {
					const idempotencyKey = headers["idempotency-key"]
					const description = payload.description ?? null
					const config = payload.config ?? DEFAULT_ENVIRONMENT_CONFIG
					let id: EnvironmentId
					let sendOptions: { readonly commandId: string } | undefined
					if (idempotencyKey !== undefined) {
						const commandId = yield* claimCreate(
							idempotencyClaims,
							digest,
							"environment",
							idempotencyKey,
							{
								name: payload.name,
								description,
								config,
							},
						)
						id = EnvironmentId.make(
							yield* idempotentId(digest, "env", ["create", "environment", "id", idempotencyKey]),
						)
						sendOptions = { commandId }
					} else {
						id = EnvironmentId.make(yield* randomId(random, "env"))
					}
					const receipt = yield* environments.send(
						new CreateEnvironment({
							environment_id: id,
							name: payload.name,
							description,
							config,
						}),
						sendOptions,
					)
					const result = yield* environmentViews
						.get(Environment.ref(id), { atLeast: receipt })
						.pipe(orPending(id, "environment"))
					if (isPending(result)) {
						return result
					}
					const head = Option.getOrNull(result)
					if (head !== null) {
						if (head.version === receipt.reply.version && head.archived_at === null) {
							return head
						}
						// `head.created_at` is the immutable `environment.created` event timestamp,
						// so version 1's exact snapshot can be returned even if a later mutation landed.
						return {
							id,
							type: "environment" as const,
							version: receipt.reply.version,
							name: payload.name,
							description,
							config,
							created_at: head.created_at,
							updated_at: head.created_at,
							archived_at: null,
						}
					}
					const latest = yield* environments.get(id)
					if (latest.status === "deleted") {
						if (idempotencyKey !== undefined) {
							const page = yield* environmentViews
								.list(Environment.ref(id), { take: 1, order: "asc" })
								.pipe(orPending(id, "environment"))
							if (isPending(page)) {
								return page
							}
							const created = page.entries[0]
							if (created !== undefined && created.event._tag === "environment.created") {
								return (
									created.state ?? {
										id,
										type: "environment" as const,
										version: receipt.reply.version,
										name: payload.name,
										description,
										config,
										created_at: created.envelope.at,
										updated_at: created.envelope.at,
										archived_at: null,
									}
								)
							}
							return yield* reject(500, "Failed to load created environment.")
						}
						return yield* reject(404, `Environment ${id} was deleted after creation committed.`)
					}
					return yield* reject(500, "Failed to load created environment.")
				}).pipe(handled),
			)
			.handle("list", ({ query }) =>
				list("environment", query, (id) =>
					environmentViews.get(Environment.ref(EnvironmentId.make(id))),
				).pipe(handled),
			)
			.handle("get", ({ params }) =>
				Effect.gen(function* () {
					const id = params.environment_id
					const checkExists = Effect.gen(function* () {
						const committed = yield* environments.get(id)
						if (committed.status === "" || committed.status === "deleted") {
							return yield* reject(404, `Environment ${id} not found.`)
						}
					})
					// Verify committed existence before trusting a non-null view snapshot so a
					// lagging EnvironmentView after DELETE cannot resurrect a deleted environment.
					yield* checkExists
					const ref = Environment.ref(id)
					const found = Option.getOrNull(yield* environmentViews.get(ref))
					if (found !== null) {
						return found
					}
					const projected = yield* environmentViews
						.waitFor(ref, { version: { gte: 1 } }, { timeout: yield* EnvironmentReadWaitTimeout })
						.pipe(Effect.tapErrorTag("WaitTimeout", () => checkExists))
					if (projected === null) {
						yield* checkExists
						return yield* reject(503, `Environment ${id} projection is not ready.`)
					}
					return projected
				}).pipe(handled),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const id = params.environment_id
					const { version, ...changes } = payload
					const receipt = yield* environments.send(
						new UpdateEnvironment({
							environment_id: id,
							expected_version: version,
							changes,
						}),
					)
					const result = yield* environmentViews
						.get(Environment.ref(id), { atLeast: receipt })
						.pipe(orPending(id, "environment"))
					if (isPending(result)) {
						return result
					}
					const head = Option.getOrNull(result)
					if (head === null) {
						const latest = yield* environments.get(id)
						return latest.status === "deleted"
							? yield* reject(404, `Environment ${id} was deleted after the update committed.`)
							: yield* reject(500, "Failed to load updated environment.")
					}
					if (head.version === receipt.reply.version && head.archived_at === null) {
						return head
					}
					// Another writer updated or archived the environment before this read;
					// EnvironmentView only stores head, so the exact committed snapshot (including
					// its event timestamp) is no longer available. Return 202 pending rather than
					// leaking another writer's version or fabricating `updated_at`.
					return { id, type: "environment" as const, pending: true as const }
				}).pipe(handled),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const id = params.environment_id
					const receipt = yield* environments.send(new DeleteEnvironment({ environment_id: id }))
					yield* environmentViews
						.get(Environment.ref(id), { atLeast: receipt })
						.pipe(bestEffortAfterCommit)
					return { id, type: "environment_deleted" as const }
				}).pipe(handled),
			)
			.handle("archive", ({ params }) =>
				Effect.gen(function* () {
					const id = params.environment_id
					const receipt = yield* environments.send(new ArchiveEnvironment({ environment_id: id }))
					const result = yield* environmentViews
						.get(Environment.ref(id), { atLeast: receipt })
						.pipe(orPending(id, "environment"))
					if (isPending(result)) {
						return result
					}
					return yield* present(result, 404, `Environment ${id} not found.`)
				}).pipe(handled),
			)
	}),
)
