import type { PendingCreate, ProjectLockfile } from "@checkfu/authoring/lockfile"
import * as Effect from "effect/Effect"
import type { CheckfuClient } from "../Client.ts"
import {
	automationDependencyIds,
	configurationChanges,
	configurationFields,
	desiredBody,
	fingerprint,
	listLiveAutomations,
	readRemote,
	remoteBody,
} from "./Resources.ts"
import type { Resource } from "./Resources.ts"
import { withReferenceIds } from "./Source.ts"
import type { AppliedReference, Definition, ProjectResource, loadProject } from "./Source.ts"

export interface PlanRow {
	readonly file: string
	readonly action: "create" | "update" | "unchanged" | "archive" | "forget" | "skipped" | "blocked"
	readonly id?: string
	readonly fields?: ReadonlyArray<string>
	readonly reason?: string
}

interface PlannedResource {
	readonly row: PlanRow
	readonly source: ProjectResource
	readonly current: Resource | null
	readonly desired: Definition
	readonly referencesReady: boolean
	readonly pending: PendingCreate | undefined
}

export const hashOf = (remote: Resource): string => fingerprint(remoteBody(remote))

export const pendingDefinition = (source: ProjectResource, pending: PendingCreate) => {
	if (source.definition.kind !== pending.kind) {
		return undefined
	}
	const lookup = ({ field, target }: ProjectResource["references"][number]) => {
		if (pending.kind !== "automation") {
			return undefined
		}
		const binding = pending.dependencies[field]
		return binding.path === target ? binding : undefined
	}
	if (source.references.some((reference) => lookup(reference) === undefined)) {
		return undefined
	}
	const definition = desiredBody(withReferenceIds(source, lookup))
	return fingerprint(definition) === pending.hash ? definition : undefined
}

