import { RUN_TURN_ACTIVITIES } from "@checkfu/domain/Session/RunTurn.saga"
import { copyJson } from "@earendil-works/chord/json"
import type { JsonObject } from "@earendil-works/pi-durable"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { Checkfu } from "@checkfu/domain/Checkfu.model"
import { Webhooks } from "@checkfu/domain/Webhooks.model"
import { ApiCalls } from "../../src/Api.ts"
import { DOCUMENT_TABLES } from "../../src/ArtifactData/ArtifactDocuments.ts"
import { CUSTODY_TABLES } from "../../src/Connection/SecretCustody.ts"
import { ArtifactManifest } from "../../src/Artifacts/ArtifactFiles.ts"
import { ArtifactMarks } from "../../src/Artifacts/ArtifactOwnership.ts"
import { OwnerMarks } from "../../src/Files/ByteOwner.ts"
import { ArtifactLinkClaims } from "../../src/Content/ArtifactLink.ts"
import { Vaults } from "@checkfu/domain/Vaults.model"
import { CHECKFU_PI_DOCS } from "../../src/Pi/PiDocRegistry.ts"
import type { CheckfuPiDocSpec } from "../../src/Pi/PiDocRegistry.ts"
import { PiHarnessCalls } from "../../src/Pi/PiTurn.ts"
import { CANCELLED_OPS_TABLE } from "../../src/Pi/TurnFence.ts"
import { WEBHOOK_FANOUT_PAYLOADS } from "../../src/Webhooks/FanoutPayloads.ts"
import {
	WEBHOOK_DELIVERIES_TABLE,
	WEBHOOK_HEALTH_OUTCOMES_TABLE,
} from "../../src/Webhooks/WebhookDeliveryEngine.ts"
import { TURN_CALLS_TABLE } from "../../src/Pi/PiTurnCalls.ts"

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
	| "harness-call"
	| "session-table"
	| "webhook-table"
	| "webhook-callback"
	| "vault-table"
	| "artifact-data-table"
	| "artifact-object"
	| "artifact-marks"
	| "signed-link"
	| "api-call"

export const RULES: Readonly<Record<PersistedKind, string>> = {
	event:
		"Events are permanent. Add a field only with a decoding default; for any other change, record a new event type and keep this one readable.",
	state: "Aggregate snapshots require the declared version and a state that passes validation.",
	view: "View rows are rebuilt from events. Bump the view's `version` when its state changes.",
	"policy-delivery":
		"Queued policy deliveries are routed by the policy's name and carry the source's event or view state captured before deploy. Keep the policy's name and source while deliveries can still be in flight, and keep a source view's state readable by the new schema even when the view's version is bumped.",
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
	"session-table":
		"The table already exists in every session object, and `CREATE TABLE IF NOT EXISTS` leaves an existing table as it is. Add a column with a separate `ALTER TABLE` step, or use a new table.",
	"webhook-table":
		"The table already exists in every webhook deliverer object, and `CREATE TABLE IF NOT EXISTS` leaves an existing table as it is. Add a column with a separate `ALTER TABLE` step, or use a new table.",
	"webhook-callback":
		"Webhook fan-out callbacks are routed by shard and callback name. Subscriber enqueue retries stop after fourteen days. Cleanup is due twenty-four hours after the scan and retries settle. Unacknowledged alarms can remain scheduled beyond either deadline. Keep names and payloads readable while those jobs can still run.",
	"vault-table":
		"The table already exists in every vault's connection object and holds its secrets, and `CREATE TABLE IF NOT EXISTS` leaves an existing table as it is. Add a column with a separate `ALTER TABLE` step, or use a new table.",
	"artifact-data-table":
		"The table already exists in every artifact's database object and holds its documents, and `CREATE TABLE IF NOT EXISTS` leaves an existing table as it is. Add a column with a separate `ALTER TABLE` step, or use a new table.",
	"artifact-object":
		"Artifact manifests stay in R2 across deploys and are read back by later builds. Add a field only with a decoding default; for any other change, write it under a new key and keep reading the old one.",
	"artifact-marks":
		"Every artifact owner object and file owner object keeps its marks in storage across deploys, and a later build reads them back. Add a field only with a decoding default; for any other change, store it under a new key and keep reading the old one.",
	"signed-link":
		"A viewing link keeps working across deploys until it expires, up to seven days after it was made. Keep the claims of links the last build signed readable until every one of them has expired.",
	"api-call":
		"The content Worker and the API Worker deploy separately, so each side meets the other's previous build. The lock proves only that this build reads the shape the last one sent. That the last build tolerates this one is yours to check: add an argument or field only as optional, and start sending it one release after the reader ships.",
	"harness-call":
		"The API Worker and the harness Worker deploy separately, and a running object can keep its old code for the whole code-update delay, so each side meets the other's previous build. The lock proves only that this build reads the shape the last one sent. That the last build tolerates this one is yours to check: add a field only as optional, and start sending it one release after the reader ships.",
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
	readonly rejects: ReadonlyArray<unknown>
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
	readonly aggregateName?: string
	readonly definition?: { readonly state?: PersistedSchema }
}
interface PolicyClass {
	readonly policyName: string
	readonly definition: {
		readonly from: PolicySource | ReadonlyArray<PolicySource>
		readonly on: ReadonlyArray<PersistedSchema>
	}
}
interface SagaClass {
	readonly sagaName: string
	readonly workflow: {
		readonly payloadSchema: PersistedSchema
		readonly successSchema: PersistedSchema
	}
}
export interface PersistedModelClass {
	readonly modelName: string
	readonly aggregates: ReadonlyArray<AggregateClass>
	readonly decisions?: ReadonlyArray<{ readonly command: CommandClass }>
	readonly views?: ReadonlyArray<ViewClass>
	readonly definitions?: { readonly policies?: ReadonlyArray<PolicyClass> }
	readonly sagas?: ReadonlyArray<SagaClass>
}

