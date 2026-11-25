import * as Cloudflare from "@alchemy.run/cloudflare"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export class ArtifactVersionNotReady extends Schema.TaggedError<
	ArtifactVersionNotReady,
	{ readonly brand: unique symbol }
>()("ArtifactVersionNotReady", { artifactId: Schema.String, version: Schema.Int }) {}

export const ResolvedPublication = Schema.Struct({
	artifact_id: Schema.String,
	manifest: Schema.String,
})
export type ResolvedPublication = typeof ResolvedPublication.Type

export const ApiCalls = {
	resolveArtifactVersion: {
		args: Schema.Tuple([Schema.String, Schema.Int]),
		result: Schema.NullOr(Schema.String),
		error: ArtifactVersionNotReady,
	},
	resolvePublication: {
		args: Schema.Tuple([Schema.String]),
		result: Schema.NullOr(ResolvedPublication),
		error: ArtifactVersionNotReady,
	},
} as const

type Calls = typeof ApiCalls

export type ApiShape = {
	readonly [Method in keyof Calls]: (
		...args: Calls[Method]["args"]["Type"]
	) => Effect.Effect<Calls[Method]["result"]["Type"], Calls[Method]["error"]["Type"]>
}

export class ApiWorker extends Cloudflare.Worker<ApiWorker, ApiShape>()("ApiWorker") {}
