import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type {
	DatabaseUsage,
	DocumentPage,
	StoredDocument,
	WriteMode,
	WriteOutcome,
} from "./ArtifactDocuments.ts"

export class ArtifactDatabaseError extends Schema.TaggedError<
	ArtifactDatabaseError,
	{ readonly brand: unique symbol }
>()("ArtifactDatabaseError", { cause: Schema.Unknown }) {}

export interface ArtifactDatabaseService {
	readonly get: (
		artifactId: string,
		collection: string,
		id: string,
	) => Effect.Effect<StoredDocument | null, ArtifactDatabaseError>
	readonly list: (
		artifactId: string,
		collection: string,
		after: number,
		limit: number,
	) => Effect.Effect<DocumentPage, ArtifactDatabaseError>
	readonly write: (
		artifactId: string,
		collection: string,
		id: string,
		body: string,
		mode: WriteMode,
	) => Effect.Effect<WriteOutcome, ArtifactDatabaseError>
	readonly remove: (
		artifactId: string,
		collection: string,
		id: string,
	) => Effect.Effect<boolean, ArtifactDatabaseError>
	readonly usage: (artifactId: string) => Effect.Effect<DatabaseUsage, ArtifactDatabaseError>
	readonly erase: (artifactId: string) => Effect.Effect<void, ArtifactDatabaseError>
}

export class ArtifactDatabase extends Context.Service<ArtifactDatabase, ArtifactDatabaseService>()(
	"@checkfu/api/ArtifactDatabase",
) {}
