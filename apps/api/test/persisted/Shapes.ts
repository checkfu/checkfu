import { RUN_TURN_ACTIVITIES } from "@checkfu/sessions/Session/RunTurn.saga"
import { copyJson } from "@earendil-works/chord/json"
import type { JsonObject } from "@earendil-works/pi-durable"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { Checkfu } from "../../src/Checkfu.model.ts"
import { CHECKFU_PI_DOCS, type CheckfuPiDocSpec } from "../../src/Pi/PiDocRegistry.ts"

export type PersistedSchema = Schema.Codec<unknown, unknown, never, never>

export type PersistedKind =
	| "event"
	| "state"
	| "view"
	| "policy-delivery"
	| "scheduled-command"
	| "command-reply"
	| "saga-input"
	| "saga-step"
	| "saga-result"
	| "pi-doc"

export const RULES: Readonly<Record<PersistedKind, string>> = {
	event:
		"Events are permanent. Add a field only with a decoding default; for any other change, record a new event type and keep this one readable.",
	state:
		"Aggregate state is permanent. Keep the old shape as a migration step (see `versionedSnapshot`) instead of changing the schema in place.",
	view: "View rows are rebuilt from events. Bump the view's `version` when its state changes.",
	"policy-delivery":
		"Queued policy deliveries carry the source view state captured before deploy. Keep the source view state readable by the new schema while deliveries can still be in flight, even when the view's version is bumped.",
	"scheduled-command":
		"An armed deadline holds its encoded command until delivery. Keep its tag and input readable while deadlines can still fire.",
	"command-reply":
		"Retrying a command ID returns its stored receipt. Keep the reply readable for retries, including receipts written before the command declared a reply.",
	"saga-input":
		"A run in flight during a deploy still holds the old input. Add a field only with a decoding default, or give the saga a new name.",
	"saga-step":
		"A run in flight during a deploy may replay this recorded step result. Add a field only with a decoding default, or give the saga a new name.",
	"saga-result":
		"A completed run keeps its result. Add a field only with a decoding default, or give the saga a new name.",
	"pi-doc":
		"Pi durable documents survive deployments and are read when resuming or replaying turns. Keep the document's scope and family fixed, and bump its `version` with a `migrate` handler whenever its fields change.",
}

export interface PersistedShape {
	readonly id: string
	readonly kind: PersistedKind
	readonly schema: PersistedSchema
}

interface TaggedSchema extends PersistedSchema {
	readonly tag: string
}
interface CommandClass extends TaggedSchema {
	readonly reply: PersistedSchema | undefined
}
interface AggregateClass {
	readonly aggregateName: string
	readonly definition: {
		readonly state: PersistedSchema
		readonly events: ReadonlyArray<TaggedSchema>
		readonly commands: ReadonlyArray<CommandClass>
	}
}
interface ViewClass {
	readonly viewName: string
	readonly definition: { readonly version?: number; readonly state: PersistedSchema }
}
interface PolicySource {
	readonly kind?: string
	readonly viewName?: string
	readonly definition?: { readonly state?: PersistedSchema }
}
interface PolicyClass {
	readonly policyName: string
	readonly definition: {
		readonly from: PolicySource | ReadonlyArray<PolicySource>
	}
}
interface SagaClass {
	readonly sagaName: string
	readonly workflow: {
		readonly payloadSchema: PersistedSchema
		readonly successSchema: PersistedSchema
	}
}
interface ModelClass {
	readonly modelName: string
	readonly aggregates: ReadonlyArray<AggregateClass>
	readonly decisions?: ReadonlyArray<{ readonly command: CommandClass }>
	readonly views?: ReadonlyArray<ViewClass>
	readonly definitions?: { readonly policies?: ReadonlyArray<PolicyClass> }
	readonly sagas?: ReadonlyArray<SagaClass>
}

// Only commands submitted with aggregate.schedule are persisted for later delivery.
const SCHEDULED_COMMANDS = new Set(["Checkfu.Session/AbandonTurn"])

