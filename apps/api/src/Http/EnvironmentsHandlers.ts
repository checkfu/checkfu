import { ArchiveEnvironment } from "@checkfu/environments/Environment/ArchiveEnvironment.command"
import { CreateEnvironment } from "@checkfu/environments/Environment/CreateEnvironment.command"
import { DeleteEnvironment } from "@checkfu/environments/Environment/DeleteEnvironment.command"
import { Environment } from "@checkfu/environments/Environment/Environment.aggregate"
import { EnvironmentId } from "@checkfu/environments/Environment/Environment.id"
import { EnvironmentView } from "@checkfu/environments/Environment/EnvironmentView.view"
import { UpdateEnvironment } from "@checkfu/environments/Environment/UpdateEnvironment.command"
import * as Context from "effect/Context"
import * as SecureRandom from "effect/crypto/SecureRandom"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Option from "effect/Option"
import { CheckfuApi } from "./Api.ts"
import {
	DEFAULT_ENVIRONMENT_CONFIG,
	bestEffortAfterCommit,
	handled,
	hasTag,
	isPending,
	orPending,
	present,
	randomId,
	reject,
} from "./HttpHelpers.ts"

export const EnvironmentPartialUpdateWaitTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/EnvironmentPartialUpdateWaitTimeout",
	{ defaultValue: () => "5 seconds" },
)

export const EnvironmentsLive = HttpApiBuilder.group(CheckfuApi, "environments", (handlers) =>
	Effect.gen(function* () {
		const environments = yield* Environment
		const environmentViews = yield* EnvironmentView
		const random = yield* SecureRandom.SecureRandom

		return handlers
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const id = EnvironmentId.make(yield* randomId(random, "env"))
					const description = payload.description ?? null
					const config = payload.config ?? DEFAULT_ENVIRONMENT_CONFIG
					const receipt = yield* environments.send(
						new CreateEnvironment({
							environment_id: id,
							name: payload.name,
							description,
							config,
						}),
					)
					const result = yield* environmentViews
						.get(Environment.ref(id), { atLeast: receipt })
						.pipe(orPending(id, "environment"))
					if (isPending(result)) return result
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
						return yield* reject(404, `Environment ${id} was deleted after creation committed.`)
					}
					return yield* reject(500, "Failed to load created environment.")
				}).pipe(handled),
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
					if (found !== null) return found
					const projected = yield* environmentViews
						.waitFor(
							ref,
							{ version: { gte: 1 } },
							{ timeout: yield* EnvironmentPartialUpdateWaitTimeout },
						)
						.pipe(
							Effect.catch((err) =>
								hasTag(err, "WaitTimeout") || hasTag(err, "ConsistencyTimeout")
									? Effect.andThen(checkExists, Effect.fail(err))
									: Effect.fail(err),
							),
						)
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
					const committed = yield* environments.get(id)
					if (committed.status === "" || committed.status === "deleted") {
						return yield* reject(404, `Environment ${id} not found.`)
					}
					if (committed.status === "archived") {
						return yield* reject(409, "Environment is archived.")
					}
					if (committed.version !== payload.version) {
						return yield* reject(409, "Environment version does not match.")
					}
					let description = payload.description
					let config = payload.config
					if (description === undefined || config === undefined) {
						const current = Option.getOrNull(yield* environmentViews.get(Environment.ref(id)))
						let view = current !== null && current.version >= committed.version ? current : null
						if (view === null) {
							const checkStillUpdatable = Effect.gen(function* () {
								const latest = yield* environments.get(id)
								if (latest.status === "" || latest.status === "deleted") {
									return yield* reject(404, `Environment ${id} not found.`)
								}
								if (latest.status === "archived") {
									return yield* reject(409, "Environment is archived.")
								}
								if (latest.version !== payload.version) {
									return yield* reject(409, "Environment version does not match.")
								}
							})
							yield* checkStillUpdatable
							view = yield* environmentViews
								.waitFor(
									Environment.ref(id),
									{ version: { gte: committed.version } },
									{ timeout: yield* EnvironmentPartialUpdateWaitTimeout },
								)
								.pipe(
									Effect.catch((err) =>
										hasTag(err, "WaitTimeout") || hasTag(err, "ConsistencyTimeout")
											? Effect.andThen(checkStillUpdatable, Effect.fail(err))
											: Effect.fail(err),
									),
								)
						}
						if (view === null) return yield* reject(404, `Environment ${id} not found.`)
						if (view.version !== payload.version) {
							return yield* reject(409, "Environment version does not match.")
						}
						if (description === undefined) description = view.description
						if (config === undefined) config = view.config
					}
					const nextName = payload.name ?? committed.name
					const receipt = yield* environments.send(
						new UpdateEnvironment({
							environment_id: id,
							expected_version: payload.version,
							name: nextName,
							description,
							config,
						}),
					)
					const result = yield* environmentViews
						.get(Environment.ref(id), { atLeast: receipt })
						.pipe(orPending(id, "environment"))
					if (isPending(result)) return result
					const head = Option.getOrNull(result)
					if (head !== null) {
						if (head.version === receipt.reply.version && head.archived_at === null) {
							return head
						}
						// Another writer updated or archived the environment before this read;
						// EnvironmentView only stores head, so the exact committed snapshot (including
						// its event timestamp) is no longer available. Return 202 pending rather than
						// leaking another writer's version or fabricating `updated_at`.
						return { id, type: "environment" as const, pending: true as const }
					}
					const latest = yield* environments.get(id)
					if (latest.status === "deleted") {
						return yield* reject(404, `Environment ${id} was deleted after the update committed.`)
					}
					return yield* reject(500, "Failed to load updated environment.")
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
					if (isPending(result)) return result
					return yield* present(result, 404, `Environment ${id} not found.`)
				}).pipe(handled),
			)
	}),
)
