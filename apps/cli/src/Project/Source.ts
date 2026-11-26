import { CreateAgentBody, CreateAutomationBody, CreateEnvironmentBody } from "@checkfu/sdk/Api"
import { fillProjectProse, parseProjectDocument } from "@checkfu/authoring/document"
import { projectLockfileName } from "@checkfu/authoring/lockfile"
import { maxProjectSourceBytes, resourceKinds } from "@checkfu/authoring/project"
import type { ResourceKind } from "@checkfu/authoring/project"
import { projectSchemas } from "@checkfu/authoring/schemas"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { usageError } from "../Errors.ts"
import { resolveTextOrFile } from "../Input.ts"

const directories: Readonly<Record<ResourceKind, string>> = {
	agent: "agents",
	environment: "environments",
	automation: "automations",
}
const sourceExtension = /\.(?:ya?ml|json|md|markdown)$/iu
const markdownExtension = /\.(?:md|markdown)$/iu

interface Source {
	readonly key: string
	readonly kind: ResourceKind
	readonly body: Schema.JsonObject
}

export type Definition =
	| { readonly kind: "agent"; readonly body: CreateAgentBody }
	| { readonly kind: "environment"; readonly body: CreateEnvironmentBody }
	| { readonly kind: "automation"; readonly body: CreateAutomationBody }

export const decodeDefinition = (kind: ResourceKind, body: unknown, label: string) => {
	switch (kind) {
		case "agent":
			return decode(CreateAgentBody, body, label).pipe(
				Effect.map((body): Definition => ({ kind, body })),
			)
		case "environment":
			return decode(CreateEnvironmentBody, body, label).pipe(
				Effect.map((body): Definition => ({ kind, body })),
			)
		case "automation":
			return decode(CreateAutomationBody, body, label).pipe(
				Effect.map((body): Definition => ({ kind, body })),
			)
	}
}

const decode = <S extends Schema.Codec<unknown, unknown, never, unknown>>(
	schema: S,
	value: unknown,
	label: string,
) =>
	Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
		Effect.mapError((error) => usageError(`${label}: ${error.message}`)),
	)

const withSourceError = <A>(label: string, read: () => A) =>
	Effect.try({
		try: read,
		catch: (error) =>
			usageError(`${label}: ${error instanceof Error ? error.message : String(error)}`),
	})

type SourceSelection = "discovered" | "explicit" | "defer-untyped"

export const readSource = (
	file: string,
	key: string,
	selection: SourceSelection,
	expected?: ResourceKind,
) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const named = selection !== "discovered"
		const markdown = markdownExtension.test(file)
		const filename = path.basename(file, path.extname(file)).toLowerCase()
		const located =
			resourceKinds.find((kind) => directories[kind] === path.basename(path.dirname(file))) ??
			resourceKinds.find(
				(kind) => filename === kind || new RegExp(`^${kind}[-_.].+`, "u").test(filename),
			)
		if (!sourceExtension.test(file)) {
			return yield* usageError(
				`${key}: expected a .yaml, .yml, .json, .md or .markdown resource file.`,
			)
		}
		const read = yield* Effect.result(resolveTextOrFile(`@${file}`, maxProjectSourceBytes))
		if (read._tag === "Failure") {
			if (named || located !== undefined) {
				return yield* read.failure
			}
			return undefined
		}
		const parsed = yield* Effect.result(
			withSourceError(key, () =>
				parseProjectDocument(read.success, markdown ? "markdown" : "mapping"),
			),
		)
		if (parsed._tag === "Failure") {
			if (named || located !== undefined) {
				return yield* parsed.failure
			}
			return undefined
		}
		const { type, body, prose, hasFrontmatter, isJsonSchema } = parsed.success
		if (isJsonSchema) {
			if (named) {
				return yield* usageError(`${key}: expected a resource definition, found a JSON Schema.`)
			}
			return undefined
		}
		if (markdown && !hasFrontmatter && !named) {
			return undefined
		}
		const declared = resourceKinds.find((kind) => kind === type)
		if (declared === undefined && type !== undefined) {
			if (named || located !== undefined) {
				return yield* usageError(
					`${key}: supported resource types are ${resourceKinds.join(", ")}.`,
				)
			}
			return undefined
		}
		const kind =
			declared ??
			expected ??
			located ??
			(selection === "explicit" && markdown ? "agent" : undefined)
		if (kind === undefined) {
			if (selection !== "explicit") {
				return undefined
			}
			return yield* usageError(
				`${key}: set type or place the file under agents/, environments/ or automations/.`,
			)
		}
		if (expected !== undefined && kind !== expected) {
			return yield* usageError(`${key}: expected a ${expected} file, found ${kind}.`)
		}
		const field =
			kind === "agent" ? "system" : kind === "environment" ? "description" : "initial_events"
		const filled = yield* withSourceError(key, () => fillProjectProse(body, prose, field))
		return { key, kind, body: filled } satisfies Source
	})

export const fileType = (file: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		fs.lstat(file).pipe(
			Effect.map((info) => info.type),
			Effect.catch((error) =>
				error.reason._tag === "NotFound"
					? Effect.undefined
					: Effect.fail(usageError(`Could not inspect ${file}: ${error.message}`)),
			),
		),
	)

