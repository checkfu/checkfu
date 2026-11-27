import { PositiveInt, ResourceId } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import { resourceKinds } from "./Project.ts"

export const projectLockfileName = "checkfu-lock.json"

const fingerprint = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
const resourceKey = Schema.String.check(
	Schema.isPattern(/^\.\/(?!\.\.?(?:\/|$))(?!.*\/\.\.?(?:\/|$))[^\\]+$/u),
)
const resourceId = Schema.String.check(Schema.isPattern(/^(?:agent|env|auto)_[A-Za-z0-9_-]+$/u))

const LockEntry = Schema.Struct({
	kind: Schema.Literals(resourceKinds),
	id: resourceId,
	hash: fingerprint,
})
export type LockEntry = typeof LockEntry.Type

const uniqueOwners = <Entry>(identityOf: (entry: Entry) => string) =>
	Schema.makeFilter((resources: Readonly<Record<string, Entry>>) => {
		const owners = new Map<string, string>()
		for (const path of Object.keys(resources).sort()) {
			const entry = resources[path]
			if (entry === undefined) {
				continue
			}
			const identity = identityOf(entry)
			const previous = owners.get(identity)
			if (previous !== undefined) {
				return `${identity} is owned by both ${previous} and ${path}.`
			}
			owners.set(identity, path)
		}
		return true
	})

const settledResources = Schema.Record(resourceKey, LockEntry).check(
	uniqueOwners((entry: LockEntry) => `${entry.kind} ${entry.id}`),
)

const pendingIdentity = {
	key: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/u)),
	hash: fingerprint,
}
const PendingCreate = Schema.Union([
	Schema.Struct({ kind: Schema.Literals(["agent", "environment"]), ...pendingIdentity }),
	Schema.Struct({
		kind: Schema.Literal("automation"),
		...pendingIdentity,
		dependencies: Schema.Struct({
			agent: Schema.Struct({
				id: ResourceId,
				version: PositiveInt,
				path: Schema.optionalKey(resourceKey),
			}),
			environment_id: Schema.Struct({ id: ResourceId, path: Schema.optionalKey(resourceKey) }),
		}),
	}),
])
export type PendingCreate = typeof PendingCreate.Type

const pendingCreates = Schema.Record(resourceKey, PendingCreate).check(
	uniqueOwners((entry: PendingCreate) => `${entry.kind} create request ${entry.key}`),
)

export const ProjectLockfile = Schema.fromJsonString(
	Schema.Struct({
		version: Schema.Literal(1),
		base_url: Schema.String,
		resources: settledResources,
		pending_creates: Schema.optionalKey(pendingCreates),
	}),
)
export type ProjectLockfile = typeof ProjectLockfile.Type

const sorted = <A>(entries: Readonly<Record<string, A>>) =>
	Object.fromEntries(
		Object.keys(entries)
			.sort()
			.map((key) => [key, entries[key]]),
	)

export const formatProjectLockfile = (state: ProjectLockfile): string => {
	const { pending_creates, resources, ...header } = state
	const body = {
		...header,
		resources: sorted(resources),
		...(pending_creates === undefined || Object.keys(pending_creates).length === 0
			? {}
			: { pending_creates: sorted(pending_creates) }),
	}
	return `${JSON.stringify(body, null, 2)}\n`
}
