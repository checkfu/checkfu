import { PositiveInt, ResourceId } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import { resourceKinds } from "./Project.ts"

export const projectLockfileName = "checkfu-lock.json"

const fingerprint = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
const resourceKey = Schema.String.check(
	Schema.isPattern(/^\.\/(?!\.\.?(?:\/|$))(?!.*\/\.\.?(?:\/|$))[^\\]+$/u),
)
const resourceId = Schema.String.check(Schema.isPattern(/^(?:agent|env|auto)_[A-Za-z0-9_-]+$/u))
const version = Schema.optionalKey(PositiveInt)

const LockEntry = Schema.Struct({
	kind: Schema.Literals(resourceKinds),
	id: resourceId,
	hash: fingerprint,
})
export type LockEntry = typeof LockEntry.Type

const PendingCreate = Schema.Struct({
	kind: Schema.optionalKey(Schema.Literals(resourceKinds)),
	key: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/u)),
	hash: fingerprint,
	dependencies: Schema.optionalKey(
		Schema.Struct({
			agent: Schema.Struct({ id: ResourceId, version, path: Schema.optionalKey(resourceKey) }),
			environment_id: Schema.Struct({ id: ResourceId, path: Schema.optionalKey(resourceKey) }),
		}),
	),
	references: Schema.optionalKey(
		Schema.Record(
			resourceKey,
			Schema.Struct({
				id: resourceId,
				version,
			}),
		),
	),
})
export type PendingCreate = typeof PendingCreate.Type

export const ProjectLockfile = Schema.fromJsonString(
	Schema.Struct({
		version: Schema.Literal(1),
		base_url: Schema.String,
		resources: Schema.Record(resourceKey, LockEntry),
		pending_creates: Schema.optionalKey(Schema.Record(resourceKey, PendingCreate)),
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
