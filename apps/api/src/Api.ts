import * as Cloudflare from "@alchemy.run/cloudflare"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SessionArtifactCalls } from "./Workspace/SessionArtifacts.ts"
import { SessionArtifactToolCalls } from "./Workspace/SessionArtifactTool.ts"
import { SessionMemoryCalls } from "./Workspace/SessionMemory.ts"

export class ArtifactVersionNotReady extends Schema.TaggedError<
	ArtifactVersionNotReady,
	{ readonly brand: unique symbol }
>()("ArtifactVersionNotReady", { artifactId: Schema.String, version: Schema.Int }) {}

export const ResolvedPublication = Schema.Struct({
	artifact_id: Schema.String,
	manifest: Schema.String,
})
export type ResolvedPublication = typeof ResolvedPublication.Type

export const DataAddress = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("link"), token: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("publication"), address: Schema.String }),
])
export type DataAddress = typeof DataAddress.Type

export const DataCall = Schema.Struct({
	operation: Schema.Literals(["list", "get", "add", "put", "delete"]),
	collection: Schema.String,
	id: Schema.String,
	body: Schema.String,
	page: Schema.String,
	limit: Schema.String,
	idempotency_key: Schema.String,
	caller: Schema.String,
})
export type DataCall = typeof DataCall.Type

export const DataReply = Schema.Struct({ status: Schema.Int, body: Schema.String })
export type DataReply = typeof DataReply.Type

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
	artifactData: {
		args: Schema.Tuple([DataAddress, DataCall]),
		result: DataReply,
		error: ArtifactVersionNotReady,
	},
	...SessionMemoryCalls,
	...SessionArtifactCalls,
	...SessionArtifactToolCalls,
} as const

type Calls = typeof ApiCalls

type ErrorOf<Call> = Call extends { readonly error: { readonly Type: infer Failure } }
	? Failure
	: never

export type ApiShape = {
	readonly [Method in keyof Calls]: (
		...args: Calls[Method]["args"]["Type"]
	) => Effect.Effect<Calls[Method]["result"]["Type"], ErrorOf<Calls[Method]>>
}

export class ApiWorker extends Cloudflare.Worker<ApiWorker, ApiShape>()("ApiWorker") {}
