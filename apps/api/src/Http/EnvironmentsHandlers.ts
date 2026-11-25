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
import { CheckfuApi } from "./Api.ts"
import { makeLister } from "./Listing.ts"
import {
	DEFAULT_ENVIRONMENT_CONFIG,
	IDEMPOTENCY_KEY_REUSED,
	archiveAndRead,
	bestEffortAfterCommit,
	createIdentity,
	handled,
	isPending,
	orPending,
	readExisting,
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
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom
		const list = yield* makeLister

		const retrieve = (id: EnvironmentId) => {
			const ref = Environment.ref(id)
			return readExisting({
				missingFirst: true,
				current: environmentViews.get(ref),
				missing: Effect.flatMap(environments.get(id), (committed) =>
					committed.status === "" || committed.status === "deleted"
						? reject(404, `Environment ${id} not found.`)
						: Effect.void,
				),
				projected: Effect.flatMap(EnvironmentReadWaitTimeout, (timeout) =>
					environmentViews.waitFor(ref, { version: { gte: 1 } }, { timeout }),
				),
			})
		}

		return handlers
			.handle("create", ({ payload, headers }) =>
				Effect.gen(function* () {
					const idempotencyKey = headers["idempotency-key"]
					const description = payload.description ?? null
					const config = payload.config ?? DEFAULT_ENVIRONMENT_CONFIG
					const identity = yield* createIdentity(
						{ digest, random },
						"environment",
						"env",
						idempotencyKey,
						{ name: payload.name, description, config },
					)
					const id = EnvironmentId.make(identity.id)
					const sendOptions = identity.sendOptions
					const receipt = yield* environments
						.send(
							new CreateEnvironment({
								environment_id: id,
								name: payload.name,
								description,
								config,
							}),
							sendOptions,
						)
						.pipe(
							Effect.catchTag("EnvironmentAlreadyExists", () =>
								reject(409, IDEMPOTENCY_KEY_REUSED),
							),
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
				list("environment", query, (id) => retrieve(EnvironmentId.make(id))).pipe(handled),
			)
			.handle("get", ({ params }) => retrieve(params.environment_id).pipe(handled))
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
				archiveAndRead(
					params.environment_id,
					"environment",
					"Environment",
					environments.send(new ArchiveEnvironment({ environment_id: params.environment_id })),
					(receipt) =>
						environmentViews.get(Environment.ref(params.environment_id), { atLeast: receipt }),
				).pipe(handled),
			)
	}),
)