const skippedDirectory = (name: string) =>
	name.startsWith(".") || name === "node_modules" || name === "evals"

function* discover(
	directory: string,
	lockFile: string,
): Effect.fn.Return<
	ReadonlyArray<string>,
	ReturnType<typeof usageError>,
	FileSystem.FileSystem | Path.Path
> {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const entries = yield* fs
		.readDirectoryEntries(directory)
		.pipe(Effect.mapError((error) => usageError(`Could not read ${directory}: ${error.message}`)))
	const files: Array<string> = []
	for (const { name, type } of [...entries].sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		if (skippedDirectory(name) || name === projectLockfileName) {
			continue
		}
		const file = path.join(directory, name)
		const entryType = type === "Unknown" ? yield* fileType(file) : type
		if (entryType === "Directory") {
			if ((yield* fileType(path.join(file, projectLockfileName))) === undefined) {
				files.push(...(yield* Effect.gen(() => discover(file, lockFile))))
			}
		} else if (entryType === "File" && file !== lockFile && sourceExtension.test(name)) {
			files.push(file)
		}
	}
	return files
}

type ReferenceField = "agent" | "environment_id"

interface Reference {
	readonly field: ReferenceField
	readonly kind: "agent" | "environment"
	readonly target: string
	readonly object: Schema.JsonObject | undefined
}

const looksLikePath = (value: string): boolean =>
	value.startsWith(".") || value.includes("/") || sourceExtension.test(value)

const referencesFor = (source: Source) =>
	Effect.gen(function* () {
		const references: Array<Reference> = []
		if (source.kind !== "automation") {
			return references
		}
		const agent = yield* decode(
			projectSchemas.automation.fields.agent,
			source.body.agent,
			`${source.key} agent`,
		)
		const { environment_id } = source.body
		const agentPath = typeof agent === "string" ? agent : "path" in agent ? agent.path : agent.id
		if ((typeof agent !== "string" && "path" in agent) || looksLikePath(agentPath)) {
			references.push({
				field: "agent",
				kind: "agent",
				target: agentPath,
				object: typeof agent === "string" ? undefined : agent,
			})
		}
		if (typeof environment_id === "string" && looksLikePath(environment_id)) {
			references.push({
				field: "environment_id",
				kind: "environment",
				target: environment_id,
				object: undefined,
			})
		}
		return references
	})

export interface ProjectResource {
	readonly key: string
	readonly definition: Definition
	readonly document: Schema.JsonObject
	readonly references: ReadonlyArray<Reference>
}

export interface AppliedReference {
	readonly id: string
	readonly version?: number
}

export const withReferenceIds = (
	resource: ProjectResource,
	lookup: (reference: Reference) => AppliedReference | undefined,
): Definition => {
	const { definition, references } = resource
	if (definition.kind !== "automation") {
		return definition
	}
	const body = { ...definition.body }
	for (const reference of references) {
		const matched = lookup(reference)
		if (matched === undefined) {
			continue
		}
		if (reference.field === "environment_id") {
			body.environment_id = matched.id
		} else {
			const explicitVersion = typeof body.agent === "string" ? undefined : body.agent.version
			const version = explicitVersion ?? matched.version
			body.agent = version === undefined ? matched.id : { type: "agent", id: matched.id, version }
		}
	}
	return { kind: "automation", body }
}

const projectRelative = (path: Path.Path, root: string, file: string) => {
	const relative = path.relative(root, file).split(path.sep).join("/")
	return relative === ".." ||
		relative.startsWith("../") ||
		relative.includes("\\") ||
		path.isAbsolute(relative)
		? undefined
		: relative
}

