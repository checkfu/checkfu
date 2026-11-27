import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

export type ServiceFreeSchema = Schema.Top & {
	readonly DecodingServices: never
	readonly EncodingServices: never
}

export const versionedSnapshot = <State, EncodedState>({
	current,
	schema,
}: {
	readonly current: number
	readonly schema: Schema.Codec<State, EncodedState>
}): Schema.Codec<
	State,
	{ readonly schema_version: number; readonly state: unknown },
	never,
	never
> =>
	Schema.Struct({ schema_version: Schema.Literal(current), state: schema }).pipe(
		Schema.decodeTo(
			Schema.toType(schema),
			SchemaTransformation.transform({
				decode: (envelope) => envelope.state,
				encode: (state) => ({ schema_version: current, state }),
			}),
		),
	)