const commandReply = (model: string, command: CommandClass): PersistedShape => ({
	id: `command-reply:${model}/${command.tag}`,
	kind: "command-reply",
	schema: command.reply ?? Schema.Null,
})

export const shapesOfModel = (model: PersistedModelClass): ReadonlyArray<PersistedShape> => {
	const shapes: Array<PersistedShape> = []
	const seenEventIds = new Set<string>()
	for (const aggregate of model.aggregates) {
		const owner = `${model.modelName}.${aggregate.aggregateName}`
		shapes.push({ id: `state:${owner}`, kind: "state", schema: aggregate.definition.state })
		for (const event of aggregate.definition.events) {
			const eventId = `event:${owner}/${event.tag}`
			if (seenEventIds.has(eventId)) {
				continue
			}
			seenEventIds.add(eventId)
			shapes.push({
				id: eventId,
				kind: "event",
				schema: event,
			})
		}
		for (const command of aggregate.definition.commands) {
			shapes.push(commandReply(model.modelName, command))
			if (command.rejects.length === 0) {
				shapes.push({
					id: `scheduled-command:${owner}/${command.tag}`,
					kind: "scheduled-command",
					schema: command,
				})
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
		const from = policy.definition.from
		const sources: ReadonlyArray<PolicySource> = Array.isArray(from) ? from : [from]
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
			} else if (source.kind === "Aggregate" && source.aggregateName !== undefined) {
				shapes.push({
					id: policyDeliveryShapeId(model.modelName, policy.policyName, source.aggregateName),
					kind: "policy-delivery",
					schema: Schema.Union(policy.definition.on),
				})
			}
		}
	}
	for (const saga of model.sagas ?? []) {
		shapes.push(
			{
				id: `saga-input:${model.modelName}.${saga.sagaName}`,
				kind: "saga-input",
				schema: saga.workflow.payloadSchema,
			},
			{
				id: `saga-result:${model.modelName}.${saga.sagaName}`,
				kind: "saga-result",
				schema: saga.workflow.successSchema,
			},
		)
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
			return copied
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
	}).pipe(Effect.tap((copied) => validator(copied).pipe(Effect.mapError((error) => error.issue))))

export const piDocPersistedSchema = (spec: CheckfuPiDocSpec): PersistedSchema => {
	const def = spec.token.definition
	const family = def.family === true
	let conversationSemantics: {
		readonly history: "latest" | "rewindable"
		readonly fork: "asOf" | "current" | "initial"
	} | null = null
	if (def.scope === "conversation") {
		if (def.history === undefined || def.fork === undefined) {
			throw new Error(
				`Conversation-scoped Pi doc "${def.kind}" must declare both history and fork semantics`,
			)
		}
		conversationSemantics = { history: def.history, fork: def.fork }
	}
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
		if (step === undefined) {
			continue
		}
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

	const runtimeSchema = Schema.toType(spec.schema)
	const runtimeCodecJson = Schema.toCodecJson(runtimeSchema)
	const validateCurrent = Schema.decodeUnknownEffect(runtimeSchema)

	const currentWireEnvelope = makeWireEnvelope(
		def.version,
		Schema.toJsonSchemaDocument(runtimeCodecJson),
	)

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
								try: () => migrate(rawJson as JsonObject, envelope.version),
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
	)
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

const HARNESS_CALLS: ReadonlyArray<PersistedShape> = Object.entries(PiHarnessCalls).flatMap(
	([method, { args, result }]): ReadonlyArray<PersistedShape> => [
		{ id: `harness-call:PiHarness.${method}/args`, kind: "harness-call", schema: args },
		{ id: `harness-call:PiHarness.${method}/result`, kind: "harness-call", schema: result },
	],
)

