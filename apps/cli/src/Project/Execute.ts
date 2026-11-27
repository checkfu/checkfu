import type { LockEntry, PendingCreate, ProjectLockfile } from "@checkfu/authoring/lockfile"
import { ERROR_CODES } from "@checkfu/sdk"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import type { CheckfuClient } from "../Client.ts"
import { apiErrorStatus, formatClientError, isApiErrorEnvelope, usageError } from "../Errors.ts"
import { writeLockfile } from "./Lockfile.ts"
import { hashOf, pendingDefinition } from "./Plan.ts"
import type { PlanRow, ProjectPlan } from "./Plan.ts"
import {
	archiveResource,
	awaitResource,
	confirmCreateReplay,
	createResource,
	fingerprint,
	readRemote,
	resourceRevision,
	updateResource,
} from "./Resources.ts"
import type { Resource } from "./Resources.ts"
import { withReferenceIds } from "./Source.ts"
import type { AppliedReference, Definition, ProjectResource } from "./Source.ts"

const isCapacityRejection = (error: unknown): boolean =>
	isApiErrorEnvelope(error) &&
	error.error.type === "rate_limit_error" &&
	error.error.code === ERROR_CODES.automationCapacityReached

const isRejectedCreate = (error: unknown, fresh: boolean): boolean =>
	isCapacityRejection(error) ||
	(isApiErrorEnvelope(error) &&
		(((error.error.type === "conflict_error" || error.error.type === "not_found_error") &&
			error.error.code === ERROR_CODES.automationReferenceUnavailable) ||
			(error.error.type === "invalid_request_error" &&
				(error.error.code === ERROR_CODES.agentModelUnavailable ||
					error.error.code === ERROR_CODES.automationScheduleUnusable)) ||
			(fresh && [400, 401, 404, 413, 415].includes(apiErrorStatus(error)))))

const matchesDefinition = (hash: string) => (resource: Resource) =>
	resource.archived_at === null && hashOf(resource) === hash

const pendingCreate = Effect.fnUntraced(function* (
	source: ProjectResource,
	definition: Definition,
	key: string,
	hash: string,
): Effect.fn.Return<PendingCreate, ReturnType<typeof usageError>> {
	if (definition.kind !== "automation") {
		return { kind: definition.kind, key, hash }
	}
	const { agent, environment_id } = definition.body
	if (typeof agent === "string" || agent.version === undefined) {
		return yield* usageError("An automation requires a pinned agent before applying.")
	}
	const agentPath = source.references.find(({ field }) => field === "agent")?.target
	const environmentPath = source.references.find(({ field }) => field === "environment_id")?.target
	return {
		kind: "automation",
		key,
		hash,
		dependencies: {
			agent: {
				id: agent.id,
				version: agent.version,
				...(agentPath === undefined ? {} : { path: agentPath }),
			},
			environment_id: {
				id: environment_id,
				...(environmentPath === undefined ? {} : { path: environmentPath }),
			},
		},
	}
})

