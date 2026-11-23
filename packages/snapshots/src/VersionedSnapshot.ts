import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

export type ServiceFreeSchema = Schema.Top & {
	readonly DecodingServices: never
	readonly EncodingServices: never
}

export interface SnapshotMigrationStep {
	readonly version: number
	readonly schema: ServiceFreeSchema
	readonly migrate: (state: unknown) => unknown
}

export const snapshotVersion = <V extends number, S extends ServiceFreeSchema>(step: {
	readonly version: V
	readonly schema: S
	readonly migrate: (state: S["Type"]) => unknown
}): SnapshotMigrationStep => ({
	version: step.version,
	schema: step.schema,
	migrate: (state) => step.migrate(state),
})

/**
 * Wraps an aggregate state schema in a `{ schema_version, state }` wire envelope.
 *
 * Upgrades are lazy and bounded per snapshot (independent of event-history length):
 * older envelopes convert step-by-step on decode before `decide`, unknown future
 * versions fail decoding without overwriting storage, and commits always encode at
 * `current`. All migration step schemas must be service-free so decoding never
 * hides undeclared Effect service requirements.
 */
export const versionedSnapshot = <Current extends number, S extends ServiceFreeSchema>(options: {
	readonly current: Current
	readonly schema: S
	readonly previous?: ReadonlyArray<SnapshotMigrationStep>
}): Schema.Codec<
	S["Type"],
	{ readonly schema_version: number; readonly state: unknown },
	never,
	never
> => {
	const sorted = [...(options.previous ?? [])].sort((a, b) => a.version - b.version)
	for (let i = 0; i < sorted.length; i++) {
		const step = sorted[i]
		if (step === undefined) {
			continue
		}
		if (step.version >= options.current) {
			throw new Error(
				`Previous snapshot version ${step.version} must be less than current version ${options.current}`,
			)
		}
		const prev = sorted[i - 1]
		if (prev !== undefined && prev.version === step.version) {
			throw new Error(`Duplicate snapshot version ${step.version}`)
		}
	}

	const currentEnvelope = Schema.Struct({
		schema_version: Schema.Literal(options.current),
		state: options.schema,
	})

	const wireSchema =
		sorted.length === 0
			? currentEnvelope
			: Schema.Union([
					...sorted.map((step) =>
						Schema.Struct({
							schema_version: Schema.Literal(step.version),
							state: step.schema,
						}),
					),
					currentEnvelope,
				])

	return wireSchema.pipe(
		Schema.decodeTo(
			Schema.toType(options.schema),
			SchemaTransformation.transform({
				decode: (rawEnvelope) => {
					const envelope = rawEnvelope as {
						readonly schema_version: number
						readonly state: unknown
					}
					if (envelope.schema_version === options.current) {
						return envelope.state
					}
					let currentState: unknown = envelope.state
					let started = false
					for (const step of sorted) {
						if (step.version === envelope.schema_version) {
							started = true
						}
						if (started) {
							currentState = step.migrate(currentState)
						}
					}
					return currentState
				},
				encode: (state) => ({
					schema_version: options.current,
					state,
				}),
			}),
		),
	) as unknown as Schema.Codec<
		S["Type"],
		{ readonly schema_version: number; readonly state: unknown },
		never,
		never
	>
}