const commandReply = (model: string, command: CommandClass): PersistedShape => ({
	id: `command-reply:${model}/${command.tag}`,
	kind: "command-reply",
	// Both aggregate and decision receipts store null when the command declares no reply.
	schema: command.reply ?? Schema.Null,
})

const shapesOfModel = (model: ModelClass): ReadonlyArray<PersistedShape> => {
	const shapes: Array<PersistedShape> = []
	for (const aggregate of model.aggregates) {
		const owner = `${model.modelName}.${aggregate.aggregateName}`
		shapes.push({ id: `state:${owner}`, kind: "state", schema: aggregate.definition.state })
		for (const event of aggregate.definition.events) {
			shapes.push({
				id: `event:${owner}/${event.tag}`,
				kind: "event",
				schema: event,
			})
		}
		for (const command of aggregate.definition.commands) {
			shapes.push(commandReply(model.modelName, command))
			const name = `${owner}/${command.tag}`
			if (SCHEDULED_COMMANDS.has(name)) {
				shapes.push({ id: `scheduled-command:${name}`, kind: "scheduled-command", schema: command })
			}
		}
	}
	for (const decision of model.decisions ?? []) {
		shapes.push(commandReply(model.modelName, decision.command))
	}
	for (const view of model.views ?? []) {
		shapes.push({
			id: viewShapeId(model.modelName, view.viewName, view.definition.version ?? 0),
			kind: "view",
			schema: view.definition.state,
		})
	}
	for (const policy of model.definitions?.policies ?? []) {
		const sources = Array.isArray(policy.definition.from)
			? policy.definition.from
			: [policy.definition.from]
		for (const source of sources) {
			if (
				source.kind === "View" &&
				source.viewName !== undefined &&
				source.definition?.state !== undefined
			) {
				shapes.push({
					id: policyDeliveryShapeId(model.modelName, policy.policyName, source.viewName),
					kind: "policy-delivery",
					schema: source.definition.state,
				})
			}
		}
	}
	for (const saga of model.sagas ?? []) {
		shapes.push({
			id: `saga-input:${model.modelName}.${saga.sagaName}`,
			kind: "saga-input",
			schema: saga.workflow.payloadSchema,
		})
		shapes.push({
			id: `saga-result:${model.modelName}.${saga.sagaName}`,
			kind: "saga-result",
			schema: saga.workflow.successSchema,
		})
	}
	return shapes
}

export const viewShapeId = (model: string, view: string, version: number): string =>
	`view:${model}.${view}@v${version}`

export const policyDeliveryShapeId = (model: string, policy: string, view: string): string =>
	`policy-delivery:${model}.${policy}/${view}`

export const parseViewShapeId = (
	id: string,
): { readonly name: string; readonly version: number } | null => {
	const match = /^(view:.+)@v(\d+)$/.exec(id)
	return match?.[1] === undefined || match[2] === undefined
		? null
		: { name: match[1], version: Number(match[2]) }
}

export const piDocShapeId = (kind: string): string => `pi-doc:${kind}`

