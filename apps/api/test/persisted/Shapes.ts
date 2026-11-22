import { Agents } from "@checkfu/agents/Agents.model"
import { Environments } from "@checkfu/environments/Environments.model"
import { RUN_TURN_ACTIVITIES } from "@checkfu/sessions/Session/RunTurn.saga"
import { Sessions } from "@checkfu/sessions/Sessions.model"
import * as Schema from "effect/Schema"

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
const SCHEDULED_COMMANDS = new Set(["Sessions.Session/AbandonTurn"])

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

const SAGA_STEPS: ReadonlyArray<PersistedShape> = Object.values(RUN_TURN_ACTIVITIES).map(
	(activity): PersistedShape => ({
		id: `saga-step:Sessions.RunTurn/${activity.name}`,
		kind: "saga-step",
		schema: activity.success as unknown as PersistedSchema,
	}),
)

export const persistedShapes: ReadonlyArray<PersistedShape> = [
	...[Agents, Environments, Sessions].flatMap((model) =>
		shapesOfModel(model as unknown as ModelClass),
	),
	...SAGA_STEPS,
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
	] as const) {
		if (!shapes.some((shape) => shape.kind === kind)) {
			problems.push(`no ${kind} shape was found`)
		}
	}
	return problems
}