const SESSION_TABLES: ReadonlyArray<PersistedShape> = [
	{
		id: "session-table:checkfu_cancelled_ops",
		kind: "session-table",
		schema: Schema.Literal(CANCELLED_OPS_TABLE),
	},
	{
		id: "session-table:checkfu_turn_calls",
		kind: "session-table",
		schema: Schema.Literal(TURN_CALLS_TABLE),
	},
]

const WEBHOOK_TABLES: ReadonlyArray<PersistedShape> = [
	{
		id: "webhook-table:webhook_deliveries",
		kind: "webhook-table",
		schema: Schema.Literal(WEBHOOK_DELIVERIES_TABLE),
	},
	{
		id: "webhook-table:webhook_health_outcomes",
		kind: "webhook-table",
		schema: Schema.Literal(WEBHOOK_HEALTH_OUTCOMES_TABLE),
	},
]

const WEBHOOK_CALLBACKS: ReadonlyArray<PersistedShape> = Object.entries(
	WEBHOOK_FANOUT_PAYLOADS,
).map(([name, schema]): PersistedShape => ({
	id: `webhook-callback:WebhookFanout/${name}`,
	kind: "webhook-callback",
	schema,
}))

const VAULT_TABLES: ReadonlyArray<PersistedShape> = Object.entries(CUSTODY_TABLES).map(
	([name, table]): PersistedShape => ({
		id: `vault-table:${name}`,
		kind: "vault-table",
		schema: Schema.Literal(table),
	}),
)

const ARTIFACT_DATA_TABLES: ReadonlyArray<PersistedShape> = Object.entries(DOCUMENT_TABLES).map(
	([name, table]): PersistedShape => ({
		id: `artifact-data-table:${name}`,
		kind: "artifact-data-table",
		schema: Schema.Literal(table),
	}),
)

const ARTIFACT_OBJECTS: ReadonlyArray<PersistedShape> = [
	{ id: "artifact-object:manifest", kind: "artifact-object", schema: ArtifactManifest },
]

const ARTIFACT_MARKS: ReadonlyArray<PersistedShape> = [
	{ id: "artifact-marks:ArtifactObjects/marks", kind: "artifact-marks", schema: ArtifactMarks },
	{ id: "artifact-marks:FileObjects/marks", kind: "artifact-marks", schema: OwnerMarks },
]

const SIGNED_LINKS: ReadonlyArray<PersistedShape> = [
	{ id: "signed-link:ArtifactLink/claims", kind: "signed-link", schema: ArtifactLinkClaims },
]

const API_CALLS: ReadonlyArray<PersistedShape> = Object.entries(ApiCalls).flatMap(
	([method, call]): ReadonlyArray<PersistedShape> => [
		{ id: `api-call:Api.${method}/args`, kind: "api-call", schema: call.args },
		{ id: `api-call:Api.${method}/result`, kind: "api-call", schema: call.result },
		...("error" in call
			? [{ id: `api-call:Api.${method}/error`, kind: "api-call" as const, schema: call.error }]
			: []),
	],
)

export const persistedShapes: ReadonlyArray<PersistedShape> = [
	...shapesOfModel(Checkfu as unknown as PersistedModelClass),
	...shapesOfModel(Webhooks as unknown as PersistedModelClass),
	...shapesOfModel(Vaults as unknown as PersistedModelClass),
	...SAGA_STEPS,
	...PI_DOCS,
	...HARNESS_CALLS,
	...SESSION_TABLES,
	...WEBHOOK_TABLES,
	...WEBHOOK_CALLBACKS,
	...VAULT_TABLES,
	...ARTIFACT_DATA_TABLES,
	...ARTIFACT_OBJECTS,
	...ARTIFACT_MARKS,
	...SIGNED_LINKS,
	...API_CALLS,
]

export const registryProblems = (
	shapes: ReadonlyArray<PersistedShape> = persistedShapes,
): ReadonlyArray<string> => {
	const problems: Array<string> = []
	const seen = new Set<string>()
	for (const shape of shapes) {
		if (seen.has(shape.id)) {
			problems.push(`${shape.id} is listed twice`)
		}
		seen.add(shape.id)
		if (shape.id.includes("undefined")) {
			problems.push(`${shape.id} has an unnamed part`)
		}
		if (!Schema.isSchema(shape.schema)) {
			problems.push(`${shape.id} is not a Schema`)
		}
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
		"harness-call",
		"session-table",
		"webhook-table",
		"webhook-callback",
		"vault-table",
		"artifact-data-table",
		"artifact-object",
		"artifact-marks",
		"signed-link",
		"api-call",
	] as const) {
		if (!shapes.some((shape) => shape.kind === kind)) {
			problems.push(`no ${kind} shape was found`)
		}
	}
	return problems
}