export const executePlan = (
	client: CheckfuClient,
	lockFile: string,
	original: ProjectLockfile,
	plan: ProjectPlan,
) =>
	Effect.gen(function* () {
		const { api } = client
		const resources = { ...original.resources }
		const pendingCreates = { ...original.pending_creates }
		const save = Effect.suspend(() =>
			writeLockfile(lockFile, { ...original, resources, pending_creates: pendingCreates }),
		)

		const verifyUnchanged = Effect.fnUntraced(function* (file: string, current: Resource) {
			const latest = yield* readRemote(api, current.type, current.id)
			if (
				latest !== null &&
				latest.archived_at === null &&
				(resourceRevision(latest) !== resourceRevision(current) ||
					hashOf(latest) !== hashOf(current))
			) {
				return yield* usageError(`${file}: the resource changed after planning. Run apply again.`)
			}
			return latest?.archived_at === null ? latest : null
		})

		const reconcile = Effect.fnUntraced(function* (
			file: string,
			desired: Definition,
			current: Resource,
		) {
			const matches = matchesDefinition(fingerprint(desired))
			if (matches(current)) {
				return current
			}
			const latest = yield* verifyUnchanged(file, current)
			if (latest === null) {
				return yield* usageError(
					`${file}: the resource was archived or deleted after planning. Run apply again.`,
				)
			}
			const updated = yield* updateResource(api, desired, latest)
			return yield* awaitResource(api, updated, matches)
		})

		const remaining = new Set(plan.removed)
		const remove = Effect.fnUntraced(function* (item: (typeof plan.removed)[number]) {
			const { row, remote } = item
			if (row.action !== "skipped") {
				if (remote !== null) {
					const latest = yield* verifyUnchanged(row.file, remote)
					if (latest !== null) {
						const result = yield* archiveResource(api, latest)
						yield* awaitResource(api, result, (resource) => resource.archived_at !== null)
					}
				}
				delete resources[row.file]
				yield* save
			}
			remaining.delete(item)
		})

		const results: Array<PlanRow> = []
		const applied = new Map<string, AppliedReference & { readonly resource: Resource }>()
		for (const {
			row,
			source,
			current,
			desired: planned,
			deferredReferences,
			pending,
		} of plan.resources) {
			const file = row.file
			for (const reference of source.references) {
				const dependency = applied.get(reference.target)
				if (dependency === undefined) {
					return yield* usageError(`${file}: no applied ID for ${reference.target}.`)
				}
				if ((yield* verifyUnchanged(reference.target, dependency.resource)) === null) {
					return yield* usageError(
						`${reference.target}: the dependency was archived or deleted after planning. Run apply again.`,
					)
				}
			}
			const desired =
				deferredReferences.length === 0
					? planned
					: withReferenceIds(
							{ ...source, definition: planned, references: deferredReferences },
							(ref) => applied.get(ref.target),
						)
			const hash = fingerprint(desired)
			let confirmed: Resource
			if (row.action === "create") {
				const requestBody = pending === undefined ? desired : pendingDefinition(source, pending)
				if (requestBody === undefined) {
					return yield* usageError(
						`${file}: a create is awaiting confirmation with a different definition. Restore the original definition and apply it once.`,
					)
				}
				const key = pending?.key ?? (yield* client.generateIdempotencyKey)
				const requestHash = pending?.hash ?? hash
				if (pending === undefined) {
					pendingCreates[file] = yield* pendingCreate(source, requestBody, key, requestHash)
					yield* save
				}
				const clearPending = () => {
					delete pendingCreates[file]
					return save
				}
				const request = createResource(api, requestBody, key)
				const created = yield* request.pipe(
					Effect.catch((error) => {
						if (isCapacityRejection(error)) {
							const cleanup = Array.from(remaining).find(
								({ row, remote }) => row.action === "archive" && remote?.type === "automation",
							)
							if (cleanup !== undefined) {
								const awaiting = Object.entries(pendingCreates).find(
									([path, entry]) => path !== file && entry.kind === "automation",
								)?.[0]
								if (awaiting !== undefined) {
									return clearPending().pipe(
										Effect.andThen(
											usageError(
												`Confirm the pending create for ${awaiting} before archiving an automation to free capacity.`,
											),
										),
									)
								}
								// The capacity slot is released by a policy after the archive commits.
								return remove(cleanup).pipe(
									Effect.tapError(clearPending),
									Effect.andThen(
										request.pipe(
											Effect.retry({
												while: isCapacityRejection,
												schedule: Schedule.spaced("250 millis"),
												times: 20,
											}),
										),
									),
								)
							}
						}
						return Effect.fail(error)
					}),
					Effect.tapError((error) => {
						if (isRejectedCreate(error, pending === undefined)) {
							return clearPending()
						}
						return Effect.void
					}),
					Effect.mapError(formatClientError),
				)
				const ownsReceipt = ([other, entry]: [string, LockEntry]) =>
					other !== file && entry.kind === requestBody.kind && entry.id === created.id
				const owner =
					Object.entries(resources).find(ownsReceipt)?.[0] ??
					Object.entries(original.resources).find(ownsReceipt)?.[0]
				if (owner !== undefined) {
					return yield* usageError(
						`${file}: the create returned ${requestBody.kind} ${created.id}, already owned by ${owner}.`,
					)
				}
				// A create receipt identifies the resource even if its projection has since changed.
				resources[file] = { kind: requestBody.kind, id: created.id, hash: requestHash }
				delete pendingCreates[file]
				yield* save
				const matches = matchesDefinition(requestHash)
				confirmed =
					pending === undefined
						? yield* awaitResource(api, created, matches)
						: yield* confirmCreateReplay(api, requestBody.kind, created.id, matches)
				confirmed = yield* reconcile(file, desired, confirmed)
			} else {
				if (current === null) {
					return yield* usageError(`${file}: the plan has no resource to update.`)
				}
				confirmed = row.action === "unchanged" ? current : yield* reconcile(file, desired, current)
			}
			if (resources[file]?.hash !== hash || resources[file]?.id !== confirmed.id) {
				resources[file] = { kind: confirmed.type, id: confirmed.id, hash: hashOf(confirmed) }
				yield* save
			}
			applied.set(
				file,
				confirmed.type === "agent"
					? { id: confirmed.id, version: confirmed.version, resource: confirmed }
					: { id: confirmed.id, resource: confirmed },
			)
			results.push({ ...row, id: confirmed.id })
		}

		for (const item of remaining) {
			yield* remove(item)
		}
		results.push(...plan.removed.map(({ row }) => row))
		return results
	})