export const loadProject = (
	root: string,
	lockFile: string,
	paths: ReadonlyArray<string>,
	tracked: ReadonlyMap<string, ResourceKind | undefined>,
	prune: boolean,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const resources = new Map<string, ProjectResource>()
		const missing = new Set<string>()
		const rootPath = yield* fs
			.realPath(root)
			.pipe(
				Effect.mapError((error) =>
					usageError(`Could not resolve project root ${root}: ${error.message}`),
				),
			)
		const keyOf = (file: string) => {
			const relative = projectRelative(path, root, file)
			return relative === undefined ? undefined : `./${relative}`
		}

		const checkPath = Effect.fnUntraced(function* (file: string) {
			let ancestor = file
			for (;;) {
				const relative = projectRelative(path, root, ancestor)
				if (relative === undefined) {
					return yield* usageError(`${file}: resource paths must be inside the project.`)
				}
				const resolved = yield* fs
					.realPath(ancestor)
					.pipe(
						Effect.catch((error) =>
							error.reason._tag === "NotFound"
								? Effect.undefined
								: Effect.fail(usageError(`Could not resolve ${ancestor}: ${error.message}`)),
						),
					)
				if (resolved !== undefined) {
					if (resolved !== path.resolve(rootPath, relative)) {
						return yield* usageError(
							`${file}: resource paths must stay inside the project without passing through a symbolic link.`,
						)
					}
					return
				}
				if (ancestor === root || (yield* fileType(ancestor)) === "SymbolicLink") {
					return yield* usageError(
						`${file}: could not resolve the resource path inside the project.`,
					)
				}
				ancestor = path.dirname(ancestor)
			}
		})
		const checkBoundary = Effect.fnUntraced(function* (file: string, directory: boolean) {
			let parent = directory ? file : path.dirname(file)
			while (parent !== root) {
				const boundary = path.join(parent, projectLockfileName)
				if ((yield* fileType(boundary)) !== undefined) {
					return yield* usageError(
						`${file}: this path belongs to a nested project. Run apply there or use --lock-file ${JSON.stringify(boundary)}.`,
					)
				}
				parent = path.dirname(parent)
			}
		})

		const load = Effect.fnUntraced(function* (
			file: string,
			selection: SourceSelection,
			referencedKind?: ResourceKind,
		): Effect.fn.Return<void, ReturnType<typeof usageError>, FileSystem.FileSystem | Path.Path> {
			const key = keyOf(file)
			if (key === undefined || file === lockFile) {
				return yield* usageError(
					`${file}: resource files must be inside the project and separate from its lockfile.`,
				)
			}
			const recordedKind = tracked.get(key)
			if (
				recordedKind !== undefined &&
				referencedKind !== undefined &&
				recordedKind !== referencedKind
			) {
				return yield* usageError(
					`${key}: expected a ${referencedKind} file, tracked as ${recordedKind}.`,
				)
			}
			const expected = recordedKind ?? referencedKind
			const prior = resources.get(key)
			if (prior !== undefined) {
				if (expected !== undefined && prior.definition.kind !== expected) {
					return yield* usageError(
						`${key}: expected a ${expected} file, found ${prior.definition.kind}.`,
					)
				}
				return
			}
			yield* checkPath(file)
			yield* checkBoundary(file, false)
			const source = yield* readSource(file, key, selection, expected)
			if (source === undefined) {
				return
			}
			const body = Object.fromEntries(Object.entries(source.body))
			const references: Array<Reference> = []
			for (const reference of yield* referencesFor(source)) {
				const target = path.resolve(path.dirname(file), reference.target)
				const targetKey = keyOf(target)
				yield* checkPath(target)
				if (targetKey === undefined || (yield* fileType(target)) !== "File") {
					return yield* usageError(
						`${key}: ${reference.field} must reference an existing ${reference.kind} file inside the project (${reference.target}).`,
					)
				}
				yield* load(target, "explicit", reference.kind)
				references.push({ ...reference, target: targetKey })
				const placeholder = reference.kind === "agent" ? "agent_pending" : "env_pending"
				if (reference.object === undefined) {
					body[reference.field] = placeholder
				} else {
					const { path: _sourcePath, ...fields } = reference.object
					body[reference.field] = { ...fields, type: "agent", id: placeholder }
				}
			}
			const definition = yield* decodeDefinition(source.kind, body, key)
			resources.set(key, { key, definition, document: source.body, references })
		})

		const selected = new Map<string, boolean>()
		const scopes: Array<string> = []
		for (const input of paths) {
			const file = path.resolve(input)
			const key = keyOf(file)
			yield* checkPath(file)
			const type = yield* fileType(file)
			if (type === "Directory") {
				yield* checkBoundary(file, true)
				scopes.push(file)
				for (const child of yield* Effect.gen(() => discover(file, lockFile))) {
					if (!selected.has(child)) {
						selected.set(child, false)
					}
				}
			} else if (type === "File" || (type === undefined && key !== undefined && tracked.has(key))) {
				selected.set(file, true)
			} else if (
				type === undefined &&
				prune &&
				key !== undefined &&
				Array.from(tracked.keys()).some((trackedKey) => trackedKey.startsWith(`${key}/`))
			) {
				yield* checkBoundary(file, true)
				scopes.push(file)
			} else {
				return yield* usageError(`${file}: expected an existing resource file or directory.`)
			}
		}
		for (const key of tracked.keys()) {
			const file = path.resolve(root, key)
			if (
				paths.length === 0 ||
				selected.has(file) ||
				scopes.some((scope) => projectRelative(path, scope, file) !== undefined)
			) {
				selected.set(file, true)
			}
		}
		const deferred: Array<string> = []
		for (const [file, named] of selected) {
			const key = keyOf(file)
			yield* checkPath(file)
			const type = yield* fileType(file)
			if (type === "File") {
				const mayDefer = named && key !== undefined && tracked.get(key) === undefined
				yield* load(file, mayDefer ? "defer-untyped" : named ? "explicit" : "discovered")
				if (mayDefer && !resources.has(key)) {
					deferred.push(file)
				}
			} else if (type === undefined && key !== undefined && tracked.has(key)) {
				yield* checkBoundary(file, false)
				missing.add(key)
			} else {
				return yield* usageError(`${file}: expected a regular resource file.`)
			}
		}
		// An automation can supply the kind of an otherwise untyped input.
		for (const file of deferred) {
			yield* load(file, "explicit")
		}
		return { resources: Array.from(resources.values()), missing }
	})