const validatePiDocRuntimeValue = (
	kind: string,
	version: number,
	validator: (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>,
	rawValue: unknown,
): Effect.Effect<Readonly<Record<string, Schema.Json>>, SchemaIssue.Issue> =>
	Effect.try({
		try: (): Readonly<Record<string, Schema.Json>> => {
			const copied = copyJson(rawValue)
			if (copied === null || typeof copied !== "object" || Array.isArray(copied)) {
				throw new TypeError(`Pi doc "${kind}" v${version} value must be a JSON object`)
			}
			return copied as Readonly<Record<string, Schema.Json>>
		},
		catch: (cause) =>
			new SchemaIssue.InvalidValue(
				{
					message: `Pi doc "${kind}" v${version} is not strict JSON: ${
						cause instanceof Error ? cause.message : String(cause)
					}`,
				},
				rawValue,
			),
	}).pipe(
		Effect.flatMap((copied) =>
			validator(copied).pipe(
				Effect.mapError((error) => error.issue),
				Effect.as(copied),
			),
		),
	)

/**
 * Encodes a Checkfu-owned Pi durable document's on-disk metadata (`version`,
 * `scope`, `family`) together with its value schema. When previous versions are
 * declared, decoding runs the token's `migrate(value, fromVersion)` handler and
 * validates the migrated value against the current runtime schema.
 */
export const piDocPersistedSchema = (spec: CheckfuPiDocSpec): PersistedSchema => {
	const def = spec.token.definition
	const family = def.family === true
	if (def.scope === "conversation" && (def.history === undefined || def.fork === undefined)) {
		throw new Error(
			`Conversation-scoped Pi doc "${def.kind}" must declare both history and fork semantics`,
		)
	}
	const conversationSemantics =
		def.scope === "conversation"
			? {
					history: def.history!,
					fork: def.fork!,
				}
			: null
	const makeWireEnvelope = (version: number, valueDoc: unknown) => {
		const value = Schema.Record(Schema.String, Schema.Json).annotate({
			description: JSON.stringify(valueDoc),
		})
		return conversationSemantics !== null
			? Schema.Struct({
					version: Schema.Literal(version),
					scope: Schema.Literal("conversation" as const),
					history: Schema.Literal(conversationSemantics.history),
					fork: Schema.Literal(conversationSemantics.fork),
					family: Schema.Literal(family),
					value,
				})
			: Schema.Struct({
					version: Schema.Literal(version),
					scope: Schema.Literal(def.scope),
					family: Schema.Literal(family),
					value,
				})
	}
	const previous = [...(spec.previous ?? [])].sort((a, b) => a.version - b.version)
	for (let i = 0; i < previous.length; i++) {
		const step = previous[i]
		if (step === undefined) continue
		if (step.version >= def.version) {
			throw new Error(
				`Pi doc "${def.kind}" previous version ${step.version} must be less than current version ${def.version}`,
			)
		}
		if (previous[i - 1]?.version === step.version) {
			throw new Error(`Pi doc "${def.kind}" has duplicate previous version ${step.version}`)
		}
	}
	if (previous.length > 0 && typeof def.migrate !== "function") {
		throw new Error(
			`Pi doc "${def.kind}" declares previous versions but defines no migrate() handler`,
		)
	}

	// Pi's `materializeDocumentValue` hands runtime callers the stored JSON (or a
	// strict-JSON copy of `migrate(...)`) without running an Effect codec. Validate
	// both current and previous versions directly against `Schema.toType(...)` after
	// `copyJson(...)` so decoding defaults, wire transforms, and JSON-codec coercions
	// (such as `"NaN"` -> `NaN` for `Schema.Number`) can never mask a runtime mismatch.
	const runtimeSchema = Schema.toType(spec.schema)
	const runtimeCodecJson = Schema.toCodecJson(runtimeSchema)
	const validateCurrent = Schema.decodeUnknownEffect(runtimeSchema)

	const currentWireEnvelope = makeWireEnvelope(
		def.version,
		Schema.toJsonSchemaDocument(runtimeCodecJson),
	)

	// Previous wire branches accept the raw stored JSON object without stripping
	// undeclared properties, running field transforms, or applying decoding
	// defaults, while still folding each previous runtime schema into the
	// JSON-Schema fingerprint and validating the old runtime shape before migrate().
	const previousBranches = previous.map((step) => {
		const stepRuntime = Schema.toType(step.schema)
		return {
			version: step.version,
			validator: Schema.decodeUnknownEffect(stepRuntime),
			envelope: makeWireEnvelope(
				step.version,
				Schema.toJsonSchemaDocument(Schema.toCodecJson(stepRuntime)),
			),
		}
	})

	const wireSchema = (previousBranches.length === 0
		? currentWireEnvelope
		: Schema.Union([
				...previousBranches.map((branch) => branch.envelope),
				currentWireEnvelope,
			])) as unknown as Schema.Codec<
		| {
				readonly version: number
				readonly scope: "conversation"
				readonly history: "latest" | "rewindable"
				readonly fork: "asOf" | "current" | "initial"
				readonly family: boolean
				readonly value: Readonly<Record<string, Schema.Json>>
		  }
		| {
				readonly version: number
				readonly scope: "session" | "conversation" | "task"
				readonly family: boolean
				readonly value: Readonly<Record<string, Schema.Json>>
		  }
	>

	const stepValidators = new Map(
		previousBranches.map((branch) => [branch.version, branch.validator]),
	)

	const migrate = def.migrate
	return wireSchema.pipe(
		Schema.decodeTo(
			runtimeCodecJson,
			SchemaTransformation.transformEffect({
				decode: (rawEnvelope) => {
					const envelope = rawEnvelope as {
						readonly version: number
						readonly value: JsonObject
					}
					if (envelope.version === def.version) {
						return validatePiDocRuntimeValue(def.kind, def.version, validateCurrent, envelope.value)
					}
					const validateOld = stepValidators.get(envelope.version)
					if (validateOld === undefined || migrate === undefined) {
						return Effect.fail(
							new SchemaIssue.InvalidValue(
								{
									message: `Unsupported previous version ${envelope.version} for Pi doc "${def.kind}"`,
								},
								envelope.version,
							),
						)
					}
					return validatePiDocRuntimeValue(
						def.kind,
						envelope.version,
						validateOld,
						envelope.value,
					).pipe(
						Effect.flatMap((rawJson) =>
							Effect.try({
								try: (): unknown => migrate(rawJson as JsonObject, envelope.version),
								catch: (cause) =>
									new SchemaIssue.InvalidValue(
										{
											message: `Pi doc "${def.kind}" migrate(v${envelope.version}) threw: ${
												cause instanceof Error ? cause.message : String(cause)
											}`,
										},
										rawJson,
									),
							}),
						),
						Effect.flatMap((migrated) =>
							validatePiDocRuntimeValue(def.kind, def.version, validateCurrent, migrated),
						),
					)
				},
				encode: (value: Schema.Json) =>
					validatePiDocRuntimeValue(def.kind, def.version, validateCurrent, value).pipe(
						Effect.map((copied) =>
							conversationSemantics !== null
								? {
										version: def.version,
										scope: "conversation" as const,
										history: conversationSemantics.history,
										fork: conversationSemantics.fork,
										family,
										value: copied,
									}
								: {
										version: def.version,
										scope: def.scope,
										family,
										value: copied,
									},
						),
					),
			}),
		),
	) as unknown as PersistedSchema
}

const SAGA_STEPS: ReadonlyArray<PersistedShape> = Object.values(RUN_TURN_ACTIVITIES).map(
	(activity): PersistedShape => ({
		id: `saga-step:Checkfu.RunTurn/${activity.name}`,
		kind: "saga-step",
		schema: activity.success as unknown as PersistedSchema,
	}),
)

const PI_DOCS: ReadonlyArray<PersistedShape> = CHECKFU_PI_DOCS.map((spec): PersistedShape => ({
	id: piDocShapeId(spec.token.definition.kind),
	kind: "pi-doc",
	schema: piDocPersistedSchema(spec),
}))

export const persistedShapes: ReadonlyArray<PersistedShape> = [
	...shapesOfModel(Checkfu as unknown as ModelClass),
	...SAGA_STEPS,
	...PI_DOCS,
]

export const registryProblems = (
	shapes: ReadonlyArray<PersistedShape> = persistedShapes,
): ReadonlyArray<string> => {
	const problems: Array<string> = []
	const seen = new Set<string>()
	for (const shape of shapes) {
		if (seen.has(shape.id)) problems.push(`${shape.id} is listed twice`)
		seen.add(shape.id)
		if (shape.id.includes("undefined")) problems.push(`${shape.id} has an unnamed part`)
		if (!Schema.isSchema(shape.schema)) problems.push(`${shape.id} is not a Schema`)
	}
	for (const kind of [
		"event",
		"state",
		"view",
		"policy-delivery",
		"scheduled-command",
		"command-reply",
		"saga-input",
		"saga-step",
		"saga-result",
		"pi-doc",
	] as const) {
		if (!shapes.some((shape) => shape.kind === kind)) {
			problems.push(`no ${kind} shape was found`)
		}
	}
	return problems
}