export const planProject = (
	api: CheckfuClient["api"],
	project: Effect.Success<ReturnType<typeof loadProject>>,
	state: ProjectLockfile,
	options: { readonly force: boolean; readonly prune: boolean },
) =>
	Effect.gen(function* () {
		const applied = new Map<string, AppliedReference>()
		const resources: Array<PlannedResource> = []
		for (const source of project.resources) {
			const { key: file, definition } = source
			const entry = state.resources[file]
			const pending = state.pending_creates?.[file]
			const current = entry === undefined ? null : yield* readRemote(api, entry.kind, entry.id)
			const replacing = current === null || current.archived_at !== null
			const ready = source.references.every((reference) => applied.has(reference.target))
			const desired = desiredBody(withReferenceIds(source, (ref) => applied.get(ref.target)))
			let row: PlanRow
			if (entry !== undefined && entry.kind !== definition.kind) {
				row = {
					file,
					action: "blocked",
					id: entry.id,
					reason: `File changed type from ${entry.kind} to ${definition.kind}.`,
				}
			} else if (pending !== undefined && pendingDefinition(source, pending) === undefined) {
				row = {
					file,
					action: "blocked",
					reason:
						"A create is awaiting confirmation. Restore the original definition and its references, then apply it once.",
				}
			} else if (pending !== undefined || entry === undefined) {
				row = { file, action: "create" }
			} else if (replacing) {
				row = options.force
					? { file, action: "create", reason: `Replace ${entry.id}.` }
					: {
							file,
							action: "blocked",
							id: entry.id,
							reason: "Resource was archived or deleted. Use --force to replace it.",
						}
			} else if (ready && hashOf(current) === fingerprint(desired)) {
				row = { file, action: "unchanged", id: current.id }
			} else if (hashOf(current) !== entry.hash && !options.force) {
				row = {
					file,
					action: "blocked",
					id: current.id,
					reason: "Remote configuration changed. Use --force to apply the file.",
					fields: Object.keys(configurationChanges(current, desired.body)),
				}
			} else {
				row = {
					file,
					action: "update",
					id: current.id,
					fields: Object.keys(configurationChanges(current, desired.body)),
				}
			}
			if (current !== null && (row.action === "unchanged" || row.action === "update")) {
				applied.set(
					file,
					current.type === "agent"
						? { id: current.id, version: current.version + Number(row.action === "update") }
						: { id: current.id },
				)
			}
			resources.push({
				row,
				source,
				current: replacing ? null : current,
				desired,
				referencesReady: ready,
				pending,
			})
		}

		const removed: Array<{ readonly row: PlanRow; readonly remote: Resource | null }> = []
		for (const file of project.missing) {
			const entry = state.resources[file]
			if (state.pending_creates?.[file] !== undefined) {
				removed.push({
					row: {
						file,
						action: "blocked",
						reason: "A create is awaiting confirmation. Restore its file and apply it once.",
					},
					remote: null,
				})
			} else if (entry !== undefined && !options.prune) {
				removed.push({
					row: {
						file,
						action: "skipped",
						id: entry.id,
						reason: "Source file is missing. Use --prune to archive it.",
					},
					remote: null,
				})
			} else if (entry !== undefined) {
				const remote = yield* readRemote(api, entry.kind, entry.id)
				if (remote === null || remote.archived_at !== null) {
					removed.push({ row: { file, action: "forget", id: entry.id }, remote: null })
				} else if (hashOf(remote) !== entry.hash && !options.force) {
					removed.push({
						row: {
							file,
							action: "blocked",
							id: entry.id,
							reason: "Remote configuration changed. Use --force with --prune to archive it.",
						},
						remote,
					})
				} else {
					removed.push({ row: { file, action: "archive", id: entry.id }, remote })
				}
			}
		}
		// An automation can refer to an agent or environment that is also being archived.
		removed.sort(
			(a, b) => Number(b.remote?.type === "automation") - Number(a.remote?.type === "automation"),
		)
		const archivedAutomations = new Set<string>()
		const archivedDependencies = new Map<string, string>()
		for (const { row, remote } of removed) {
			if (row.action === "archive" && remote !== null) {
				if (remote.type === "automation") {
					archivedAutomations.add(remote.id)
				} else {
					archivedDependencies.set(remote.id, row.file)
				}
			}
		}
		const retainedBy = new Map<string, Set<string>>()
		const checkDependencies = (file: string, ids: ReadonlyArray<string>) => {
			for (const id of ids) {
				const dependency = archivedDependencies.get(id)
				if (dependency !== undefined) {
					const references = retainedBy.get(dependency) ?? new Set<string>()
					references.add(file)
					retainedBy.set(dependency, references)
				}
			}
		}
		if (archivedDependencies.size > 0) {
			const selected = new Set<string>()
			const updatedAutomations = new Set<string>()
			for (const { row, current, desired } of resources) {
				selected.add(row.file)
				if (desired.kind === "automation") {
					checkDependencies(row.file, automationDependencyIds(desired.body))
					if (row.action === "update" && current?.type === "automation") {
						updatedAutomations.add(current.id)
					}
				}
			}
			const trackedAutomations = new Map<string, string>()
			for (const [file, entry] of Object.entries(state.resources)) {
				if (entry.kind === "automation") {
					trackedAutomations.set(entry.id, file)
				}
			}
			const inspected = new Set<string>()
			for (const remote of yield* listLiveAutomations(api)) {
				inspected.add(remote.id)
				if (!updatedAutomations.has(remote.id) && !archivedAutomations.has(remote.id)) {
					checkDependencies(
						trackedAutomations.get(remote.id) ?? remote.id,
						automationDependencyIds(remote),
					)
				}
			}
			// A known automation can be retrieved before it appears in the deployment listing.
			for (const [id, file] of trackedAutomations) {
				if (!selected.has(file) && !archivedAutomations.has(id) && !inspected.has(id)) {
					const remote = yield* readRemote(api, "automation", id)
					if (remote?.type === "automation" && remote.archived_at === null) {
						checkDependencies(file, automationDependencyIds(remote))
					}
				}
			}
			for (const [file, pending] of Object.entries(state.pending_creates ?? {})) {
				if (!selected.has(file) && pending.kind === "automation") {
					const { agent, environment_id } = pending.dependencies
					checkDependencies(file, [agent.id, environment_id.id])
				}
			}
		}
		const removals = removed.map((item) => {
			const references = retainedBy.get(item.row.file)
			if (references === undefined) {
				return item
			}
			const row: PlanRow = {
				...item.row,
				action: "blocked",
				reason: `Automation dependencies in ${Array.from(references).join(", ")} must be resolved before archiving.`,
			}
			return { ...item, row }
		})
		return {
			resources,
			removed: removals,
			rows: [...resources.map(({ row }) => row), ...removals.map(({ row }) => row)],
		}
	})

export type ProjectPlan = Effect.Success<ReturnType<typeof planProject>>

export const detailedPlan = (plan: ProjectPlan) => [
	...plan.resources.map(({ row, source, current, desired, referencesReady }) => {
		if (row.action === "create") {
			return { ...row, configuration: source.document }
		}
		if (row.fields !== undefined && current !== null) {
			const before = new Map<string, unknown>(
				Object.entries(configurationFields(current.type, remoteBody(current).body)),
			)
			const after = new Map<string, unknown>(
				Object.entries(configurationFields(desired.kind, desired.body)),
			)
			const references = new Set(source.references.map((reference) => reference.field))
			return {
				...row,
				changes: Object.fromEntries(
					row.fields.map((field) => [
						field,
						{
							from: before.get(field),
							to:
								!referencesReady &&
								(field === "agent" || field === "environment_id") &&
								references.has(field)
									? source.document[field]
									: after.get(field),
						},
					]),
				),
			}
		}
		return row
	}),
	...plan.removed.map(({ row }) => row),
]
