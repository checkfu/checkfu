import * as Cloudflare from "@alchemy.run/cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { placedStub, placement } from "../Placement.ts"
import { ArtifactDatabase, ArtifactDatabaseError } from "./ArtifactDatabase.ts"
import { makeArtifactDocuments } from "./ArtifactDocuments.ts"
import type {
	ArtifactDocuments,
	DatabaseUsage,
	DocumentPage,
	StoredDocument,
	WriteMode,
	WriteOutcome,
} from "./ArtifactDocuments.ts"

interface ArtifactDataShape {
	readonly get: (collection: string, id: string) => Effect.Effect<StoredDocument | null>
	readonly list: (collection: string, after: number, limit: number) => Effect.Effect<DocumentPage>
	readonly write: (
		collection: string,
		id: string,
		body: string,
		mode: WriteMode,
		now: number,
		createHash: string | null,
	) => Effect.Effect<WriteOutcome>
	readonly remove: (collection: string, id: string) => Effect.Effect<boolean>
	readonly usage: () => Effect.Effect<DatabaseUsage>
	readonly erase: () => Effect.Effect<void>
}

export class ArtifactDataObjects extends Cloudflare.DurableObject<
	ArtifactDataObjects,
	ArtifactDataShape
>()("ArtifactDataObjects") {}

export const ArtifactDataObjectsLive = ArtifactDataObjects.make(
	Effect.map(Cloudflare.DurableObjectState, (state) => {
		const { storage } = state.raw
		let made: ArtifactDocuments | undefined
		const documents = () =>
			(made ??= makeArtifactDocuments({
				exec: (query, ...bindings) => storage.sql.exec(query, ...bindings),
				transaction: (run) => storage.transactionSync(run),
			}))
		return Effect.succeed<ArtifactDataShape>({
			get: (collection, id) => Effect.sync(() => documents().get(collection, id)),
			list: (collection, after, limit) =>
				Effect.sync(() => documents().list(collection, after, limit)),
			write: (collection, id, body, mode, now, createHash) =>
				Effect.sync(() => documents().write(collection, id, body, mode, now, createHash)),
			remove: (collection, id) => Effect.sync(() => documents().remove(collection, id)),
			usage: () => Effect.sync(() => documents().usage()),
			erase: () => Effect.sync(() => documents().erase()),
		})
	}),
)

export const ArtifactDatabaseDurable = Layer.effect(
	ArtifactDatabase,
	Effect.gen(function* () {
		const objects = placedStub(yield* ArtifactDataObjects, yield* placement)
		const runtime = yield* Cloudflare.Worker
		const call = <A, E>(effect: () => Effect.Effect<A, E, RuntimeContext>) =>
			Effect.suspend(effect).pipe(
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.fail(new ArtifactDatabaseError({ cause: Cause.squash(cause) })),
				),
				Effect.provideService(RuntimeContext, runtime),
			)
		return {
			get: (artifactId, collection, id) => call(() => objects(artifactId).get(collection, id)),
			list: (artifactId, collection, after, limit) =>
				call(() => objects(artifactId).list(collection, after, limit)),
			write: (artifactId, collection, id, body, mode, createHash) =>
				Effect.flatMap(Clock.currentTimeMillis, (now) =>
					call(() =>
						objects(artifactId).write(collection, id, body, mode, now, createHash ?? null),
					),
				),
			remove: (artifactId, collection, id) =>
				call(() => objects(artifactId).remove(collection, id)),
			usage: (artifactId) => call(() => objects(artifactId).usage()),
			erase: (artifactId) => call(() => objects(artifactId).erase()),
		}
	}),
)
